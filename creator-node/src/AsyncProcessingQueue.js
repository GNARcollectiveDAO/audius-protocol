const Bull = require('bull')
const { logger: genericLogger } = require('./logging')
const config = require('./config')
const redisClient = require('./redis')

// Processing fns
const {
  handleTrackContentRoute: trackContentUpload,
  handleTranscodeAndSegment: transcodeAndSegment
} = require('./components/tracks/tracksComponentService')
const {
  processTranscodeAndSegments
} = require('./components/tracks/trackHandlingUtils')

const MAX_CONCURRENCY = 100
const EXPIRATION = 86400 // 24 hours in seconds
const PROCESS_NAMES = Object.freeze({
  trackContentUpload: 'trackContentUpload',
  transcodeAndSegment: 'transcodeAndSegment',
  processTranscodeAndSegments: 'processTranscodeAndSegments'
})
const PROCESS_STATES = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  FAILED: 'FAILED'
})

class AsyncProcessingQueue {
  constructor() {
    this.queue = new Bull('fileProcessing', {
      redis: {
        host: config.get('redisHost'),
        port: config.get('redisPort')
      },
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true
      }
    })

    this.queue.process(MAX_CONCURRENCY, async (job, done) => {
      const { logContext, task } = job.data

      const func = this.getFn(task)

      try {
        const response = await this.monitorProgress(task, func, job.data)
        done(null, { response })
      } catch (e) {
        this.logError(
          `Could not process taskType=${task} uuid=${
            logContext.requestID
          }: ${e.toString()}`,
          logContext
        )
        done(e.toString())
      }
    })

    this.getAsyncProcessingQueueJobs =
      this.getAsyncProcessingQueueJobs.bind(this)
    this.constructProcessKey = this.constructProcessKey.bind(this)

    this.PROCESS_NAMES = PROCESS_NAMES
    this.PROCESS_STATES = PROCESS_STATES
  }

  async logStatus(message, logContext = {}) {
    const logger = genericLogger.child(logContext)
    const { waiting, active, completed, failed, delayed } =
      await this.queue.getJobCounts()
    logger.info(
      `AsyncProcessingQueue: ${message} || active: ${active}, waiting: ${waiting}, failed ${failed}, delayed: ${delayed}, completed: ${completed} `
    )
  }

  async logError(message, logContext = {}) {
    const logger = genericLogger.child(logContext)
    const { waiting, active, completed, failed, delayed } =
      await this.queue.getJobCounts()
    logger.error(
      `AsyncProcessingQueue error: ${message} || active: ${active}, waiting: ${waiting}, failed ${failed}, delayed: ${delayed}, completed: ${completed}`
    )
  }

  // TODO: Make these jobs a background process

  async addTrackContentUploadTask(params) {
    params.task = PROCESS_NAMES.trackContentUpload
    return this.addTask(params)
  }

  async addTranscodeAndSegmentTask(params) {
    params.task = PROCESS_NAMES.transcodeAndSegment
    return this.addTask(params)
  }

  async addProcessTranscodeAndSegmentTask(params) {
    params.task = PROCESS_NAMES.processTranscodeAndSegments
    return this.addTask(params)
  }

  async addTask(params) {
    const { logContext, task } = params

    this.logStatus(
      `Adding ${task} task! uuid=${logContext.requestID}}`,
      logContext
    )

    const job = await this.queue.add(params)

    return job
  }

  /**
   * Depending on the task type, return the processing fn.
   *
   * @dev if this file gets any bigger, we should consider a factory class
   * @param {string} task a process in PROCESS_NAMES
   * @returns the processing fn
   */
  getFn(task) {
    switch (task) {
      case PROCESS_NAMES.trackContentUpload:
        return trackContentUpload
      case PROCESS_NAMES.transcodeAndSegment:
        return transcodeAndSegment
      case PROCESS_NAMES.processTranscodeAndSegments:
        return processTranscodeAndSegments
      default:
        return null
    }
  }

  /**
   * Processes the input function and adds the response to redis.
   * @param {string} task a process in PROCESS_NAMES
   * @param {function} func the processing fn
   * @param {Object} param
   * @param {Object} param.logContext
   * @param {Object} param.req the request associated with the func
   * @returns the expected response from the func
   */
  async monitorProgress(task, func, { logContext, req }) {
    const uuid = logContext.requestID
    const redisKey = this.constructProcessKey(task, uuid)

    let state = { status: PROCESS_STATES.IN_PROGRESS }
    this.logStatus(`Starting ${task}, uuid=${uuid}`, logContext)
    await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)

    let response
    try {
      response = await func({ logContext }, req)
      state = { status: PROCESS_STATES.DONE, resp: response }
      this.logStatus(`Successful ${task}, uuid=${uuid}`, logContext)
      await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)
    } catch (e) {
      state = { status: PROCESS_STATES.FAILED, resp: e.message }
      this.logError(
        `Error with ${task}. uuid=${uuid}} resp=${JSON.stringify(e.message)}`,
        logContext
      )
      await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)
      throw e
    }

    return response
  }

  async getAsyncProcessingQueueJobs() {
    const queue = this.queue
    const [waiting, active] = await Promise.all([
      queue.getJobs(['waiting']),
      queue.getJobs(['active'])
    ])
    return {
      waiting: waiting.length,
      active: active.length
    }
  }

  constructProcessKey(taskType, uuid) {
    return `${taskType}:::${uuid}`
  }
}

module.exports = AsyncProcessingQueue