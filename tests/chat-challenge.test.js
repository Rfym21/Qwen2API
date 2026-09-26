const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const axios = require('axios')

process.env.API_KEY = 'chat-challenge-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const requestModule = require('../src/utils/request')
// The real one, captured before the controllers below get a stub through the require cache.
const { sendChatRequest } = requestModule
const {
  assertNoUpstreamFailure,
  assertChatChallengeBreakerClosed,
  resetChatChallengeBreaker,
  setChatChallengeClockForTests,
  describeUpstreamFailure,
  isWafChallengeError,
  isRateLimitError
} = require('../src/utils/upstream-error')

let upstreamFrames = []
const invalidatedPrefixes = []
requestModule.sendChatRequest = async () => ({
  status: true,
  response: Readable.from(upstreamFrames),
  currentAccount: null,
  contextPrefixReused: true
})
requestModule.invalidateContextPrefix = key => { invalidatedPrefixes.push(key) }
const { handleAnthropicMessages } = require('../src/controllers/anthropic')
const { handleNonStreamResponse } = require('../src/controllers/chat')
const { parseUpstreamImageError } = require('../src/controllers/chat.image.video')

// The only frame Qwen sent on every chat challenge in prod, 2026-09-23..26 (477 of 502 sends).
const busy = { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'] }
// The slider captcha of upstream #157: no "被挤爆", a punish URL instead.
const captcha = { ret: ['FAIL_SYS_USER_VALIDATE'], data: { url: 'https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5secdata=x&action=captchaconnect' } }
const answer = { choices: [{ delta: { phase: 'answer', content: '你好' }, finish_reason: null }] }
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const caught = fn => { try { fn() } catch (error) { return error } return null }
const strike = (times = 1) => { for (let n = 0; n < times; n += 1) caught(() => assertNoUpstreamFailure(busy)) }

let now = 1_000_000
const mockResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers) { Object.assign(this.headers, headers); return this },
  setHeader(name, value) { this.headers[name] = value },
  write(chunk) { this.headersSent = true; this.output += String(chunk); return true },
  end(chunk = '') { if (chunk) this.write(chunk); this.writableEnded = true },
  status(code) { this.statusCode = code; return this },
  json(value) { this.headersSent = true; this.output += JSON.stringify(value); this.writableEnded = true; return this }
})

test.before(async () => {
  await accountManager._initPromise
  setChatChallengeClockForTests(() => now)
})
test.beforeEach(() => {
  resetChatChallengeBreaker()
  upstreamFrames = []
  invalidatedPrefixes.length = 0
})
test.after(() => {
  setChatChallengeClockForTests(null)
  accountManager.destroy()
})

test('a chat challenge is a retryable overload, not a 502/500, and blames neither context nor account', () => {
  const error = caught(() => assertNoUpstreamFailure(busy))
  assert.ok(isWafChallengeError(error) && !isRateLimitError(error))
  assert.match(error.publicMessage, /被挤爆啦.*upstream busy/)
  assert.doesNotMatch(error.publicMessage, /上下文|账号/)
  assert.deepEqual(describeUpstreamFailure(error, 500),
    { rateLimited: false, overloaded: true, status: 529, retryAfter: 30 })
  assert.equal(describeUpstreamFailure(error, 502, 503).status, 503)
})

test('a slider captcha is still a chat challenge, but is not reported as a busy upstream', () => {
  const error = caught(() => assertNoUpstreamFailure(captcha))
  assert.ok(isWafChallengeError(error))
  assert.match(error.publicMessage, /captcha required/)
  assert.doesNotMatch(error.publicMessage, /被挤爆|busy/)
})

test('three chat challenges in a row stop new requests before they reach Qwen', () => {
  strike(2)
  assert.equal(caught(assertChatChallengeBreakerClosed), null, 'two strikes keep it closed')
  assert.equal(caught(() => assertNoUpstreamFailure(busy)).retryAfter, 60, 'the third asks for the full cooldown')

  const blocked = caught(assertChatChallengeBreakerClosed)
  assert.ok(isWafChallengeError(blocked))
  assert.match(blocked.publicMessage, /requests paused/)
  assert.deepEqual(describeUpstreamFailure(blocked, 500),
    { rateLimited: false, overloaded: true, status: 529, retryAfter: 60 })
})

test('an answer from a stream already in flight does not close an open breaker', () => {
  strike(3)
  assertNoUpstreamFailure(answer)
  now += 30_000
  assert.equal(caught(assertChatChallengeBreakerClosed).retryAfter, 30, 'Retry-After is the time actually left')
})

test('after the cooldown exactly one probe goes out, and its answer closes the breaker', () => {
  strike(3)
  now += 60_000
  assert.equal(caught(assertChatChallengeBreakerClosed), null, 'the first request is the probe')
  assert.equal(caught(assertChatChallengeBreakerClosed).retryAfter, 60, 'the others wait for the probe')
  assertNoUpstreamFailure(answer)
  assert.equal(caught(assertChatChallengeBreakerClosed), null)
  assert.equal(caught(assertChatChallengeBreakerClosed), null, 'closed, not probing')
})

test('a challenged probe reopens the breaker for a full cooldown', () => {
  strike(3)
  now += 60_000
  assertChatChallengeBreakerClosed()
  assert.equal(caught(() => assertNoUpstreamFailure(busy)).retryAfter, 60)
  assert.equal(caught(assertChatChallengeBreakerClosed).retryAfter, 60)
})

test('sendChatRequest refuses while the breaker is open, before creating a chat or uploading history', async () => {
  const realPost = axios.post
  axios.post = async () => assert.fail('an open breaker must not reach Qwen')
  try {
    strike(3)
    await assert.rejects(
      sendChatRequest({ model: 'qwen3-max', messages: [{ role: 'user', content: '你好' }] },
        { currentAccount: { email: 'breaker@example.invalid', token: 'breaker-test-token' } }),
      error => isWafChallengeError(error) && describeUpstreamFailure(error, 500).status === 529
    )
  } finally {
    axios.post = realPost
  }
})

test('OpenAI non-stream answers a chat challenge with 503 upstream_unavailable and Retry-After', async () => {
  const res = mockResponse()
  await handleNonStreamResponse(res, Readable.from([frame(busy)]), false, false, 'qwen3-max', { messages: [] }, {})
  assert.equal(res.statusCode, 503)
  assert.equal(res.headers['Retry-After'], '30')
  const body = JSON.parse(res.output)
  assert.equal(body.error.code, 'upstream_unavailable')
  assert.match(body.error.message, /upstream busy/)
})

test('/v1/messages keeps a reused history prefix on a chat challenge, and still forgets it on other upstream errors', async () => {
  const request = { body: {
    model: 'qwen3-max', max_tokens: 64, stream: false,
    metadata: { user_id: 'chat-challenge-session' },
    messages: [{ role: 'user', content: '你好' }]
  } }

  upstreamFrames = [frame(busy)]
  const challenged = mockResponse()
  await handleAnthropicMessages(request, challenged)
  assert.equal(challenged.statusCode, 529)
  assert.deepEqual(invalidatedPrefixes, [], 'Qwen refused before reading the prefix: re-parsing it helps nobody')

  upstreamFrames = [frame({ success: false, data: { code: 'Bad_Request', details: 'bad file' } })]
  await handleAnthropicMessages(request, mockResponse())
  assert.equal(invalidatedPrefixes.length, 1, 'any other upstream error may be the stale prefix')
})

test('image and video generation map a chat challenge to a retryable 503', () => {
  assert.deepEqual(parseUpstreamImageError(JSON.stringify(busy)), {
    error: caught(() => assertNoUpstreamFailure(busy)).publicMessage,
    code: 'upstream_waf_challenge',
    status: 503,
    retry_after: 30
  })
})
