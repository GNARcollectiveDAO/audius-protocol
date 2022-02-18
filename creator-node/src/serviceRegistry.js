const AudiusLibs = require('@audius/libs')
const redisClient = require('./redis')
const { ipfs, ipfsLatest } = require('./ipfsClient')
const BlacklistManager = require('./blacklistManager')
const { SnapbackSM } = require('./snapbackSM/snapbackSM')
const config = require('./config')
const URSMRegistrationManager = require('./services/URSMRegistrationManager')
const { logger } = require('./logging')
const utils = require('./utils')

const MonitoringQueue = require('./monitors/MonitoringQueue')
const SyncQueue = require('./services/sync/syncQueue')
const SkippedCIDsRetryQueue = require('./services/sync/skippedCIDsRetryService')
const SessionExpirationQueue = require('./services/SessionExpirationQueue')
const AsyncProcessingQueue = require('./AsyncProcessingQueue')

/**
 * `ServiceRegistry` is a container responsible for exposing various
 * services for use throughout CreatorNode.
 *
 * Services:
 *  - `nodeConfig`: exposes config object
 *  - `redis`: Redis Client
 *  - `ipfs`: IPFS Client
 *  - `ipfsLatest`: IPFS Client, latest version
 *  - `blackListManager`: responsible for handling blacklisted content
 *  - `monitoringQueue`: recurring job to monitor node state & performance metrics
 *  - `sessionExpirationQueue`: recurring job to clear expired session tokens from Redis and DB
 *  - `asyncProcessingQueue`: queue that processes jobs and adds job responses into redis
 *
 *  - `libs`: an instance of Audius Libs
 *  - `snapbackSM`: SnapbackStateMachine is responsible for recurring sync and reconfig operations
 *  - `URSMRegistrationManager`: registers node on L2 URSM contract, no-ops afterward
 *
 * `initServices` must be called prior to consuming services from the registry.
 */
class ServiceRegistry {
  constructor() {
    this.nodeConfig = config
    this.redis = redisClient
    this.ipfs = ipfs
    this.ipfsLatest = ipfsLatest
    this.blacklistManager = BlacklistManager
    this.monitoringQueue = new MonitoringQueue()
    this.sessionExpirationQueue = new SessionExpirationQueue()
    this.asyncProcessingQueue = new AsyncProcessingQueue()

    // below services are initialized separately in below functions `initServices()` and `initServicesThatRequireServer()`
    this.libs = null
    this.snapbackSM = null
    this.URSMRegistrationManager = null
    this.syncQueue = null
    this.skippedCIDsRetryQueue = null

    this.servicesInitialized = false
    this.servicesThatRequireServerInitialized = false
  }

  /**
   * Configure all services
   */
  async initServices() {
    // Initialize private IPFS gateway counters
    this.redis.set('ipfsGatewayReqs', 0)
    this.redis.set('ipfsStandaloneReqs', 0)

    await this.blacklistManager.init()

    // init libs
    this.libs = await this._initAudiusLibs()

    // Intentionally not awaitted
    this.monitoringQueue.start()
    this.sessionExpirationQueue.start()

    this.servicesInitialized = true
  }

  /**
   * Initializes the blacklistManager if it is not already initialized, and then returns it
   * @returns initialized blacklistManager instance
   */
  async getBlacklistManager() {
    if (!this.blacklistManager.initialized) {
      await this.blacklistManager.init()
    }

    return this.blacklistManager
  }

  /**
   * Returns the ipfs instance
   */
  getIPFS() {
    return this.ipfs
  }

  /**
   * @returns the ipfsLatest instance
   */
  getIPFSLatest() {
    return this.ipfsLatest
  }

  /**
   * Some services require the node server to be running in order to initialize. Run those here.
   * Specifically:
   *  - recover node L1 identity (requires node health check from server to return success)
   *  - initialize SnapbackSM service (requires node L1 identity)
   *  - construct SyncQueue (requires node L1 identity)
   *  - register node on L2 URSM contract (requires node L1 identity)
   *  - construct & init SkippedCIDsRetryQueue (requires SyncQueue)
   */
  async initServicesThatRequireServer() {
    // Cannot progress without recovering spID from node's record on L1 ServiceProviderFactory contract
    // Retries indefinitely
    await this._recoverNodeL1Identity()

    // SnapbackSM init (requires L1 identity)
    // Retries indefinitely
    await this._initSnapbackSM()

    // SyncQueue construction (requires L1 identity)
    // Note - passes in reference to instance of self (serviceRegistry), a very sub-optimal workaround
    this.syncQueue = new SyncQueue(
      this.nodeConfig,
      this.redis,
      this.ipfs,
      this.ipfsLatest,
      this
    )

    // L2URSMRegistration (requires L1 identity)
    // Retries indefinitely
    await this._registerNodeOnL2URSM()

    // SkippedCIDsRetryQueue construction + init (requires SyncQueue)
    // Note - passes in reference to instance of self (serviceRegistry), a very sub-optimal workaround
    this.skippedCIDsRetryQueue = new SkippedCIDsRetryQueue(
      this.nodeConfig,
      this.libs,
      this
    )
    await this.skippedCIDsRetryQueue.init()

    this.servicesThatRequireServerInitialized = true
    this.logInfo(`All services that require server successfully initialized!`)
  }

  logInfo(msg) {
    logger.info(`ServiceRegistry || ${msg}`)
  }

  logError(msg) {
    logger.error(`ServiceRegistry ERROR || ${msg}`)
  }

  /**
   * Poll L1 SPFactory for spID & set spID config once recovered.
   */
  async _recoverNodeL1Identity() {
    const endpoint = config.get('creatorNodeEndpoint')

    const retryTimeoutMs = 5000 // 5sec
    let isInitialized = false
    let attempt = 0
    while (!isInitialized) {
      this.logInfo(
        `Attempting to recover node L1 identity for ${endpoint} on ${retryTimeoutMs}ms interval || attempt #${++attempt} ...`
      )

      try {
        const spID =
          await this.libs.ethContracts.ServiceProviderFactoryClient.getServiceProviderIdFromEndpoint(
            endpoint
          )

        if (spID !== 0) {
          this.nodeConfig.set('spID', spID)

          isInitialized = true
          // Short circuit earlier instead of waiting for another timeout and loop iteration
          break
        }

        // Swallow any errors during recovery attempt
      } catch (e) {
        this.logError(`RecoverNodeL1Identity Error ${e}`)
      }

      await utils.timeout(retryTimeoutMs, false)
    }

    this.logInfo(
      `Successfully recovered node L1 identity for endpoint ${endpoint} on attempt #${attempt}. spID = ${this.nodeConfig.get(
        'spID'
      )}`
    )
  }

  /**
   * Wait until URSM contract is deployed, then attempt to register on L2 URSM with infinite retries
   * Requires L1 identity
   */
  async _registerNodeOnL2URSM() {
    // Wait until URSM contract has been deployed (for backwards-compatibility)
    let retryTimeoutMs = this.nodeConfig.get('devMode')
      ? 10000 /** 10sec */
      : 600000 /* 10min */

    let isInitialized = false
    while (!isInitialized) {
      this.logInfo(
        `Attempting to init UserReplicaSetManagerClient on ${retryTimeoutMs}ms interval...`
      )
      try {
        await this.libs.contracts.initUserReplicaSetManagerClient(false)

        if (this.libs.contracts.UserReplicaSetManagerClient) {
          isInitialized = true
          // Short circuit earlier instead of waiting for another timeout and loop iteration
          break
        }

        // Swallow any errors in contract client init
      } catch (e) {
        this.logError(`Error initting UserReplicaSetManagerClient ${e}`)
      }

      await utils.timeout(retryTimeoutMs, false)
    }

    this.URSMRegistrationManager = new URSMRegistrationManager(
      this.nodeConfig,
      this.libs
    )

    // Attempt to register on URSM with infinite retries
    isInitialized = false
    let attempt = 0
    retryTimeoutMs = 10000 // 10sec
    while (!isInitialized) {
      this.logInfo(
        `Attempting to register node on L2 URSM on ${retryTimeoutMs}ms interval || attempt #${++attempt} ...`
      )

      try {
        await this.URSMRegistrationManager.run()

        isInitialized = true
        // Short circuit earlier instead of waiting for another timeout and loop iteration
        break

        // Swallow any errors during registration attempt
      } catch (e) {
        this.logError(`RegisterNodeOnL2URSM Error ${e}`)
      }

      await utils.timeout(retryTimeoutMs, false)
    }

    this.logInfo('URSM Registration completed')
  }

  /**
   * Initialize SnapbackSM
   * Requires L1 identity
   */
  async _initSnapbackSM() {
    this.snapbackSM = new SnapbackSM(this.nodeConfig, this.libs)

    let isInitialized = false
    const retryTimeoutMs = 10000 // ms
    while (!isInitialized) {
      try {
        this.logInfo(
          `Attempting to init SnapbackSM on ${retryTimeoutMs}ms interval...`
        )

        await this.snapbackSM.init()

        isInitialized = true
        // Short circuit earlier instead of waiting for another timeout and loop iteration
        break

        // Swallow all init errors
      } catch (e) {
        this.logError(`_initSnapbackSM Error ${e}`)
      }

      await utils.timeout(retryTimeoutMs, false)
    }

    this.logInfo(`SnapbackSM Init completed`)
  }

  /**
   * Creates, initializes, and returns an audiusLibs instance
   *
   * Configures dataWeb3 to be internal to libs, logged in with delegatePrivateKey in order to write chain TX
   */
  async _initAudiusLibs() {
    const ethWeb3 = await AudiusLibs.Utils.configureWeb3(
      config.get('ethProviderUrl'),
      config.get('ethNetworkId'),
      /* requiresAccount */ false
    )
    if (!ethWeb3) {
      throw new Error(
        'Failed to init audiusLibs due to ethWeb3 configuration error'
      )
    }

    const discoveryProviderWhitelist = config.get('discoveryProviderWhitelist')
      ? new Set(config.get('discoveryProviderWhitelist').split(','))
      : null
    const identityService = config.get('identityService')

    const audiusLibs = new AudiusLibs({
      ethWeb3Config: AudiusLibs.configEthWeb3(
        config.get('ethTokenAddress'),
        config.get('ethRegistryAddress'),
        ethWeb3,
        config.get('ethOwnerWallet')
      ),
      web3Config: AudiusLibs.configInternalWeb3(
        config.get('dataRegistryAddress'),
        [config.get('dataProviderUrl')],
        // TODO - formatting this private key here is not ideal
        config.get('delegatePrivateKey').replace('0x', '')
      ),
      discoveryProviderConfig: AudiusLibs.configDiscoveryProvider(
        discoveryProviderWhitelist,
        /* blacklist */ null,
        /* reselectTimeout */ null,
        /* selectionCallback */ null,
        /* monitoringCallbacks */ {},
        /* selectionRequestTimeout */ null,
        /* selectionRequestRetries */ null,
        /* unhealthySlotDiffPlays */ null,
        /* unhealthyBlockDiff */ 500
      ),
      // If an identity service config is present, set up libs with the connection, otherwise do nothing
      identityServiceConfig: identityService
        ? AudiusLibs.configIdentityService(identityService)
        : undefined,
      isDebug: config.get('creatorNodeIsDebug'),
      isServer: true,
      preferHigherPatchForPrimary: true,
      preferHigherPatchForSecondaries: true
    })

    await audiusLibs.init()
    return audiusLibs
  }
}

/*
 * Export a singleton instance of the ServiceRegistry
 */
const serviceRegistry = new ServiceRegistry()

module.exports = {
  serviceRegistry
}
