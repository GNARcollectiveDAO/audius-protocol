const axios = require('axios')

const { logger } = require('../../logging')
const models = require('../../models')
const { saveFileForMultihashToFS } = require('../../fileManager')
const { getOwnEndpoint, getCreatorNodeEndpoints } = require('../../middlewares')
const SyncHistoryAggregator = require('../../snapbackSM/syncHistoryAggregator')
const DBManager = require('../../dbManager')
const UserSyncFailureCountManager = require('./UserSyncFailureCountManager')

/**
 * This function is only run on secondaries, to export and sync data from a user's primary.
 *
 * @notice - By design, will reject any syncs with non-contiguous clock values. For now,
 *    any data corruption from primary needs to be handled separately and should not be replicated.
 *
 * @notice - There is a maxExportClockValueRange enforced in export, meaning that some syncs will
 *    only replicate partial data state. This is by design, and Snapback will trigger repeated syncs
 *    with progressively increasing clock values until secondaries have completely synced up.
 *    Secondaries have no knowledge of the current data state on primary, they simply replicate
 *    what they receive in each export.
 */
async function processSync(
  serviceRegistry,
  walletPublicKeys,
  creatorNodeEndpoint,
  blockNumber = null,
  forceResync = false
) {
  const { nodeConfig, redis } = serviceRegistry

  const FileSaveMaxConcurrency = nodeConfig.get(
    'nodeSyncFileSaveMaxConcurrency'
  )
  const SyncRequestMaxUserFailureCountBeforeSkip = nodeConfig.get(
    'syncRequestMaxUserFailureCountBeforeSkip'
  )

  const start = Date.now()

  logger.info('begin nodesync for ', walletPublicKeys, 'time', start)

  // object to track if the function errored, returned at the end of the function
  let errorObj = null

  /**
   * Ensure access to each wallet, then acquire redis lock for duration of sync
   */
  const redisLock = redis.lock
  let redisKey
  for (const wallet of walletPublicKeys) {
    redisKey = redis.getNodeSyncRedisKey(wallet)
    const lockHeld = await redisLock.getLock(redisKey)
    if (lockHeld) {
      errorObj = new Error(
        `Cannot change state of wallet ${wallet}. Node sync currently in progress.`
      )
      return errorObj
    }
    await redisLock.setLock(redisKey)
  }

  /**
   * Perform all sync operations, catch and log error if thrown, and always release redis locks after.
   */
  try {
    const wallet = walletPublicKeys[0]

    let localMaxClockVal
    if (forceResync) {
      await DBManager.deleteAllCNodeUserDataFromDB({ lookupWallet: wallet })
      localMaxClockVal = -1
    } else {
      // Query own latest clockValue and call export with that value + 1; export from 0 for first time sync
      const cnodeUser = await models.CNodeUser.findOne({
        where: { walletPublicKey: walletPublicKeys[0] }
      })
      localMaxClockVal = cnodeUser ? cnodeUser.clock : -1
    }

    /**
     * Fetch data export from creatorNodeEndpoint for given walletPublicKeys and clock value range
     *
     * Secondary requests export of new data by passing its current max clock value in the request.
     * Primary builds an export object of all data beginning from the next clock value.
     */

    // Build export query params
    const exportQueryParams = {
      wallet_public_key: walletPublicKeys,
      clock_range_min: localMaxClockVal + 1
    }

    // This is used only for logging by primary to record endpoint of requesting node
    if (nodeConfig.get('creatorNodeEndpoint')) {
      exportQueryParams.source_endpoint = nodeConfig.get('creatorNodeEndpoint')
    }

    const resp = await axios({
      method: 'get',
      baseURL: creatorNodeEndpoint,
      url: '/export',
      params: exportQueryParams,
      responseType: 'json',
      /** @notice - this request timeout is arbitrarily large for now until we find an appropriate value */
      timeout: 300000 /* 5m = 300000ms */
    })

    if (resp.status !== 200) {
      logger.error(
        redisKey,
        `Failed to retrieve export from ${creatorNodeEndpoint} for wallets`,
        walletPublicKeys
      )
      throw new Error(resp.data.error)
    }

    // TODO - explain patch
    if (!resp.data) {
      if (resp.request && resp.request.responseText) {
        resp.data = JSON.parse(resp.request.responseText)
      } else throw new Error(`Malformed response from ${creatorNodeEndpoint}.`)
    }

    const { data: body } = resp
    if (
      !body.data.hasOwnProperty('cnodeUsers') ||
      !body.data.hasOwnProperty('ipfsIDObj') ||
      !body.data.ipfsIDObj.hasOwnProperty('addresses')
    ) {
      throw new Error(`Malformed response from ${creatorNodeEndpoint}.`)
    }

    logger.info(
      redisKey,
      `Successful export from ${creatorNodeEndpoint} for wallets ${walletPublicKeys} and requested min clock ${
        localMaxClockVal + 1
      }`
    )

    try {
      // Attempt to connect directly to target CNode's IPFS node
      // async function runs in the background
      _initBootstrapAndRefreshPeers(
        serviceRegistry,
        logger,
        body.data.ipfsIDObj.addresses,
        redisKey
      )
      logger.info(redisKey, 'IPFS Nodes connected + data export received')
    } catch (e) {
      // if there's an error peering to an IPFS node, do not stop execution
      // since we have other fallbacks, keep going on with sync
      logger.error(
        `Error in _nodeSync calling _initBootstrapAndRefreshPeers for redisKey ${redisKey}`,
        e
      )
    }

    /**
     * For each CNodeUser, replace local DB state with retrieved data + fetch + save missing files.
     */

    for (const fetchedCNodeUser of Object.values(body.data.cnodeUsers)) {
      // Since different nodes may assign different cnodeUserUUIDs to a given walletPublicKey,
      // retrieve local cnodeUserUUID from fetched walletPublicKey and delete all associated data.
      if (!fetchedCNodeUser.hasOwnProperty('walletPublicKey')) {
        throw new Error(
          `Malformed response received from ${creatorNodeEndpoint}. "walletPublicKey" property not found on CNodeUser in response object`
        )
      }
      const fetchedWalletPublicKey = fetchedCNodeUser.walletPublicKey

      /**
       * Retrieve user's replica set to use as gateways for content fetching in saveFileForMultihashToFS
       *
       * Note that sync is only called on secondaries so `myCnodeEndpoint` below always represents a secondary.
       */
      let userReplicaSet = []
      try {
        const myCnodeEndpoint = await getOwnEndpoint(serviceRegistry)
        userReplicaSet = await getCreatorNodeEndpoints({
          serviceRegistry,
          logger: logger,
          wallet: fetchedWalletPublicKey,
          blockNumber,
          ensurePrimary: false,
          myCnodeEndpoint
        })

        // filter out current node from user's replica set
        userReplicaSet = userReplicaSet.filter((url) => url !== myCnodeEndpoint)

        // Spread + set uniq's the array
        userReplicaSet = [...new Set(userReplicaSet)]
      } catch (e) {
        logger.error(
          redisKey,
          `Couldn't get user's replica set, can't use cnode gateways in saveFileForMultihashToFS - ${e.message}`
        )
      }

      if (!walletPublicKeys.includes(fetchedWalletPublicKey)) {
        throw new Error(
          `Malformed response from ${creatorNodeEndpoint}. Returned data for walletPublicKey that was not requested.`
        )
      }

      /**
       * This node (secondary) must compare its local clock state against clock state received in export from primary.
       * Only allow sync if received clock state contains new data and is contiguous with existing data.
       */

      const {
        latestBlockNumber: fetchedLatestBlockNumber,
        clock: fetchedLatestClockVal,
        clockRecords: fetchedClockRecords
      } = fetchedCNodeUser

      // Error if returned data is not within requested range
      if (fetchedLatestClockVal < localMaxClockVal) {
        throw new Error(
          `Cannot sync for localMaxClockVal ${localMaxClockVal} - imported data has max clock val ${fetchedLatestClockVal}`
        )
      } else if (fetchedLatestClockVal === localMaxClockVal) {
        // Already up to date, no sync necessary
        logger.info(
          redisKey,
          `User ${fetchedWalletPublicKey} already up to date! Both nodes have latest clock value ${localMaxClockVal}`
        )
        continue
      } else if (
        localMaxClockVal !== -1 &&
        fetchedClockRecords[0] &&
        fetchedClockRecords[0].clock !== localMaxClockVal + 1
      ) {
        throw new Error(
          `Cannot sync - imported data is not contiguous. Local max clock val = ${localMaxClockVal} and imported min clock val ${fetchedClockRecords[0].clock}`
        )
      }

      // All DB updates must happen in single atomic tx - partial state updates will lead to data loss
      const transaction = await models.sequelize.transaction()

      /**
       * Process all DB updates for cnodeUser
       */
      try {
        logger.info(
          redisKey,
          `beginning add ops for cnodeUser wallet ${fetchedWalletPublicKey}`
        )

        /**
         * Update CNodeUser entry if exists else create new
         *
         * Cannot use upsert since it fails to use default value for cnodeUserUUID per this issue https://github.com/sequelize/sequelize/issues/3247
         */

        let cnodeUser

        // Fetch current cnodeUser from DB
        const cnodeUserRecord = await models.CNodeUser.findOne({
          where: { walletPublicKey: fetchedWalletPublicKey },
          transaction
        })

        /**
         * The first sync for a user will enter else case where no local cnodeUserRecord is found
         *    creating a new entry with a new auto-generated cnodeUserUUID.
         * Every subsequent sync will enter the if case and update the existing local cnodeUserRecord.
         */
        if (cnodeUserRecord) {
          const [numRowsUpdated, respObj] = await models.CNodeUser.update(
            {
              lastLogin: fetchedCNodeUser.lastLogin,
              latestBlockNumber: fetchedLatestBlockNumber,
              clock: fetchedCNodeUser.clock,
              createdAt: fetchedCNodeUser.createdAt
            },
            {
              where: { walletPublicKey: fetchedWalletPublicKey },
              fields: [
                'lastLogin',
                'latestBlockNumber',
                'clock',
                'createdAt',
                'updatedAt'
              ],
              returning: true,
              transaction
            }
          )

          // Error if update failed
          if (numRowsUpdated !== 1 || respObj.length !== 1) {
            throw new Error(
              `Failed to update cnodeUser row for cnodeUser wallet ${fetchedWalletPublicKey}`
            )
          }
          cnodeUser = respObj[0]
        } else {
          // Will throw error if creation fails
          cnodeUser = await models.CNodeUser.create(
            {
              walletPublicKey: fetchedWalletPublicKey,
              lastLogin: fetchedCNodeUser.lastLogin,
              latestBlockNumber: fetchedLatestBlockNumber,
              clock: fetchedCNodeUser.clock,
              createdAt: fetchedCNodeUser.createdAt
            },
            {
              returning: true,
              transaction
            }
          )
        }

        const cnodeUserUUID = cnodeUser.cnodeUserUUID
        logger.info(
          redisKey,
          `Inserted CNodeUser for cnodeUser wallet ${fetchedWalletPublicKey}: cnodeUserUUID: ${cnodeUserUUID}`
        )

        /**
         * Populate all new data for fetched cnodeUser
         * Always use local cnodeUserUUID in favor of cnodeUserUUID in exported dataset to ensure consistency
         */

        /*
         * Make list of all track Files to add after track creation
         *
         * Files with trackBlockchainIds cannot be created until tracks have been created,
         *    but tracks cannot be created until metadata and cover art files have been created.
         */

        const trackFiles = fetchedCNodeUser.files.filter((file) =>
          models.File.TrackTypes.includes(file.type)
        )
        const nonTrackFiles = fetchedCNodeUser.files.filter((file) =>
          models.File.NonTrackTypes.includes(file.type)
        )
        const numTotalFiles = trackFiles.length + nonTrackFiles.length

        const CIDsThatFailedSaveFileOp = new Set()

        // Save all track files to disk in batches (to limit concurrent load)
        for (let i = 0; i < trackFiles.length; i += FileSaveMaxConcurrency) {
          const trackFilesSlice = trackFiles.slice(
            i,
            i + FileSaveMaxConcurrency
          )
          logger.info(
            redisKey,
            `TrackFiles saveFileForMultihashToFS - processing trackFiles ${i} to ${
              i + FileSaveMaxConcurrency
            } out of total ${trackFiles.length}...`
          )

          /**
           * Fetch content for each CID + save to FS
           * Record any CIDs that failed retrieval/saving for later use
           * @notice `saveFileForMultihashToFS()` should never reject - it will return error indicator for post processing
           */
          await Promise.all(
            trackFilesSlice.map(async (trackFile) => {
              const success = await saveFileForMultihashToFS(
                serviceRegistry,
                logger,
                trackFile.multihash,
                trackFile.storagePath,
                userReplicaSet,
                null,
                trackFile.trackBlockchainId
              )

              // If saveFile op failed, record CID for later processing
              if (!success) {
                CIDsThatFailedSaveFileOp.add(trackFile.multihash)
              }
            })
          )
        }
        logger.info(redisKey, 'Saved all track files to disk.')

        // Save all non-track files to disk in batches (to limit concurrent load)
        for (let i = 0; i < nonTrackFiles.length; i += FileSaveMaxConcurrency) {
          const nonTrackFilesSlice = nonTrackFiles.slice(
            i,
            i + FileSaveMaxConcurrency
          )
          logger.info(
            redisKey,
            `NonTrackFiles saveFileForMultihashToFS - processing files ${i} to ${
              i + FileSaveMaxConcurrency
            } out of total ${nonTrackFiles.length}...`
          )
          await Promise.all(
            nonTrackFilesSlice.map(async (nonTrackFile) => {
              // Skip over directories since there's no actual content to sync
              // The files inside the directory are synced separately
              if (nonTrackFile.type !== 'dir') {
                const multihash = nonTrackFile.multihash

                let success

                // if it's an image file, we need to pass in the actual filename because the gateway request is /ipfs/Qm123/<filename>
                // need to also check fileName is not null to make sure it's a dir-style image. non-dir images won't have a 'fileName' db column
                if (
                  nonTrackFile.type === 'image' &&
                  nonTrackFile.fileName !== null
                ) {
                  success = await saveFileForMultihashToFS(
                    serviceRegistry,
                    logger,
                    multihash,
                    nonTrackFile.storagePath,
                    userReplicaSet,
                    nonTrackFile.fileName
                  )
                } else {
                  success = await saveFileForMultihashToFS(
                    serviceRegistry,
                    logger,
                    multihash,
                    nonTrackFile.storagePath,
                    userReplicaSet
                  )
                }

                // If saveFile op failed, record CID for later processing
                if (!success) {
                  CIDsThatFailedSaveFileOp.add(multihash)
                }
              }
            })
          )
        }
        logger.info(redisKey, 'Saved all non-track files to disk.')

        /**
         * Handle scenario where failed to retrieve/save > 0 CIDs
         * Reject sync if number of failures for user is below threshold, else proceed and mark unretrieved files as skipped
         */
        const numCIDsThatFailedSaveFileOp = CIDsThatFailedSaveFileOp.size
        if (numCIDsThatFailedSaveFileOp > 0) {
          const userSyncFailureCount =
            UserSyncFailureCountManager.incrementFailureCount(
              fetchedWalletPublicKey
            )

          // Throw error if failure threshold not yet reached
          if (userSyncFailureCount < SyncRequestMaxUserFailureCountBeforeSkip) {
            const errorMsg = `User Sync failed due to ${numCIDsThatFailedSaveFileOp} failing saveFileForMultihashToFS op. userSyncFailureCount = ${userSyncFailureCount} // SyncRequestMaxUserFailureCountBeforeSkip = ${SyncRequestMaxUserFailureCountBeforeSkip}`
            logger.error(redisKey, errorMsg)
            throw new Error(errorMsg)

            // If max failure threshold reached, continue with sync and reset failure count
          } else {
            // Reset falure count so subsequent user syncs will not always succeed & skip
            UserSyncFailureCountManager.resetFailureCount(
              fetchedWalletPublicKey
            )

            logger.info(
              redisKey,
              `User Sync continuing with ${numCIDsThatFailedSaveFileOp} skipped files, since SyncRequestMaxUserFailureCountBeforeSkip (${SyncRequestMaxUserFailureCountBeforeSkip}) reached.`
            )
          }
        } else {
          // Reset failure count if all files were successfully saved
          UserSyncFailureCountManager.resetFailureCount(fetchedWalletPublicKey)
        }

        /**
         * Write all records to DB
         */

        await models.ClockRecord.bulkCreate(
          fetchedCNodeUser.clockRecords.map((clockRecord) => ({
            ...clockRecord,
            cnodeUserUUID
          })),
          { transaction }
        )
        logger.info(redisKey, 'Saved all ClockRecord entries to DB')

        await models.File.bulkCreate(
          nonTrackFiles.map((file) => {
            if (CIDsThatFailedSaveFileOp.has(file.multihash)) {
              file.skipped = true // defaults to false
            }
            return {
              ...file,
              trackBlockchainId: null,
              cnodeUserUUID
            }
          }),
          { transaction }
        )
        logger.info(redisKey, 'Saved all non-track File entries to DB')

        await models.Track.bulkCreate(
          fetchedCNodeUser.tracks.map((track) => ({
            ...track,
            cnodeUserUUID
          })),
          { transaction }
        )
        logger.info(redisKey, 'Saved all Track entries to DB')

        await models.File.bulkCreate(
          trackFiles.map((trackFile) => {
            if (CIDsThatFailedSaveFileOp.has(trackFile.multihash)) {
              trackFile.skipped = true // defaults to false
            }
            return {
              ...trackFile,
              cnodeUserUUID
            }
          }),
          { transaction }
        )
        logger.info(redisKey, 'Saved all track File entries to DB')

        await models.AudiusUser.bulkCreate(
          fetchedCNodeUser.audiusUsers.map((audiusUser) => ({
            ...audiusUser,
            cnodeUserUUID
          })),
          { transaction }
        )
        logger.info(redisKey, 'Saved all AudiusUser entries to DB')

        await transaction.commit()
        await redisLock.removeLock(redisKey)

        logger.info(
          redisKey,
          `Transaction successfully committed for cnodeUser wallet ${fetchedWalletPublicKey} with ${numTotalFiles} files processed and ${numCIDsThatFailedSaveFileOp} skipped.`
        )

        // track that sync for this user was successful
        await SyncHistoryAggregator.recordSyncSuccess(fetchedWalletPublicKey)
      } catch (e) {
        logger.error(
          redisKey,
          `Transaction failed for cnodeUser wallet ${fetchedWalletPublicKey}`,
          e
        )

        await transaction.rollback()
        await redisLock.removeLock(redisKey)

        throw new Error(e)
      }
    }
  } catch (e) {
    errorObj = e

    for (const wallet of walletPublicKeys) {
      await SyncHistoryAggregator.recordSyncFail(wallet)
    }
  } finally {
    // Release all redis locks
    for (const wallet of walletPublicKeys) {
      const redisKey = redis.getNodeSyncRedisKey(wallet)
      await redisLock.removeLock(redisKey)
    }

    if (errorObj)
      logger.error(
        redisKey,
        `Sync complete for wallets: ${walletPublicKeys.join(
          ','
        )}. Status: Error, message: ${errorObj.message}. Duration sync: ${
          Date.now() - start
        }. From endpoint ${creatorNodeEndpoint}.`
      )
    else
      logger.info(
        redisKey,
        `Sync complete for wallets: ${walletPublicKeys.join(
          ','
        )}. Status: Success. Duration sync: ${
          Date.now() - start
        }. From endpoint ${creatorNodeEndpoint}.`
      )
  }

  return errorObj
}

/**
 * Given IPFS node peer addresses, add to bootstrap peers list and manually connect
 **/
async function _initBootstrapAndRefreshPeers(
  { ipfs },
  logger,
  targetIPFSPeerAddresses,
  redisKey
) {
  logger.info(redisKey, 'Initializing Bootstrap Peers:')

  // Get own IPFS node's peer addresses
  const ipfsID = await ipfs.id()
  if (!ipfsID.hasOwnProperty('addresses')) {
    throw new Error('failed to retrieve ipfs node addresses')
  }
  const ipfsPeerAddresses = ipfsID.addresses

  // For each targetPeerAddress, add to trusted peer list and open connection.
  for (const targetPeerAddress of targetIPFSPeerAddresses) {
    if (
      targetPeerAddress.includes('ip6') ||
      targetPeerAddress.includes('127.0.0.1')
    )
      continue
    if (ipfsPeerAddresses.includes(targetPeerAddress)) {
      logger.info(redisKey, 'ipfs addresses are same - do not connect')
      continue
    }

    // Add to list of bootstrap peers.
    let results = await ipfs.bootstrap.add(targetPeerAddress)
    logger.info(redisKey, 'ipfs bootstrap add results:', results)

    // Manually connect to peer.
    results = await ipfs.swarm.connect(targetPeerAddress)
    logger.info(redisKey, 'peer connection results:', results.Strings[0])
  }
}

module.exports = processSync
