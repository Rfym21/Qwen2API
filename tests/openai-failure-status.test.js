// La via de retorno de /v1/chat/completions contestaba 500 "Request failed" para todo:
// cuota, transporte caido y upstream opaco llegaban igual. Ahora el veredicto que viaja con
// el fallo se traduce al cable OpenAI. Se conduce el handler con un doble de res y se afirma
// lo que recibe el cliente, no la rama que lo escribio.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = 'openai-failure-status-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }

// El controlador captura sendChatRequest por destructuring en su primer require: el doble
// tiene que estar puesto antes.
const requestModule = require('../src/utils/request.js')
let upstreamResult = { status: false, response: null }
requestModule.sendChatRequest = async () => upstreamResult

const { handleChatCompletion } = require('../src/controllers/chat.js')

test.after(() => { require('../src/utils/account.js').destroy() })

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false, writableEnded: false }
  res.status = (code) => { res.statusCode = code; return res }
  res.set = (key, value) => {
    if (key && typeof key === 'object') Object.assign(res.headers, key)
    else res.headers[key] = value
    return res
  }
  res.json = (body) => { res.body = body; res.headersSent = true; res.writableEnded = true; return res }
  res.write = () => true
  res.end = () => { res.writableEnded = true }
  res.flushHeaders = () => { res.headersSent = true }
  res.on = () => res
  return res
}

const req = () => ({
  body: { model: 'qwen3-max', stream: false, messages: [{ role: 'user', content: 'hola' }] },
  has_tools: false,
  allowed_tool_names: []
})

const failure = (overrides) => ({
  status: false,
  response: null,
  failure: { rateLimited: false, overloaded: false, status: 502, retryAfter: null, ...overrides }
})

const drive = async (result) => {
  upstreamResult = result
  const res = fakeRes()
  await handleChatCompletion(req(), res)
  return res
}

test('la cuota agotada sale 429 insufficient_quota, no un 500 mudo', async () => {
  const res = await drive(failure({ rateLimited: true, status: 429, retryAfter: 3600 }))

  assert.equal(res.statusCode, 429)
  assert.equal(res.body.error.type, 'insufficient_quota')
  assert.equal(res.body.error.code, 'insufficient_quota')
  assert.equal(res.headers['Retry-After'], '3600')
})

test('sin espera del upstream no se inventa Retry-After', async () => {
  const res = await drive(failure({ rateLimited: true, status: 429 }))

  assert.equal(res.statusCode, 429)
  assert.equal(res.headers['Retry-After'], undefined)
})

test('el transporte agotado sale 503: el proxy no esta roto', async () => {
  const res = await drive(failure({ status: 503 }))

  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.type, 'upstream_error')
})

test('un no-200 opaco del upstream sale 502, no 500', async () => {
  const res = await drive(failure({ status: 502 }))

  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error.code, 'upstream_error')
})

test('un upstream sobrecargado sale 503 upstream_unavailable', async () => {
  const res = await drive(failure({ overloaded: true, status: 503, retryAfter: 10 }))

  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.code, 'upstream_unavailable')
  assert.equal(res.headers['Retry-After'], '10')
})

test('la razon concreta del modulo de request sigue llegando al cliente', async () => {
  const res = await drive({ ...failure({ status: 503 }), message: 'no hay cuentas configuradas' })

  assert.equal(res.body.error.message, 'no hay cuentas configuradas')
})
