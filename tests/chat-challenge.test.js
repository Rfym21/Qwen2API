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
  response: typeof upstreamFrames === 'function' ? upstreamFrames() : Readable.from(upstreamFrames),
  currentAccount: null,
  contextPrefixReused: true
})
requestModule.invalidateContextPrefix = key => { invalidatedPrefixes.push(key) }
const { handleAnthropicMessages } = require('../src/controllers/anthropic')
const { handleNonStreamResponse, handleStreamResponse } = require('../src/controllers/chat')
const { parseUpstreamImageError, handleImageVideoCompletion } = require('../src/controllers/chat.image.video')

// The only frame Qwen sent on every chat challenge in prod, 2026-09-23..26 (477 of 502 sends).
const busy = { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'] }
// The slider captcha of upstream #157: no "被挤爆", a punish URL instead.
const captcha = { ret: ['FAIL_SYS_USER_VALIDATE'], data: { url: 'https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5secdata=x&action=captchaconnect' } }
const answer = { choices: [{ delta: { phase: 'answer', content: '你好' }, finish_reason: null }] }
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const caught = fn => { try { fn() } catch (error) { return error } return null }
const strike = (times = 1) => { for (let n = 0; n < times; n += 1) caught(() => assertNoUpstreamFailure(busy)) }
const breakerOpen = () => caught(assertChatChallengeBreakerClosed) !== null
const settle = async (rounds = 25) => { for (let n = 0; n < rounds; n += 1) await new Promise(resolve => setImmediate(resolve)) }
const events = output => String(output).split('\n\n').map(block => /(?:^|\n)event: (.+)/.exec(block)?.[1]).filter(Boolean)
const created = { 'response.created': { chat_id: 'c1', parent_id: 'p1', response_id: 'r1', response_index: '0' } }
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }
/** Yields `head`, then waits until released, then yields `tail`. */
const gatedStream = (head, tail) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  return { stream: Readable.from((async function* () {
    for (const chunk of head) yield Buffer.from(chunk)
    await gate
    for (const chunk of tail) yield Buffer.from(chunk)
  })()), release }
}
const streamRequest = { body: {
  model: 'qwen3-max', max_tokens: 64, stream: true,
  metadata: { user_id: 'chat-challenge-session' },
  messages: [{ role: 'user', content: '你好' }]
} }

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
  assert.equal(caught(() => assertNoUpstreamFailure(busy)).retryAfter, 59, 'the third asks for the full cooldown, capped under 60')

  const blocked = caught(assertChatChallengeBreakerClosed)
  assert.ok(isWafChallengeError(blocked))
  assert.match(blocked.publicMessage, /requests paused/)
  assert.deepEqual(describeUpstreamFailure(blocked, 500),
    { rateLimited: false, overloaded: true, status: 529, retryAfter: 59 })
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
  assert.equal(caught(assertChatChallengeBreakerClosed).retryAfter, 59, 'the others wait for the probe')
  assertNoUpstreamFailure(answer)
  assert.equal(caught(assertChatChallengeBreakerClosed), null)
  assert.equal(caught(assertChatChallengeBreakerClosed), null, 'closed, not probing')
})

test('a challenged probe reopens the breaker for a full cooldown', () => {
  strike(3)
  now += 60_000
  assertChatChallengeBreakerClosed()
  assert.equal(caught(() => assertNoUpstreamFailure(busy)).retryAfter, 59)
  assert.equal(caught(assertChatChallengeBreakerClosed).retryAfter, 59)
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

test('/v1/messages stream: a challenge on the first frame is a real 529 with Retry-After, and one strike', async () => {
  upstreamFrames = [frame(busy)]
  const res = mockResponse()
  await handleAnthropicMessages(streamRequest, res)
  assert.equal(res.statusCode, 529)
  assert.equal(res.headers['Retry-After'], '30')
  assert.notEqual(res.headers['Content-Type'], 'text/event-stream', 'nothing was committed as SSE')
  assert.deepEqual(events(res.output), [], 'no message_start, no in-stream error event')
  assert.equal(JSON.parse(res.output).error.type, 'overloaded_error')
  strike(1)
  assert.equal(breakerOpen(), false, 'the request cost one strike, so two strikes keep it closed')
  strike(1)
  assert.equal(breakerOpen(), true)
})

test('/v1/messages stream commits on the first valid frame, without waiting for content', async () => {
  const { stream, release } = gatedStream([frame(created)], [frame(answer), frame(stop), 'data: [DONE]\n\n'])
  upstreamFrames = () => stream
  const res = mockResponse()
  const done = handleAnthropicMessages(streamRequest, res)
  await settle()
  assert.deepEqual(events(res.output), ['message_start'], 'committed on response.created')
  release()
  await done
  assert.equal(res.statusCode, 200)
  assert.ok(events(res.output).includes('message_stop'))
})

test('/v1/messages stream: the first ping caps the wait, and a later challenge is an in-stream event', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { stream, release } = gatedStream([], [frame(busy)])
  upstreamFrames = () => stream
  const res = mockResponse()
  const done = handleAnthropicMessages(streamRequest, res)
  await settle()
  assert.equal(res.output, '', 'nothing before the cap')
  t.mock.timers.tick(15000)
  assert.deepEqual(events(res.output), ['message_start', 'ping'], 'message_start always precedes a ping')
  release()
  await done
  assert.equal(res.statusCode, 200)
  const error = String(res.output).split('\n\n').find(block => block.includes('event: error'))
  const payload = JSON.parse(/data: (.+)/.exec(error)[1])
  assert.equal(payload.error.type, 'overloaded_error')
  assert.equal(payload.error.retry_after, 30)
})

test('/v1/messages stream: any other first-frame failure still commits and goes out in the stream', async () => {
  upstreamFrames = [frame({ success: false, data: { code: 'Bad_Request', details: 'roto' } })]
  const res = mockResponse()
  await handleAnthropicMessages(streamRequest, res)
  assert.equal(res.statusCode, 200, 'not turned into a 5xx that SDKs retry against upload/parse')
  assert.deepEqual(events(res.output), ['message_start', 'error'])
})

test('image stream with the breaker open answers 503 + Retry-After before touching Qwen', async () => {
  const realPost = axios.post
  axios.post = async () => assert.fail('an open breaker must not reach Qwen')
  try {
    strike(3)
    const res = mockResponse()
    await handleImageVideoCompletion({ body: {
      stream: true, chat_type: 't2i', model: 'qwen3-max', messages: [{ role: 'user', content: 'a cat' }]
    } }, res)
    assert.equal(res.statusCode, 503)
    assert.equal(res.headers['Retry-After'], '59', 'the 60 s window, capped under the SDK limit')
    assert.equal(JSON.parse(res.output).code, 'upstream_waf_challenge')
  } finally {
    axios.post = realPost
  }
})

test('/v1/messages stream: an attempt with no JSON frames still commits before the turn is settled', async () => {
  upstreamFrames = ['data: [DONE]\n\n']
  const res = mockResponse()
  await handleAnthropicMessages(streamRequest, res)
  assert.equal(res.statusCode, 200, 'an empty turn is not a first-frame challenge: it stays in the stream')
  const names = events(res.output)
  assert.equal(names[0], 'message_start')
  assert.ok(['message_stop', 'error'].includes(names.at(-1)), `closed in-protocol, got ${names.at(-1)}`)
})

test('video stream (SSE headers preset) with the breaker open answers 503 as JSON', async () => {
  const realPost = axios.post
  axios.post = async () => assert.fail('an open breaker must not reach Qwen')
  try {
    strike(3)
    const res = mockResponse()
    await handleImageVideoCompletion({ body: {
      stream: true, chat_type: 't2v', model: 'qwen3-max', messages: [{ role: 'user', content: 'a cat' }]
    } }, res)
    assert.equal(res.statusCode, 503)
    assert.equal(res.headers['Content-Type'], 'application/json', 't2v preset text/event-stream before the flow')
    assert.equal(res.headers['Retry-After'], '59')
  } finally {
    axios.post = realPost
  }
})

const AGENT = { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'], agent_turn_max_attempts: 1 }
const agentChunks = output => String(output).split('\n\n').filter(block => block.startsWith('data: {')).map(block => JSON.parse(block.slice(6)))

test('agent stream: any other first-frame failure still commits and goes out as an error frame', async () => {
  const res = mockResponse()
  await handleStreamResponse(res, Readable.from([frame({ success: false, data: { code: 'Bad_Request', details: 'roto' } })]),
    false, false, { messages: [] }, AGENT)
  assert.equal(res.statusCode, 200, 'not turned into a 5xx that SDKs retry against upload/parse')
  const chunks = agentChunks(res.output)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.ok(chunks.some(chunk => chunk.error), 'the failure is an in-stream error frame')
})

test('agent stream: a turn that ends without output still commits before its error frame', async () => {
  const res = mockResponse()
  await handleStreamResponse(res, Readable.from(['data: [DONE]\n\n']), false, false, { messages: [] }, AGENT)
  assert.equal(res.statusCode, 200)
  const chunks = agentChunks(res.output)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.match(res.output, /data: \[DONE\]|"error"/)
})

test('agent stream: the SSE heartbeat commits the role chunk before its keepalive', async () => {
  const { stream, release } = gatedStream([], [frame(busy)])
  const res = mockResponse()
  const done = handleStreamResponse(res, stream, false, false, { messages: [] }, { ...AGENT, agent_processing_heartbeat_ms: 5 })
  await new Promise(resolve => setTimeout(resolve, 40))
  const role = res.output.indexOf('"role":"assistant"')
  const keepalive = res.output.indexOf(': qwen2api-agent-keepalive')
  assert.ok(role >= 0 && keepalive > role, 'role chunk first, then the keepalive comment')
  release()
  await done
  assert.equal(res.statusCode, 200, 'committed by the heartbeat: the challenge goes out in the stream')
  assert.ok(agentChunks(res.output).some(chunk => chunk.error?.code === 'upstream_unavailable'))
})

test('image and video generation map a chat challenge to a retryable 503', () => {
  assert.deepEqual(parseUpstreamImageError(JSON.stringify(busy)), {
    error: caught(() => assertNoUpstreamFailure(busy)).publicMessage,
    code: 'upstream_waf_challenge',
    status: 503,
    retry_after: 30
  })
})
