// Fail-fast cuando el servicio de parse de documentos de Qwen esta caido.
//
// Observado en vivo 2026-09-09 21:25 (qwen-next y prod, 22/22 sondeos): Qwen sigue
// contestando HTTP 200, pero el cuerpo es
//   POST /api/v2/files/parse         -> {"success":true, "data":{"code":"Internal_Server_Error"}}
//   POST /api/v2/files/parse/status  -> {"success":false,"data":{"code":"Internal_Server_Error"}}
// sin ningun `status` por archivo. El bucle lo tomaba por "pendiente": 30 sondeos x 500 ms
// = 15 s por turno, y despues un "解析超时" que no era un timeout.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

// axios se parchea en el cache de require ANTES de cargar upload.js, que lo captura al
// requerirse. Ningun otro modulo del test toca la red.
const axiosPath = require.resolve('axios')
const calls = []
let parseResponse = { data: { success: true, data: {} } }
let statusQueue = []
const axiosStub = {
  post: async (url) => {
    calls.push(url)
    if (url.endsWith('/api/v2/files/parse')) return parseResponse
    if (url.endsWith('/api/v2/files/parse/status')) {
      return statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]
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

const { parseUploadedTextFile } = require('../src/utils/upload.js')

test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* no cargado */ }
})

const reset = () => {
  calls.length = 0
  parseResponse = { data: { success: true, data: {} } }
  statusQueue = []
}
const statusCalls = () => calls.filter(url => url.endsWith('/files/parse/status')).length
const perFile = (status) => ({ data: { success: true, data: { list: [{ file_id: 'f1', status }] } } })
const SERVICE_DOWN = { data: { success: false, data: { code: 'Internal_Server_Error' } } }

test('parse status with success:false fails on the FIRST poll, not after 30', async () => {
  reset()
  statusQueue = [SERVICE_DOWN]
  const started = Date.now()
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 200, maxAttempts: 30 }),
    (error) => {
      assert.equal(error.code, 'qwen_parse_unavailable')
      assert.equal(error.parseCode, 'Internal_Server_Error')
      assert.match(error.message, /Internal_Server_Error/)
      assert.doesNotMatch(error.message, /超时/)
      return true
    }
  )
  assert.equal(statusCalls(), 1)
  assert.ok(Date.now() - started < 1000, 'must not wait for the poll budget')
})

test('parse POST answering with an error code fails before any status poll', async () => {
  reset()
  parseResponse = { data: { success: true, data: { code: 'Internal_Server_Error' } } }
  statusQueue = [perFile('success')]
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10 }),
    (error) => error.code === 'qwen_parse_unavailable'
  )
  assert.equal(statusCalls(), 0)
})

test('a genuinely pending parse still resolves once the file reports success', async () => {
  reset()
  statusQueue = [perFile('pending'), perFile('parsing'), perFile('success')]
  assert.equal(await parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10 }), true)
  assert.equal(statusCalls(), 3)
})

test('a real timeout names the last status seen', async () => {
  reset()
  statusQueue = [perFile('parsing')]
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10, maxAttempts: 3 }),
    /解析超时: f1 \(last status="parsing"\)/
  )
  assert.equal(statusCalls(), 3)
})
