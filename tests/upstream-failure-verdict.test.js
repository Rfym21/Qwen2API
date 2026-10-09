// El modulo de request clasifica el fallo y luego lo tira: devuelve {status:false, response:null}
// y los tres llamadores contestan 500/502 "Request failed". Un cliente agentico no puede
// distinguir "vuelve mas tarde" de "el proxy esta roto".
//
// Estos tests conducen el seam del cliente HTTP (axios.post) y afirman lo que sale de la
// funcion: el veredicto que el llamador necesita para hablar su vocabulario de cable.
// Comportamiento externo, no ramas internas.
const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

process.env.API_KEY = 'failure-verdict-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''
process.env.CHAT_RETRY_COUNT = '0'
process.env.CHAT_RETRY_BACKOFF_MS = '0'

const accountManager = require('../src/utils/account')
const AccountRotator = require('../src/utils/account-rotator')
const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const { sendChatRequest } = require('../src/utils/request')

const ACCOUNT = { email: 'verdict@example.invalid', token: 'verdict-test-token' }
const BODY = { model: 'qwen3-max', messages: [{ role: 'user', content: 'hola' }] }

/** Envuelve axios.post como los tests de chat challenge: nada sale a la red. */
const withPost = async (post, fn) => {
  const original = axios.post
  axios.post = post
  try { return await fn() } finally { axios.post = original }
}

/** Un error de axios tal y como llega cuando el upstream contesta con status no-200. */
const httpFailure = (status) => {
  const error = new Error(`Request failed with status code ${status}`)
  error.response = { status, headers: {}, data: '' }
  return error
}

const transportFailure = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })

const send = (options = {}) => sendChatRequest(BODY, {
  chatId: 'failure-verdict-chat',
  currentAccount: ACCOUNT,
  ...options
})

test.before(async () => { await accountManager._initPromise })
test.beforeEach(() => {
  accountManager.accountTokens = [ACCOUNT]
  accountManager.isInitialized = true
  accountManager.accountRotator = new AccountRotator()
  accountManager.accountRotator.setAccounts([ACCOUNT])
})
test.after(() => { accountManager.destroy() })

test('un 429 del upstream sale clasificado como cuota, no como un fallo mudo', async () => {
  const result = await withPost(async () => { throw httpFailure(429) }, () => send())

  assert.equal(result.status, false)
  assert.equal(result.response, null)
  assert.ok(result.failure, 'el fallo lleva veredicto')
  assert.equal(result.failure.rateLimited, true)
  assert.equal(result.failure.status, 429)
  // Sin espera del upstream no se inventa una: la cabecera la decide el llamador con esto.
  assert.equal(result.failure.retryAfter, null)
})

test('un 429 con Retry-After del upstream no pierde la espera', async () => {
  const withHeader = () => {
    const error = httpFailure(429)
    error.response.headers = { 'retry-after': '120' }
    return error
  }
  const result = await withPost(async () => { throw withHeader() }, () => send())

  assert.equal(result.failure.status, 429)
  assert.equal(result.failure.retryAfter, 120, 'la espera que el upstream SI mando viaja')
})

test('un no-200 sin causa clasificable sale 502, no 500', async () => {
  const result = await withPost(async () => { throw httpFailure(500) }, () => send())

  assert.ok(result.failure, 'el fallo lleva veredicto')
  assert.equal(result.failure.status, 502)
  assert.equal(result.failure.rateLimited, false)
  assert.equal(result.failure.overloaded, false)
})

test('el transporte agotado sale 503: es reintentable de verdad', async () => {
  const result = await withPost(async () => { throw transportFailure() }, () => send())

  assert.ok(result.failure, 'el fallo lleva veredicto')
  assert.equal(result.failure.status, 503)
  assert.equal(result.failure.rateLimited, false)
})

test('sin cuenta utilizable sale 503 y conserva la razon', async () => {
  accountManager.accountTokens = []
  accountManager.accountRotator = new AccountRotator()
  accountManager.accountRotator.setAccounts([])

  const result = await sendChatRequest(BODY, { chatId: 'failure-verdict-chat' })

  assert.equal(result.status, false)
  assert.ok(result.failure, 'el fallo lleva veredicto')
  assert.equal(result.failure.status, 503)
  assert.ok(result.message, 'la razon concreta sigue viajando al cliente')
})

test('la cuenta que recibe el 429 deja de repartirse: cuota agotada', async () => {
  const result = await withPost(async () => { throw httpFailure(429) }, () => send())
  assert.equal(result.failure.rateLimited, true)

  assert.equal(
    accountManager.getAccount(),
    null,
    'una cuenta en cuota agotada no vuelve a salir en el sorteo'
  )
})
