// El adjunto de contexto largo falla (parse de Qwen caido) en una peticion CON tools.
//
// Antes (2026-09-09 21:25, medido en vivo en qwen-next): el proxy compactaba el historial
// a 48 KiB y devolvia 200 como si nada; el agente veia el 7–50 % de su historial y repetia
// tareas ya hechas (3 duplicados, 34 avisos de repeticion, 7 turnos con 24/24 tool calls
// desbocados en 6 min; cero antes de la caida). Ahora:
//
//   /v1/messages          con tools -> HTTP 529 {"type":"error","error":{"type":"overloaded_error"}}
//   /v1/chat/completions  con tools -> HTTP 503 {"error":{"type":"server_error","code":"upstream_unavailable"}}
//   ambos                 sin tools -> se permite compactar (allowContextCompaction: true)
//
// con Retry-After para que el cliente agentico reintente solo. La clasificacion vive UNA
// vez en src/utils/upstream-error.js; los dos controladores son gemelos (cf. tests/upstream-quota-429.test.js).
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const requestModule = require('../src/utils/request.js')
const {
  ContextExternalizationError,
  describeUpstreamFailure,
  isContextAttachmentError
} = require('../src/utils/upstream-error.js')

let sentOptions = null
let attachmentDown = false
requestModule.sendChatRequest = async (body, options = {}) => {
  sentOptions = options
  if (attachmentDown) {
    throw new ContextExternalizationError(new Error('Qwen 文档解析服务失败: Internal_Server_Error (f1)'))
  }
  return { status: false, message: 'offline test: no upstream' }
}

const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')
const { handleChatCompletion } = require('../src/controllers/chat.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

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

const anthropicBody = (withTools) => ({
  model: 'qwen3-max',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'continue the unfinished task' }],
  ...(withTools
    ? { tools: [{ name: 'read_file', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] }
    : {})
})

const openaiReq = (withTools) => ({
  body: {
    model: 'qwen3-max',
    stream: false,
    messages: [{ role: 'user', content: 'continue the unfinished task' }]
  },
  has_tools: withTools,
  tool_choice: withTools ? 'auto' : undefined,
  allowed_tool_names: withTools ? ['read_file'] : []
})

// ---------------------------------------------------------------- clasificador

test('describeUpstreamFailure: attachment failure is overloaded/529 with a retry hint; anything else untouched', () => {
  const failure = describeUpstreamFailure(new ContextExternalizationError(new Error('parse down')), 500)
  assert.deepEqual(failure, { rateLimited: false, overloaded: true, status: 529, retryAfter: 10 })
  assert.equal(isContextAttachmentError(new ContextExternalizationError('x')), true)

  const plain = describeUpstreamFailure(new Error('boom'), 500)
  assert.equal(plain.overloaded, false)
  assert.equal(plain.status, 500)
  assert.equal(isContextAttachmentError(new Error('boom')), false)
})

// ---------------------------------------------------------------- /v1/messages

test('/v1/messages with tools: attachment failure is HTTP 529 overloaded_error + Retry-After, never a 200', async () => {
  attachmentDown = true
  const res = fakeRes()
  await handleAnthropicMessages({ body: anthropicBody(true) }, res)
  assert.equal(sentOptions.allowContextCompaction, false)
  assert.equal(res.statusCode, 529)
  assert.equal(res.body.type, 'error')
  assert.equal(res.body.error.type, 'overloaded_error')
  assert.match(res.body.error.message, /parse unavailable/i)
  assert.equal(res.headers['Retry-After'], '10')
})

test('/v1/messages: the session key for history-prefix reuse travels in the upstream options (null without metadata.user_id) and the 529 mapping is unchanged', async () => {
  attachmentDown = true
  const anonymous = fakeRes()
  await handleAnthropicMessages({ body: anthropicBody(true) }, anonymous)
  assert.equal(sentOptions.contextPrefixKey, null)
  assert.equal(anonymous.statusCode, 529)

  const session = fakeRes()
  await handleAnthropicMessages({ body: { ...anthropicBody(true), metadata: { user_id: 'session-1' } } }, session)
  assert.match(sentOptions.contextPrefixKey, /^[0-9a-f]{64}$/)
  assert.equal(sentOptions.allowContextCompaction, false)
  assert.equal(session.statusCode, 529)
  assert.equal(session.headers['Retry-After'], '10')
})

test('/v1/messages without tools: compaction is allowed', async () => {
  attachmentDown = false
  const res = fakeRes()
  await handleAnthropicMessages({ body: anthropicBody(false) }, res)
  assert.equal(sentOptions.allowContextCompaction, true)
})

// ---------------------------------------------------------------- /v1/chat/completions

test('/v1/chat/completions with tools: attachment failure is HTTP 503 upstream_unavailable + Retry-After', async () => {
  attachmentDown = true
  const res = fakeRes()
  await handleChatCompletion(openaiReq(true), res)
  assert.equal(sentOptions.allowContextCompaction, false)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.error.type, 'server_error')
  assert.equal(res.body.error.code, 'upstream_unavailable')
  assert.equal(res.headers['Retry-After'], '10')
})

test('/v1/chat/completions without tools: compaction is allowed', async () => {
  attachmentDown = false
  const res = fakeRes()
  await handleChatCompletion(openaiReq(false), res)
  assert.equal(sentOptions.allowContextCompaction, true)
})
