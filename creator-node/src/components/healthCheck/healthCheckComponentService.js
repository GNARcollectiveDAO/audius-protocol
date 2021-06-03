const versionInfo = require('../../../.version.json')
const config = require('../../config')
const utils = require('../../utils.js')
const { MONITORS } = require('../../monitors/monitors')

/**
 * Perform a basic health check, returning the
 * currently selected discovery provider (if any),
 * the current git SHA, and service version info.
 * @param {*} ServiceRegistry
 * @param {*} logger
 * @param {*} sequelize
 * @param {string?} randomBytesToSign optional bytes string to be included in response object
 *    and used in signature generation
 */
const healthCheck = async ({ libs } = {}, logger, sequelize, randomBytesToSign = null) => {
  let response = {
    ...versionInfo,
    healthy: true,
    git: process.env.GIT_SHA,
    selectedDiscoveryProvider: 'none',
    creatorNodeEndpoint: config.get('creatorNodeEndpoint'),
    spID: config.get('spID'),
    spOwnerWallet: config.get('spOwnerWallet'),
    isRegisteredOnURSM: config.get('isRegisteredOnURSM')
  }

  // If optional `randomBytesToSign` query param provided, node will include string in signed object
  if (randomBytesToSign) {
    response.randomBytesToSign = randomBytesToSign
  }

  if (libs) {
    response.selectedDiscoveryProvider = libs.discoveryProvider.discoveryProviderEndpoint
  } else {
    logger.warn('Health check with no libs')
  }

  // we have a /db_check route for more granular detail, but the service health check should
  // also check that the db connection is good. having this in the health_check
  // allows us to get auto restarts from liveness probes etc if the db connection is down
  await sequelize.query('SELECT 1')

  return response
}

/**
 * Perform a verbose health check, returning health check results
 * as well as location info, and system info.
 * @param {*} ServiceRegistry
 * @param {*} logger
 * @param {*} sequelize
 * @param {*} getMonitors
 * @param {number} numberOfCPUs the number of CPUs on this machine
 * @param {function} getAggregateSyncData fn to get the latest daily sync count (success, fail, triggered)
 * @param {function} getLatestSyncData fn to get the timestamps of the most recent sync (success, fail)
 */
const healthCheckVerbose = async ({ libs } = {}, logger, sequelize, getMonitors, numberOfCPUs, getAggregateSyncData, getLatestSyncData) => {
  const basicHealthCheck = await healthCheck({ libs }, logger, sequelize)

  // Location information
  const country = config.get('serviceCountry')
  const latitude = config.get('serviceLatitude')
  const longitude = config.get('serviceLongitude')

  const maxStorageUsedPercent = config.get('maxStorageUsedPercent')

  // System information
  const [
    databaseConnections,
    databaseSize,
    totalMemory,
    usedMemory,
    usedTCPMemory,
    storagePathSize,
    storagePathUsed,
    maxFileDescriptors,
    allocatedFileDescriptors,
    receivedBytesPerSec,
    transferredBytesPerSec,
    rollingSyncSuccessCount,
    rollingSyncFailCount
  ] = await getMonitors([
    MONITORS.DATABASE_CONNECTIONS,
    MONITORS.DATABASE_SIZE,
    MONITORS.TOTAL_MEMORY,
    MONITORS.USED_MEMORY,
    MONITORS.USED_TCP_MEMORY,
    MONITORS.STORAGE_PATH_SIZE,
    MONITORS.STORAGE_PATH_USED,
    MONITORS.MAX_FILE_DESCRIPTORS,
    MONITORS.ALLOCATED_FILE_DESCRIPTORS,
    MONITORS.RECEIVED_BYTES_PER_SEC,
    MONITORS.TRANSFERRED_BYTES_PER_SEC,
    MONITORS.ROLLING_SYNC_SUCCESS_COUNT,
    MONITORS.ROLLING_SYNC_FAIL_COUNT
  ])

  const latestDailySyncCount = await getAggregateSyncData()
  const latestDailySyncTimestamps = await getLatestSyncData()

  const response = {
    ...basicHealthCheck,
    country,
    latitude,
    longitude,
    databaseConnections,
    databaseSize,
    totalMemory,
    usedMemory,
    usedTCPMemory,
    storagePathSize,
    storagePathUsed,
    maxFileDescriptors,
    allocatedFileDescriptors,
    receivedBytesPerSec,
    transferredBytesPerSec,
    maxStorageUsedPercent,
    numberOfCPUs,
    // Rolling window days dependent on value set in monitor's sync history file
    rollingSyncSuccessCount,
    rollingSyncFailCount,
    latestDailySyncSuccessCount: latestDailySyncCount.success,
    latestDailySyncFailCount: latestDailySyncCount.fail,
    latestDailySyncSuccessTimestamp: latestDailySyncTimestamps.success,
    latestDailySyncFailTImestamp: latestDailySyncTimestamps.fail
  }

  return response
}

/**
 * Perform a duration health check limited to configured delegateOwnerWallet
 * Used to validate availability prior to joining the network
 * @param {*} ServiceRegistry
 * @param {*} logger
 */
const healthCheckDuration = async () => {
  // Wait 5 minutes, intentionally holding this route open
  await utils.timeout(300000)
  return { success: true }
}

module.exports = {
  healthCheck,
  healthCheckVerbose,
  healthCheckDuration
}
