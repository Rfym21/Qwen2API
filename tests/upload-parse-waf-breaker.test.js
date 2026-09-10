// El WAF de Aliyun desafiando /api/v2/files/parse: HTML 200 en vez de JSON.
//
// Observado en vivo 2026-09-10 04:29-04:54 (probe desde el VPS, prod y qwen-next
// identicos): getstsToken y OSS bien, POST /files/parse devuelve la pagina
// `aliyun_waf_captcha` (16 KiB). Antes: 30 sondeos + "解析超时" falso, y con el cliente
// agentico reintentando cada 10 s, 20 turnos/5 min de upload+parse inutiles.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'
process.env.AGENT_PARSE_BREAKER_SECONDS = '120'

const axiosPath = require.resolve('axios')
const calls = []
let parseResponse = { data: { success: true, data: {} } }
const axiosStub = {
  post: async (url) => {
    calls.push(url)
    if (url.endsWith('/api/v2/files/parse')) return parseResponse
    if (url.endsWith('/api/v2/files/parse/status')) {
      return { data: { success: true, data: { list: [{ file_id: 'f1', status: 'success' }] } } }
    }
    throw new Error(`unexpected axios.post ${url}`)
  },
  get: async (url) => { throw new Error(`unexpected axios.get ${url}`) },
  create () { return axiosStub },
  defaults: { headers: { common: {} } },
  isAxiosError: () => false
}
axiosStub.default = axiosStub
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub }

const {
  parseUploadedTextFile,
  uploadAgentContextFile,
  resetParseBreaker,
  noteParseOutcome,
  assertParseBreakerClosed
} = require('../src/utils/upload.js')
const { ContextExternalizationError } = require('../src/utils/upstream-error.js')

test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* no cargado */ }
})

const WAF_HTML = '<!DOCTYPE html>\n<html><head><meta name="aliyun_waf_captcha" content="1"><title>验证</title></head><body>slide captcha</body></html>'
const wafResponse = () => ({ status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, data: WAF_HTML })
const statusCalls = () => calls.filter(url => url.endsWith('/files/parse/status')).length

const wafError = async () => {
  parseResponse = wafResponse()
  try {
    await parseUploadedTextFile('f1', 'token', {}, { intervalMs: 50, maxAttempts: 3 })
  } catch (error) {
    return error
  }
  throw new Error('parse must reject on WAF HTML')
}

test('parse POST answering the WAF captcha page fails at once with its own code', async () => {
  calls.length = 0
  const error = await wafError()
  assert.equal(error.code, 'qwen_parse_waf_challenge')
  assert.equal(error.parseCode, 'WAF_CAPTCHA')
  assert.match(error.message, /解析服务失败/)
  assert.match(error.message, /WAF_CAPTCHA/)
  assert.doesNotMatch(error.message, /超时/)
  assert.equal(statusCalls(), 0)
})

test('a non-JSON body without WAF markers still fails fast, under a different code', async () => {
  calls.length = 0
  parseResponse = { status: 200, headers: { 'content-type': 'text/plain' }, data: 'gateway hiccup' }
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 50, maxAttempts: 3 }),
    (error) => {
      assert.equal(error.code, 'qwen_parse_unavailable')
      assert.equal(error.parseCode, 'non_json_body')
      return true
    }
  )
  assert.equal(statusCalls(), 0)
})

test('breaker opens after 3 consecutive WAF challenges, not before, and a good parse closes it', async () => {
  resetParseBreaker()
  const error = await wafError()
  noteParseOutcome(error)
  noteParseOutcome(error)
  assert.doesNotThrow(() => assertParseBreakerClosed(), 'two strikes must not open it')

  const third = await wafError()
  noteParseOutcome(third)
  assert.equal(third.retryAfterSeconds, 120, 'the tripping error carries the cooldown')
  assert.throws(() => assertParseBreakerClosed(), (open) => {
    assert.equal(open.code, 'qwen_parse_waf_challenge')
    assert.equal(open.parseCode, 'WAF_CAPTCHA')
    assert.equal(open.breakerOpen, true)
    assert.ok(open.retryAfterSeconds > 0 && open.retryAfterSeconds <= 120, `retryAfterSeconds=${open.retryAfterSeconds}`)
    return true
  })

  noteParseOutcome(null)
  assert.doesNotThrow(() => assertParseBreakerClosed(), 'a successful parse resets it')
})

test('service-down failures (Internal_Server_Error) never count as WAF strikes', () => {
  resetParseBreaker()
  const serviceDown = Object.assign(new Error('Qwen 文档解析服务失败: Internal_Server_Error (f1)'), {
    code: 'qwen_parse_unavailable',
    parseCode: 'Internal_Server_Error'
  })
  for (let i = 0; i < 5; i++) noteParseOutcome(serviceDown)
  assert.doesNotThrow(() => assertParseBreakerClosed())
})

test('with the breaker open uploadAgentContextFile rejects before touching the network', async () => {
  resetParseBreaker()
  for (let i = 0; i < 3; i++) noteParseOutcome(await wafError())
  calls.length = 0
  await assert.rejects(
    uploadAgentContextFile('x'.repeat(4096), 'token', {}),
    (error) => {
      assert.equal(error.code, 'qwen_parse_waf_challenge')
      assert.equal(error.breakerOpen, true)
      return true
    }
  )
  assert.equal(calls.length, 0, 'no STS, OSS or parse call while open')
  resetParseBreaker()
})

test('ContextExternalizationError forwards the breaker wait as Retry-After and names the WAF', () => {
  const cause = Object.assign(new Error('waf'), { parseCode: 'WAF_CAPTCHA', retryAfterSeconds: 87 })
  const wrapped = new ContextExternalizationError(cause)
  assert.equal(wrapped.retryAfter, 87)
  assert.match(wrapped.publicMessage, /WAF/)

  const plain = new ContextExternalizationError(new Error('parse down'))
  assert.equal(plain.retryAfter, 10)
  assert.match(plain.publicMessage, /parse unavailable/i)
})
