// Failover por cuenta cuando el upstream se cae ANTES del primer bloque de contenido.
//
// Medido en qwen-next el 2026-09-16: 3 de 70 peticiones terminaron en
// `UND_ERR_SOCKET: other side closed` a mitad del SSE y 1 en `RateLimited` en el primer
// frame. Las cuatro salieron al cliente como error a medio stream aunque todavia no habia
// visto nada. Con cero content_block emitidos reenviar es seguro (no duplica texto), asi
// que el handler sortea otra cuenta y sigue; con uno ya en el cable, el error sale como
// siempre y el cliente reintenta el.
// Misma cabecera que tests/agent-account-failover.test.js: sin API_KEY el arranque corta el
// proceso antes de que el runner reporte, y sin DATA_SAVE_MODE=none account.js intentaria
// un login real al importarse.
process.env.API_KEY = 'midstream-failover-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const accountManager = require('../src/utils/account')
const { handleAnthropicStream } = require('../src/controllers/anthropic.js')
const { isTransportInterruption } = require('../src/utils/upstream-error.js')
const { isRetryableNetworkError } = require('../src/utils/request.js')

after(() => { accountManager.destroy() })

const createMockResponse = () => ({
  output: '',
  headers: {},
  writableEnded: false,
  destroyed: false,
  set(headers) { Object.assign(this.headers, headers); return this },
  status() { return this },
  write(chunk) { this.output += String(chunk); return true },
  end(chunk = '') { this.output += String(chunk); this.writableEnded = true }
})

const frame = (content) =>
  `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })}\n\n`
const DONE = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
// El paquete real de cuota (tests/upstream-quota-429.test.js lo fija).
const QUOTA = `data: ${JSON.stringify({
  success: false,
  data: { code: 'RateLimited', details: "You've reached the upper limit for today's usage." }
})}\n\n`

const socketClose = () => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
const streamOf = (chunks, failure = null) => Readable.from((async function* () {
  for (const chunk of chunks) yield chunk
  if (failure) throw failure
})())

const emittedText = (output) =>
  [...output.matchAll(/"type":"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map(m => JSON.parse(m[1])).join('')
const errorEvents = (output) => output.match(/^event: error$/gm) || []

const FIRST = { email: 'first@example.com', proxy: 'socks5h://lohari-warp-qwen:9091' }
const SECOND = { email: 'second@example.com', proxy: 'socks5h://lohari-warp-qwen:9091' }

const recordingSendRequest = (respond) => {
  const calls = []
  const fn = async (body, options) => {
    calls.push({ body, options })
    return respond(calls.length)
  }
  fn.calls = calls
  return fn
}
const recovered = () => ({ status: true, response: streamOf([frame('Recovered.'), DONE]), currentAccount: { ...SECOND } })

const ctxFor = (sendRequest, overrides = {}) => ({
  message_id: 'msg_failover',
  model: 'qwen-test',
  hasTools: false,
  toolChoice: 'auto',
  requestBody: { messages: [{ role: 'user', content: 'hola' }] },
  currentAccount: { ...FIRST },
  upstreamOptions: { allowContextCompaction: true, contextPrefixKey: 'session-k1' },
  sendRequest,
  ...overrides
})

describe('mid-stream failover before the first content block', () => {
  it('a socket close with nothing emitted is served by another account, transparently', async () => {
    const sendRequest = recordingSendRequest(() => recovered())
    const res = createMockResponse()
    const ctx = ctxFor(sendRequest)

    await handleAnthropicStream(res, ctx, streamOf([], socketClose()))

    assert.equal(emittedText(res.output), 'Recovered.')
    assert.equal(errorEvents(res.output).length, 0, 'the client never sees the failure')
    assert.match(res.output, /event: message_stop/)
    assert.equal(sendRequest.calls.length, 1)
    const [{ body, options }] = sendRequest.calls
    assert.deepEqual(body, ctx.requestBody, 'the same internal body is replayed, no hint appended')
    assert.deepEqual(options.excludeEmails, ['first@example.com'], 'the account that failed is skipped')
    assert.equal(options.contextPrefixKey, 'session-k1', 'the uploaded history prefix is reused, not re-parsed')
    assert.equal(options.allowContextCompaction, true)
    assert.equal(ctx.currentAccount.email, 'second@example.com', 'stats and later 429s go to who actually served')
  })

  it('a RateLimited first frame rotates to another account instead of a 429 mid-stream', async () => {
    const sendRequest = recordingSendRequest(() => recovered())
    const res = createMockResponse()
    const ctx = ctxFor(sendRequest)

    await handleAnthropicStream(res, ctx, streamOf([QUOTA]))

    assert.equal(emittedText(res.output), 'Recovered.')
    assert.equal(errorEvents(res.output).length, 0)
    assert.equal(sendRequest.calls.length, 1)
    assert.deepEqual(sendRequest.calls[0].options.excludeEmails, ['first@example.com'])
    assert.equal(ctx.currentAccount.email, 'second@example.com')
  })

  it('a socket close AFTER a content block is delivered as an error: replaying would duplicate text', async () => {
    const sendRequest = recordingSendRequest(() => recovered())
    const res = createMockResponse()

    await assert.rejects(
      handleAnthropicStream(res, ctxFor(sendRequest), streamOf([frame('Half an ans')], socketClose())),
      (err) => err.code === 'UND_ERR_SOCKET' && err.failedAccountEmail === 'first@example.com'
    )
    assert.equal(sendRequest.calls.length, 0, 'no failover once the client has seen a block')
    assert.equal(emittedText(res.output), 'Half an ans', 'what was already sent stays sent')
  })

  it('only one failover per request: a second consecutive close propagates', async () => {
    const sendRequest = recordingSendRequest(() => ({
      status: true, response: streamOf([], socketClose()), currentAccount: { ...SECOND }
    }))
    const res = createMockResponse()

    await assert.rejects(
      handleAnthropicStream(res, ctxFor(sendRequest), streamOf([], socketClose())),
      (err) => err.code === 'UND_ERR_SOCKET'
        && err.failedAccountEmail === 'second@example.com'
    )
    assert.equal(sendRequest.calls.length, 1)
  })

  it('a failed replay surfaces the ORIGINAL failure when the retry carries no public message', async () => {
    const sendRequest = recordingSendRequest(() => ({ status: false, message: 'no account' }))
    const res = createMockResponse()

    await assert.rejects(
      handleAnthropicStream(res, ctxFor(sendRequest), streamOf([], socketClose())),
      (err) => err.code === 'UND_ERR_SOCKET'
    )
    assert.equal(sendRequest.calls.length, 1)
  })

  it('no failover when the client is already gone', async () => {
    const sendRequest = recordingSendRequest(() => recovered())
    const res = createMockResponse()
    res.destroyed = true

    await assert.rejects(
      handleAnthropicStream(res, ctxFor(sendRequest), streamOf([], socketClose())),
      (err) => err.code === 'UND_ERR_SOCKET'
    )
    assert.equal(sendRequest.calls.length, 0)
  })

  it('an unrelated error (a bug, not the transport) is not retried', async () => {
    const sendRequest = recordingSendRequest(() => recovered())
    const res = createMockResponse()
    const bug = new TypeError('cannot read properties of undefined')

    await assert.rejects(
      handleAnthropicStream(res, ctxFor(sendRequest), streamOf([], bug)),
      (err) => err === bug
    )
    assert.equal(sendRequest.calls.length, 0)
  })
})

describe('isTransportInterruption', () => {
  it('recognises socket closes and transport timeouts from Node, undici and streams', () => {
    for (const code of ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET',
      'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE']) {
      assert.equal(isTransportInterruption(Object.assign(new Error('x'), { code })), true, code)
    }
    assert.equal(isTransportInterruption(new Error('other side closed')), true, 'undici message without code')
    assert.equal(isTransportInterruption(new Error('socket hang up')), true)
    assert.equal(isTransportInterruption(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true, 'fetch wraps the code in cause')
  })

  it('never treats the client cancelling, an HTTP response, or a business error as a transport failure', () => {
    assert.equal(isTransportInterruption(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })), false)
    assert.equal(isTransportInterruption(Object.assign(new Error('aborted'), { name: 'AbortError' })), false)
    assert.equal(isTransportInterruption(Object.assign(new Error('other side closed'), { response: { status: 502 } })), false)
    assert.equal(isTransportInterruption(Object.assign(new Error('quota'), { code: 'RateLimited' })), false)
    assert.equal(isTransportInterruption(null), false)
    assert.equal(isTransportInterruption('ECONNRESET'), false)
  })
})

describe('isRetryableNetworkError (pre-response retry in sendRequest)', () => {
  it('is isTransportInterruption plus the two connect-phase codes, with the same exclusions', () => {
    for (const code of ['ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'EPIPE']) {
      assert.equal(isRetryableNetworkError(Object.assign(new Error('x'), { code })), true, code)
    }
    assert.equal(isRetryableNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true, 'connect code wrapped in cause')
    assert.equal(isRetryableNetworkError(new Error('socket hang up')), true)
    assert.equal(isRetryableNetworkError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED', response: { status: 502 } })), false, 'an HTTP response is never a network error')
    assert.equal(isRetryableNetworkError(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })), false)
    assert.equal(isRetryableNetworkError(Object.assign(new Error('quota'), { code: 'RateLimited' })), false)
    assert.equal(isRetryableNetworkError(null), false)
  })
})
