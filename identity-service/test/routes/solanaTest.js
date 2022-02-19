const request = require('supertest')
const assert = require('assert')
const sinon = require('sinon')

const config = require('../../src/config')
const { getApp } = require('../lib/app')

const { sendInstruction, createUserBankInstruction } = require('../lib/instructionMocks')
const relayHelpers = require('../../src/utils/relayHelpers')

describe('test Solana util functions', function () {
  it('isSendInstruction', function () {
    assert(relayHelpers.isSendInstruction(sendInstruction))
    assert(!relayHelpers.isSendInstruction(createUserBankInstruction))
  })
})

describe('test Solana relay route without social verification', function () {
  let app, server, sandbox
  beforeEach(async () => {
    config.set('sentryDSN', '')
    sandbox = sinon.createSandbox()
    const appInfo = await getApp(null, null)
    app = appInfo.app
    server = appInfo.server
    sandbox.stub(relayHelpers, 'doesUserHaveSocialProof').resolves(false)
  })
  afterEach(async () => {
    sandbox.restore()
    await server.close()
  })

  it('responds 400 when relaying a send instruction without social verification', function (done) {
    request(app)
      .post('/solana/relay')
      .send({
        instructions: sendInstruction,
        skipPreflight: false,
        feePayerOverride: null
      })
      .expect(400, done)
  })
})
