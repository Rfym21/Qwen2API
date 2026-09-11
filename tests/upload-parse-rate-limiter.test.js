// Limitador de ritmo de /api/v2/files/parse (src/utils/upload.js).
//
// Observado 2026-09-10 12:28-12:31 (qwen-next, IP 37.27.12.92): diez upload+parse en
// 150 s (un turno de Claude Code cada ~15 s) y el WAF de Aliyun empieza a desafiar el
// parse; ~1/hora nunca lo hace. El breaker solo actua DESPUES del desafio y bloquea
// 300 s. Aqui el hueco se reserva ANTES de tocar STS/OSS/parse y, si no hay, sale un
// 529 inmediato con Retry-After corto para que el cliente se autorregule.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'
process.env.AGENT_PARSE_BREAKER_SECONDS = '120'
process.env.AGENT_PARSE_MAX_PER_WINDOW = '3'
process.env.AGENT_PARSE_WINDOW_SECONDS = '60'

const axiosPath = require.resolve('axios')
const calls = []
const axiosStub = {
  post: async (url) => { calls.push(url); throw new Error(`unexpected axios.post ${url}`) },
  get: async (url) => { calls.push(url); throw new Error(`unexpected axios.get ${url}`) },
  create () { return axiosStub },
  defaults: { headers: { common: {} } },
  isAxiosError: () => false
}
axiosStub.default = axiosStub
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub }

const config = require('../src/config/index.js')
const {
  uploadAgentContextFile,
  resetParseBreaker,
  noteParseOutcome,
  assertParseBreakerClosed,
  takeParseSlot,
  resetParseRateLimiter,
  setParseClockForTests
} = require('../src/utils/upload.js')
const { ContextExternalizationError } = require('../src/utils/upstream-error.js')

let now = 1_000_000_000
setParseClockForTests(() => now)

test.after(() => {
  setParseClockForTests(null)
  try { require('../src/utils/account.js').destroy() } catch (_) { /* no cargado */ }
})

const fresh = () => {
  resetParseBreaker()
  resetParseRateLimiter()
  calls.length = 0
  config.agentParseMaxPerWindow = 3
  config.agentParseWindowSeconds = 60
}

const limited = () => {
  try {
    takeParseSlot()
  } catch (error) {
    return error
  }
  throw new Error('takeParseSlot must throw when the window is full')
}

test('MAX attempts pass, the next one is rejected before any upstream call', () => {
  fresh()
  takeParseSlot()
  takeParseSlot()
  takeParseSlot()
  const error = limited()
  assert.equal(error.code, 'qwen_parse_rate_limited')
  assert.equal(error.parseCode, 'PARSE_RATE_LIMITED')
  assert.equal(error.breakerOpen, false)
  assert.match(error.message, /解析服务失败/)
  assert.match(error.message, /PARSE_RATE_LIMITED/)
  assert.ok(error.retryAfterSeconds >= 5 && error.retryAfterSeconds <= 20, `retryAfter ${error.retryAfterSeconds}`)
  assert.equal(calls.length, 0)
})

test('uploadAgentContextFile with a full window rejects without STS/OSS/parse traffic', async () => {
  fresh()
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  await assert.rejects(
    uploadAgentContextFile('hello', 'token', {}),
    (error) => error.code === 'qwen_parse_rate_limited' && error.breakerOpen === false
  )
  assert.equal(calls.length, 0)
})

test('the window frees once WINDOW seconds have elapsed', () => {
  fresh()
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  limited()
  now += 59_000
  limited()
  now += 1_000
  assert.doesNotThrow(() => takeParseSlot())
})

test('Retry-After is clamped to [5, 20] seconds', () => {
  fresh()
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  assert.equal(limited().retryAfterSeconds, 20) // 60 s until the oldest slot frees
  now += 59_000
  assert.equal(limited().retryAfterSeconds, 5) // 1 s until free, floor 5
})

test('MAX = 0 disables the limiter', () => {
  fresh()
  config.agentParseMaxPerWindow = 0
  for (let i = 0; i < 20; i++) assert.doesNotThrow(() => takeParseSlot())
})

test('an open breaker wins over the limiter and the rejection keeps breakerOpen=true', async () => {
  fresh()
  const waf = () => Object.assign(new Error('WAF'), { code: 'qwen_parse_waf_challenge', parseCode: 'WAF_CAPTCHA' })
  noteParseOutcome(waf()); noteParseOutcome(waf()); noteParseOutcome(waf())
  await assert.rejects(
    uploadAgentContextFile('hello', 'token', {}),
    (error) => error.breakerOpen === true && error.parseCode === 'WAF_CAPTCHA'
  )
  assert.equal(calls.length, 0)
  resetParseBreaker()
  // el rechazo del breaker no consumio huecos de la ventana
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  limited()
})

test('limited attempts never count as WAF strikes', () => {
  fresh()
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  limited(); limited(); limited(); limited()
  assert.doesNotThrow(() => assertParseBreakerClosed())
})

test('ContextExternalizationError maps the limiter to its own public message and Retry-After', () => {
  fresh()
  takeParseSlot(); takeParseSlot(); takeParseSlot()
  const wrapped = new ContextExternalizationError(limited())
  assert.equal(wrapped.publicMessage, 'Upstream document parse rate limit reached; retry shortly')
  assert.equal(wrapped.retryAfter, 20)
  const waf = new ContextExternalizationError(Object.assign(new Error('x'), { parseCode: 'WAF_CAPTCHA' }))
  assert.equal(waf.publicMessage, 'Upstream WAF is challenging document parse; retry shortly')
  const plain = new ContextExternalizationError(new Error('down'))
  assert.equal(plain.publicMessage, 'Upstream document parse unavailable; retry shortly')
})
