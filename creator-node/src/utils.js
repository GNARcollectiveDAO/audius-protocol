const { recoverPersonalSignature } = require('eth-sig-util')
const fs = require('fs-extra')
const path = require('path')
const { BufferListStream } = require('bl')
const axios = require('axios')
const spawn = require('child_process').spawn
const stream = require('stream')
const retry = require('async-retry')
const { promisify } = require('util')
const pipeline = promisify(stream.pipeline)

const { logger: genericLogger } = require('./logging')
const models = require('./models')
const { ipfsLatest } = require('./ipfsClient')
const redis = require('./redis')
const config = require('./config')
const { generateTimestampAndSignature } = require('./apiSigning')
const { generateNonImageMultihash } = require('./ipfsAdd')

const THIRTY_MINUTES_IN_SECONDS = 60 * 30
const TEN_MINUTES_IN_SECONDS = 60 * 10

let ipfsIDObj

class Utils {
  static verifySignature(data, sig) {
    return recoverPersonalSignature({ data, sig })
  }

  static async timeout(ms, log = true) {
    if (log) {
      console.log(`starting timeout of ${ms}`)
    }
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  static getRandomInt(max) {
    return Math.floor(Math.random() * max)
  }
}

/**
 * Ensure DB and disk records exist for dirCID and its contents
 * Return fileUUID for dir DB record
 * This function does not do further validation since image_upload provides remaining guarantees
 */
async function validateStateForImageDirCIDAndReturnFileUUID(req, imageDirCID) {
  // This handles case where a user/track metadata obj contains no image CID
  if (!imageDirCID) {
    return null
  }
  req.logger.info(
    `Beginning validateStateForImageDirCIDAndReturnFileUUID for imageDirCID ${imageDirCID}`
  )

  // Ensure file exists for dirCID
  const dirFile = await models.File.findOne({
    where: {
      multihash: imageDirCID,
      cnodeUserUUID: req.session.cnodeUserUUID,
      type: 'dir'
    }
  })
  if (!dirFile) {
    throw new Error(`No file stored in DB for imageDirCID ${imageDirCID}`)
  }

  // Ensure dir exists on disk
  if (!(await fs.pathExists(dirFile.storagePath))) {
    throw new Error(
      `No dir found on disk for imageDirCID ${imageDirCID} at expected path ${dirFile.storagePath}`
    )
  }

  const imageFiles = await models.File.findAll({
    where: {
      dirMultihash: imageDirCID,
      cnodeUserUUID: req.session.cnodeUserUUID,
      type: 'image'
    }
  })
  if (!imageFiles) {
    throw new Error(
      `No image file records found in DB for imageDirCID ${imageDirCID}`
    )
  }

  // Ensure every file exists on disk
  await Promise.all(
    imageFiles.map(async function (imageFile) {
      if (!(await fs.pathExists(imageFile.storagePath))) {
        throw new Error(
          `No file found on disk for imageDirCID ${imageDirCID} image file at path ${imageFile.path}`
        )
      }
    })
  )

  req.logger.info(
    `Completed validateStateForImageDirCIDAndReturnFileUUID for imageDirCID ${imageDirCID}`
  )
  return dirFile.fileUUID
}

async function getIPFSPeerId(ipfs) {
  // Assumes the ipfs id returns the correct address from IPFS. May need to set the correct values in
  // the IPFS pod. Command is:
  // ipfs config --json Addresses.Announce '["/ip4/<public ip>/tcp/<public port>"]'
  // the public port is the port mapped to IPFS' port 4001
  if (!ipfsIDObj) {
    ipfsIDObj = await ipfs.id()
    setInterval(async () => {
      ipfsIDObj = await ipfs.id()
    }, TEN_MINUTES_IN_SECONDS * 1000)
  }

  return ipfsIDObj
}

/**
 * Cat single byte of file at given filepath. If ipfs.cat() call takes longer than the timeout time or
 * something goes wrong, an error will be thrown.
 */
const ipfsSingleByteCat = (path, logContext, timeout = 1000) => {
  const logger = genericLogger.child(logContext)

  return new Promise(async (resolve, reject) => {
    const start = Date.now()

    try {
      // ipfs.cat() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
      // don't keep track of the results as this call is a proof-of-concept that the file exists in ipfs
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of ipfsLatest.cat(path, { length: 1, timeout })) {
        continue
      }
      logger.info(
        `ipfsSingleByteCat - Retrieved ${path} in ${Date.now() - start}ms`
      )
      resolve()
    } catch (e) {
      // Expected message for e is `TimeoutError: Request timed out`
      // if it's not that message, log out the error
      if (!e.message.includes('Request timed out')) {
        logger.error(`ipfsSingleByteCat - Error: ${e}`)
      }
      reject(e)
    }
  })
}

/**
 * Call ipfs.cat on a path with optional timeout and length parameters
 * @param {*} serviceRegistry
 * @param {*} logger
 * @param {*} path IPFS cid for file
 * @param {*} timeout timeout for IPFS op in ms
 * @param {*} length length of data to retrieve from file
 * @returns {Buffer}
 */
const ipfsCat = ({ ipfsLatest }, logger, path, timeout = 1000, length = null) =>
  new Promise(async (resolve, reject) => {
    const start = Date.now()

    try {
      const chunks = []
      const options = {}
      if (length) options.length = length
      if (timeout) options.timeout = timeout

      // using a js timeout because IPFS cat sometimes does not resolve the timeout and gets
      // stuck in this function indefinitely
      // make this timeout 2x the regular timeout to account for possible latency of transferring a large file
      setTimeout(() => {
        return reject(new Error('ipfsCat timed out'))
      }, 2 * timeout)

      // ipfsLatest.cat() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of ipfsLatest.cat(path, options)) {
        chunks.push(chunk)
      }
      logger.debug(`ipfsCat - Retrieved ${path} in ${Date.now() - start}ms`)
      resolve(Buffer.concat(chunks))
    } catch (e) {
      reject(e)
    }
  })

/**
 * Call ipfs.get on a path with an optional timeout
 * @param {*} serviceRegistry
 * @param {*} logger
 * @param {String} path IPFS cid for file
 * @param {Number} timeout timeout in ms
 * @returns {BufferListStream}
 */
const ipfsGet = ({ ipfsLatest }, logger, path, timeout = 1000) =>
  new Promise(async (resolve, reject) => {
    const start = Date.now()

    try {
      const chunks = []
      const options = {}
      if (timeout) options.timeout = timeout

      // using a js timeout because IPFS get sometimes does not resolve the timeout and gets
      // stuck in this function indefinitely
      // make this timeout 2x the regular timeout to account for possible latency of transferring a large file
      setTimeout(() => {
        return reject(new Error('ipfsGet timed out'))
      }, 2 * timeout)

      // ipfsLatest.get() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
      /* eslint-disable-next-line no-unused-vars */
      for await (const file of ipfsLatest.get(path, options)) {
        if (!file.content) continue

        const content = new BufferListStream()
        for await (const chunk of file.content) {
          content.append(chunk)
        }
        resolve(content)
      }
      logger.info(`ipfsGet - Retrieved ${path} in ${Date.now() - start}ms`)
      resolve(Buffer.concat(chunks))
    } catch (e) {
      reject(e)
    }
  })

/**
 *
 * @param {String} filePath location of the file on disk
 * @param {String} cid content hash of the file
 * @param {Object} logger logger object
 * @param {Object} libs libs instance
 * @param {Integer?} trackId optional trackId that corresponds to the cid, see file_lookup route for more info
 * @param {Array?} excludeList optional array of content nodes to exclude in network wide search
 * @returns {Boolean} returns true if the file was found in the network
 */
async function findCIDInNetwork(
  filePath,
  cid,
  logger,
  libs,
  trackId = null,
  excludeList = []
) {
  let found = false

  const attemptedStateFix = await getIfAttemptedStateFix(filePath)
  if (attemptedStateFix) return

  // get list of creator nodes
  const creatorNodes = await getAllRegisteredCNodes(libs)
  if (!creatorNodes.length) return

  // Remove excluded nodes from list of creator nodes, no-op if empty list or nothing passed in
  const creatorNodesFiltered = creatorNodes.filter(
    (c) => !excludeList.includes(c.endpoint)
  )

  // generate signature
  const delegateWallet = config.get('delegateOwnerWallet').toLowerCase()
  const { signature, timestamp } = generateTimestampAndSignature(
    { filePath, delegateWallet },
    config.get('delegatePrivateKey')
  )
  let node

  for (let index = 0; index < creatorNodesFiltered.length; index++) {
    node = creatorNodesFiltered[index]
    try {
      const resp = await axios({
        method: 'get',
        url: `${node.endpoint}/file_lookup`,
        params: {
          filePath,
          timestamp,
          delegateWallet,
          signature,
          trackId
        },
        responseType: 'stream',
        timeout: 1000
      })
      if (resp.data) {
        await writeStreamToFileSystem(resp.data, filePath, /* createDir */ true)

        // Verify that the file written matches the hash expected
        const ipfsHashOnly = await generateNonImageMultihash(filePath)

        if (cid !== ipfsHashOnly) {
          await fs.unlink(filePath)
          logger.error(
            `findCIDInNetwork - File contents don't match IPFS hash cid: ${cid} result: ${ipfsHashOnly}`
          )
        }
        found = true
        logger.info(
          `findCIDInNetwork - successfully fetched file ${filePath} from node ${node.endpoint}`
        )
        break
      }
    } catch (e) {
      logger.error(`findCIDInNetwork error - ${e.toString()}`)
      // since this is a function running in the background intended to fix state, don't error
      // and stop the flow of execution for functions that call it
      continue
    }
  }

  return found
}

/**
 * Get all Content Nodes registered on chain, excluding self
 * Fetches from Redis if available, else fetches from chain and updates Redis value
 * @returns {Object[]} array of SP objects with schema { owner, endpoint, spID, type, blockNumber, delegateOwnerWallet }
 */
async function getAllRegisteredCNodes(libs, logger) {
  const cacheKey = 'all_registered_cnodes'

  let CNodes
  try {
    // Fetch from Redis if present
    const cnodesList = await redis.get(cacheKey)
    if (cnodesList) {
      return JSON.parse(cnodesList)
    }

    // Else, fetch from chain
    let creatorNodes =
      await libs.ethContracts.ServiceProviderFactoryClient.getServiceProviderList(
        'content-node'
      )

    // Filter out self endpoint
    creatorNodes = creatorNodes.filter(
      (node) => node.endpoint !== config.get('creatorNodeEndpoint')
    )

    // Write fetched value to Redis with 30min expiry
    await redis.set(
      cacheKey,
      JSON.stringify(creatorNodes),
      'EX',
      THIRTY_MINUTES_IN_SECONDS
    )

    CNodes = creatorNodes
  } catch (e) {
    if (logger) {
      logger.error(
        `Error getting values in getAllRegisteredCNodes: ${e.message}`
      )
    } else {
      console.error(
        `Error getting values in getAllRegisteredCNodes: ${e.message}`
      )
    }

    CNodes = []
  }

  return CNodes
}

/**
 * Return if a fix has already been attempted in today for this filePath
 * @param {String} filePath path of CID on the file system
 */
async function getIfAttemptedStateFix(filePath) {
  // key is `attempted_fs_fixes:<today's date>`
  // the date function just generates the ISOString and removes the timestamp component
  const key = `attempted_fs_fixes:${new Date().toISOString().split('T')[0]}`
  const firstTime = await redis.sadd(key, filePath)
  await redis.expire(key, 60 * 60 * 24) // expire one day after final write

  // if firstTime is 1, it's a new key. existing key returns 0
  return !firstTime
}

async function createDirForFile(fileStoragePath) {
  const dir = path.dirname(fileStoragePath)
  await fs.ensureDir(dir)
}

/**
 * Given an input stream and a destination file path, this function writes the contents
 * of the stream to disk at expectedStoragePath
 * @param {stream} inputStream Stream to persist to disk
 * @param {String} expectedStoragePath path in local file system to store. includes the file name
 * @param {Boolean?} createDir if true, will ensure the expectedStoragePath path exists so we don't have errors from folders missing
 */
async function writeStreamToFileSystem(
  inputStream,
  expectedStoragePath,
  createDir = false
) {
  if (createDir) {
    await createDirForFile(expectedStoragePath)
  }

  await _streamFileToDiskHelper(inputStream, expectedStoragePath)
}

/**
 * Cleaner way to handle piping data between streams since this handles all
 * events such as finish, error, end etc in addition to being async/awaited
 * @param {stream} inputStream Stream to persist to disk
 * @param {String} expectedStoragePath path in local file system to store
 */
async function _streamFileToDiskHelper(inputStream, expectedStoragePath) {
  // https://nodejs.org/en/docs/guides/backpressuring-in-streams/
  await pipeline(
    inputStream, // input stream
    fs.createWriteStream(expectedStoragePath) // output stream
  )
}

/**
 * Generic function to run shell commands, eg `ls -alh`
 * @param {String} command Command you want to execute from the shell eg `ls`
 * @param {Array} args array of string quoted arguments to pass eg ['-alh']
 * @param {Object} logger logger object with context
 */
async function runShellCommand(command, args, logger) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (data) => (stdout += data.toString()))
    proc.stderr.on('data', (data) => (stderr += data.toString()))

    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(
          `Successfully executed command ${command} ${args} with output: \n${stdout}`
        )
        resolve()
      } else {
        logger.error(
          `Error while executing command ${command} ${args} with stdout: \n${stdout}, \nstderr: \n${stderr}`
        )
        reject(new Error(`Error while executing command ${command} ${args}`))
      }
    })
  })
}

/**
 * A current node should handle a track transcode if there is enough room in the TranscodingQueue to accept more jobs
 *
 * If there is not enough room, if
 * 1. The spID is not set after app init, and
 * 2. AsyncProcessingQueue libs instance is not initialized,
 * then the current node should still take in the transcode task
 * @param {Object} param
 * @param {boolean} param.transcodingQueueCanAcceptMoreJobs flag to determine if TranscodingQueue can accept more jobs
 * @param {number} param.spID the spID of the current node
 * @param {Object} param.libs the libs instance in AsyncProcessingQueue
 * @returns whether or not the current node can handle the transcode
 */
function currentNodeShouldHandleTranscode({
  transcodingQueueCanAcceptMoreJobs,
  spID,
  libs
}) {
  // If the TranscodingQueue is available, let current node handle transcode
  if (transcodingQueueCanAcceptMoreJobs) return true

  // Else, if spID and libs are not initialized, the track cannot be handed off to another node to transcode.
  // Continue with the upload on the current node.
  const currentNodeSPIdIsInitialized = Number.isInteger(spID)
  const libsInstanceIsInitialized = libs !== null && libs !== undefined

  const currentNodeShouldHandleTranscode = !(
    currentNodeSPIdIsInitialized && libsInstanceIsInitialized
  )

  return currentNodeShouldHandleTranscode
}

/**
 * Wrapper around async-retry API.
 *
 * options described here https://github.com/tim-kos/node-retry#retrytimeoutsoptions
 * @param {Object} param
 * @param {func} param.asyncFn the fn to asynchronously retry
 * @param {Object} param.asyncFnParams the params to pass into the fn. takes in 1 object
 * @param {string} param.asyncFnTask the task label used to print on retry. used for debugging purposes
 * @param {number} param.factor the exponential factor
 * @param {number} [retries=5] the max number of retries. defaulted to 5
 * @param {number} [minTimeout=1000] minimum time to wait after first retry. defaulted to 1000ms
 * @param {number} [maxTimeout=5000] maximum time to wait after first retry. defaulted to 5000ms
 * @returns the fn response if success, or throws an error
 */
function asyncRetry({
  asyncFn,
  asyncFnParams,
  asyncFnTask,
  retries = 5,
  factor = 2, // default for async-retry
  minTimeout = 1000, // default for async-retry
  maxTimeout = 5000
}) {
  return retry(
    async () => {
      if (asyncFnParams) {
        return asyncFn(asyncFnParams)
      }

      return asyncFn()
    },
    {
      retries,
      factor,
      minTimeout,
      maxTimeout,
      onRetry: (err, i) => {
        if (err) {
          console.log(`${asyncFnTask} ${i} retry error: `, err)
        }
      }
    }
  )
}

module.exports = Utils
module.exports.validateStateForImageDirCIDAndReturnFileUUID =
  validateStateForImageDirCIDAndReturnFileUUID
module.exports.getIPFSPeerId = getIPFSPeerId
module.exports.ipfsSingleByteCat = ipfsSingleByteCat
module.exports.ipfsCat = ipfsCat
module.exports.ipfsGet = ipfsGet
module.exports.writeStreamToFileSystem = writeStreamToFileSystem
module.exports.getAllRegisteredCNodes = getAllRegisteredCNodes
module.exports.findCIDInNetwork = findCIDInNetwork
module.exports.runShellCommand = runShellCommand
module.exports.currentNodeShouldHandleTranscode =
  currentNodeShouldHandleTranscode
module.exports.asyncRetry = asyncRetry
