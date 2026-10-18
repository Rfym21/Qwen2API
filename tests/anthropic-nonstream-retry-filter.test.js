/**
 * Ticket 02 (`.scratch/agent-turn-gate/issues/02-filtro-de-frames-no-stream.md`).
 *
 * `createUpstreamResponseFilter` latcha el `response_id` que acepta, y el loop
 * no-stream (C) lo construye UNA sola vez por petición: su bloque de reintento
 * reconstruye el normalizador, los acumuladores y el estado por ronda, pero no el
 * filtro. El plan de unificación de loops (lohari, 2026-08-31) afirmó que por eso
 * un reintento con otro `response_id` no contribuye nada.
 *
 * MEDICIÓN (2026-10-09): la afirmación es cierta sobre el mecanismo y falsa sobre
 * el disparador. Un reintento que abre con `response.created` —que es como abre
 * TODA generación del upstream, ver los frames capturados en `sse.test.js:130` y
 * `chat-challenge.test.js:56`— hace que el filtro RE-latchee al id nuevo, así que
 * sus frames entran con normalidad. La forma que sí pierde los frames es un
 * reintento SIN `response.created` y con otro id: la rama de protocolo viejo del
 * filtro conserva el primer id y descarta todo lo demás. Esa forma se midió y se
 * descartó por inalcanzable; no se toca el loop.
 *
 * El test de abajo es la red de regresión sobre el re-latch: si alguien cambia el
 * filtro para latchar de forma permanente, o deja de reconstruir la ventana de
 * ids, esto se pone rojo.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { handleAnthropicNonStream } = require('../src/controllers/anthropic.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

// ---------------------------------------------------------------------------
// Harness (mismas formas que anthropic-native-parity.test.js)
// ---------------------------------------------------------------------------

const createMockJsonResponse = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  set(headers) { Object.assign(this.headers, headers); return this; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; }
})

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

const createdFrame = (id, index = '0') => frame({
  'response.created': { chat_id: 'c1', parent_id: 'p1', response_id: id, response_index: index }
})

const textFrame = (id, text) => frame({
  choices: [{ delta: { role: 'assistant', content: text, phase: 'answer', status: 'typing' }, finish_reason: null }],
  response_id: id
})

const nativeCallFrame = (id, name, snapshot) => frame({
  choices: [{
    delta: {
      role: 'assistant',
      content: '',
      phase: 'answer',
      status: 'typing',
      function_call: { name, arguments: snapshot },
      extra: { display_position: 'answer' }
    },
    finish_reason: null
  }],
  response_id: id
})

const notExistsFrame = (id, name) => frame({
  choices: [{
    delta: { role: 'function', content: `Tool ${name} does not exists.`, phase: 'answer', status: 'typing', name },
    finish_reason: null
  }],
  response_id: id
})

const terminator = (id, finishReason) => frame({
  choices: [{ delta: {}, finish_reason: finishReason }],
  response_id: id
}) + 'data: [DONE]\n\n'

const BASH_ARGS = '{"command": "git status"}'
const BASH_SNAPSHOTS = ['', '{"command": ', '{"command": "git status"', BASH_ARGS, BASH_ARGS]

/** Primer intento: prosa sin llamada → `required` sin cumplir → un reintento. */
const firstAttempt = (id) => () => Readable.from([
  createdFrame(id),
  textFrame(id, 'Voy a revisar el repositorio.'),
  terminator(id, 'stop')
])

/** Reintento con la llamada nativa completa, bajo el id que se le pase. */
const retryAttempt = (id) => () => Readable.from([
  createdFrame(id),
  ...BASH_SNAPSHOTS.map(snapshot => nativeCallFrame(id, 'Bash', snapshot)),
  notExistsFrame(id, 'Bash'),
  terminator(id, 'stop')
])

const scriptedSender = (...turns) => {
  const queue = [...turns]
  const fn = async (body) => {
    fn.calls.push(body)
    const next = queue.shift()
    return next ? { status: true, response: next() } : { status: false }
  }
  fn.calls = []
  return fn
}

const baseCtx = (sendRequest) => ({
  message_id: 'msg_retry_filter',
  model: 'qwen-test',
  hasTools: true,
  toolChoice: 'required',
  allowedToolNames: ['Bash'],
  requestBody: { messages: [] },
  sendRequest
})

const runNonStream = (upstream, sendRequest) => {
  const res = createMockJsonResponse()
  return handleAnthropicNonStream(res, baseCtx(sendRequest), upstream()).then(() => res)
}

const toolUseNames = (body) => (body?.content || [])
  .filter(block => block.type === 'tool_use')
  .map(block => block.name)

// ---------------------------------------------------------------------------

test('non-stream C: un reintento con OTRO response_id recupera la llamada (el filtro re-latchea con response.created)', async () => {
  const sender = scriptedSender(retryAttempt('r2'))
  const res = await runNonStream(firstAttempt('r1'), sender)

  assert.equal(sender.calls.length, 1, 'tool_choice=required sin llamada dispara exactamente un reintento')
  assert.deepEqual(toolUseNames(res.body), ['Bash'],
    'el reintento abre con response.created: el filtro re-latchea y sus frames no se descartan')
})
