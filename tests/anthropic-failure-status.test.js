// Gemelo de tests/openai-failure-status.test.js en la superficie Anthropic: la salida
// pre-respuesta de /v1/messages contestaba 500 `api_error` para todo. Ahora el veredicto que
// viaja con el fallo se traduce al vocabulario de Anthropic. Se conduce el handler con un
// doble de res y se afirma lo que recibe el cliente.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = 'anthropic-failure-status-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }

// El controlador captura sendChatRequest por destructuring en su primer require.
const requestModule = require('../src/utils/request.js')
let upstreamResult = { status: false }
requestModule.sendChatRequest = async () => upstreamResult

const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')

test.after(() => { require('../src/utils/account.js').destroy() })

const jsonRes = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  headersSent: false,
  writableEnded: false,
  set(h, v) { if (typeof h === 'string') this.headers[h] = v; else Object.assign(this.headers, h); return this; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; this.headersSent = true; this.writableEnded = true; return this; },
  write(chunk) { this.headersSent = true; this.output = (this.output || '') + String(chunk); return true; },
  end(chunk = '') { if (chunk) this.output = (this.output || '') + String(chunk); this.writableEnded = true; }
})

const failure = (overrides) => ({
  status: false,
  response: null,
  failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null, ...overrides }
})

const drive = async (result) => {
  upstreamResult = result
  const res = jsonRes()
  await handleAnthropicMessages({
    body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
  }, res)
  return res
}

test('la cuota agotada sale 429 rate_limit_error, no un 500 api_error', async () => {
  const res = await drive(failure({ rateLimited: true, status: 429, retryAfter: 3600 }))

  assert.equal(res.statusCode, 429)
  assert.equal(res.body.type, 'error')
  assert.equal(res.body.error.type, 'rate_limit_error')
  assert.equal(res.headers['Retry-After'], '3600')
})

test('sin espera del upstream no se inventa Retry-After', async () => {
  const res = await drive(failure({ rateLimited: true, status: 429 }))

  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['Retry-After'], undefined)
})

test('un upstream sobrecargado sale 529 overloaded_error', async () => {
  const res = await drive(failure({ overloaded: true, status: 529, retryAfter: 10 }))

  assert.equal(res.statusCode, 529)
  assert.equal(res.body.error.type, 'overloaded_error')
  assert.equal(res.headers['Retry-After'], '10')
})

test('el transporte agotado sale 503', async () => {
  const res = await drive(failure({ status: 503 }))

  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.type, 'api_error')
})

test('un no-200 opaco del upstream sale 502, no 500', async () => {
  const res = await drive(failure({ status: 502 }))

  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error.type, 'api_error')
})

test('la razon concreta del modulo de request sigue llegando al cliente', async () => {
  const res = await drive({ ...failure({ status: 503 }), message: 'no hay cuentas configuradas' })

  assert.equal(res.body.error.message, 'no hay cuentas configuradas')
})
