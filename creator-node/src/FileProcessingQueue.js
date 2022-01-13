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
  processTrackTranscodeAndSegments
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

function constructProcessKey(taskType, uuid) {
  return `${taskType}:::${uuid}`
}

class FileProcessingQueue {
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

    this.queue.process(
      PROCESS_NAMES.trackContentUpload,
      MAX_CONCURRENCY,
      async (job, done) => {
        const { trackContentUploadParams } = job.data

        try {
          const response = await this.monitorProgress(
            PROCESS_NAMES.trackContentUpload,
            trackContentUpload,
            trackContentUploadParams
          )
          done(null, { response })
        } catch (e) {
          this.logError(
            trackContentUploadParams.logContext,
            `Could not process taskType=${
              PROCESS_NAMES.trackContentUpload
            } uuid=${
              trackContentUploadParams.logContext.requestID
            }: ${e.toString()}`
          )
          done(e.toString())
        }
      }
    )

    this.queue.process(
      PROCESS_NAMES.transcodeAndSegment,
      MAX_CONCURRENCY,
      async (job, done) => {
        const { trackContentUploadParams } = job.data

        try {
          const response = await this.monitorProgress(
            PROCESS_NAMES.trackContentUpload,
            trackContentUpload,
            trackContentUploadParams
          )
          done(null, { response })
        } catch (e) {
          this.logError(
            trackContentUploadParams.logContext,
            `Could not process taskType=${
              PROCESS_NAMES.trackContentUpload
            } uuid=${
              trackContentUploadParams.logContext.requestID
            }: ${e.toString()}`
          )
          done(e.toString())
        }
      }
    )

    this.getFileProcessingQueueJobs = this.getFileProcessingQueueJobs.bind(this)
  }

  async logStatus(message, logContext = {}) {
    const logger = genericLogger.child(logContext)
    const { waiting, active, completed, failed, delayed } =
      await this.queue.getJobCounts()
    logger.info(
      `FileProcessingQueue: ${message} || active: ${active}, waiting: ${waiting}, failed ${failed}, delayed: ${delayed}, completed: ${completed} `
    )
  }

  async logError(message, logContext = {}) {
    const logger = genericLogger.child(logContext)
    const { waiting, active, completed, failed, delayed } =
      await this.queue.getJobCounts()
    logger.error(
      `FileProcessingQueue error: ${message} || active: ${active}, waiting: ${waiting}, failed ${failed}, delayed: ${delayed}, completed: ${completed}`
    )
  }

  // TODO: Will make this job a background process
  async addTrackContentUploadTask(trackContentUploadParams) {
    return this.addTask(
      PROCESS_NAMES.trackContentUpload,
      trackContentUploadParams
    )
  }

  async addTranscodeAndSegmentTask(transcodeAndSegmentParams) {
    return this.addTask(
      PROCESS_NAMES.transcodeAndSegment,
      transcodeAndSegmentParams
    )
  }

  async addProcessTranscodeAndSegmentTask(processTranscodeAndSegmentsParams) {
    return this.addTask(
      PROCESS_NAMES.processTranscodeAndSegments,
      processTranscodeAndSegmentsParams
    )
  }

  async monitorProgress(taskType, func, { logContext, req }) {
    const uuid = logContext.requestID
    const redisKey = constructProcessKey(taskType, uuid)

    let state = { status: PROCESS_STATES.IN_PROGRESS }
    this.logStatus(`Starting ${taskType}, uuid=${uuid}`, logContext)
    await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)

    let response
    try {
      response = await func({ logContext }, req)
      state = { status: PROCESS_STATES.DONE, resp: response }
      this.logStatus(`Successful ${taskType}, uuid=${uuid}`, logContext)
      await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)
    } catch (e) {
      state = { status: PROCESS_STATES.FAILED, resp: e.message }
      this.logError(
        `Error with ${taskType}. uuid=${uuid}} resp=${JSON.stringify(
          e.message
        )}`,
        logContext
      )
      await redisClient.set(redisKey, JSON.stringify(state), 'EX', EXPIRATION)
      throw e
    }

    return response
  }

  async getFileProcessingQueueJobs() {
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

  async addTask(task, params) {
    const { logContext } = params
    this.logStatus(
      logContext,
      `Adding ${task} task! uuid=${logContext.requestID}}`
    )

    const job = await this.queue.add(task, params)

    return job
  }
}

module.exports = {
  FileProcessingQueue: new FileProcessingQueue(),
  PROCESS_NAMES,
  constructProcessKey
}
