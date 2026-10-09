// El reenvio de correccion del runtime de agente (una ronda rechazada -> segundo envio con el
// hint) devolvia un 502 opaco cuando ese segundo envio no arrancaba: cuota o transporte caido
// quedaban indistinguibles de un servidor roto. El fallo del reenvio trae veredicto desde el
// modulo de request, y el runtime lo propaga tal cual para que el controlador lo escriba.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = 'agent-resend-verdict-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const modelsMap = require('../src/models/models-map.js')
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch') }
const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime.js')

test.after(() => { require('../src/utils/account.js').destroy() })

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
/** Una ronda sin tool call y sin cierre: la puerta la rechaza y pide un reenvio. */
const unfinishedTurn = () => [frame({ choices: [{ delta: { phase: 'answer', content: 'a medias' }, finish_reason: null }] })]

const options = (sendChatRequest) => ({
  has_tools: true,
  tool_choice: 'auto',
  allowed_tool_names: ['read_file'],
  agent_turn_max_attempts: 3,
  upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
  currentAccount: { email: 'resend@example.invalid', token: 'resend-test-token' },
  sendChatRequest
})

const run = (sendChatRequest) => runOpenAIAgentTurn(Readable.from(unfinishedTurn()), options(sendChatRequest))

test('un reenvio que no arranca por cuota sale 429, no un 502 opaco', async () => {
  let calls = 0
  const result = await run(async () => {
    calls += 1
    return {
      status: false,
      response: null,
      failure: { rateLimited: true, overloaded: false, status: 429, retryAfter: 3600 }
    }
  })

  assert.equal(calls, 1, 'el reenvio de correccion se intento una vez')
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 429)
  assert.equal(result.error.type, 'insufficient_quota')
  assert.equal(result.error.code, 'insufficient_quota')
  assert.equal(result.error.retry_after, 3600)
})

test('un reenvio que no arranca por transporte sale 503', async () => {
  const result = await run(async () => ({
    status: false,
    response: null,
    failure: { rateLimited: false, overloaded: false, status: 503, retryAfter: null }
  }))

  assert.equal(result.ok, false)
  assert.equal(result.error.status, 503)
  assert.equal(result.error.code, 'upstream_retry_failed', 'sin veredicto propio conserva el code de siempre')
})

test('un fallo sin veredicto conserva el 502 y el code de siempre', async () => {
  const result = await run(async () => ({ status: false, response: null, message: 'algo se rompio' }))

  assert.equal(result.ok, false)
  assert.equal(result.error.status, 502)
  assert.equal(result.error.code, 'upstream_retry_failed')
  assert.equal(result.error.message, 'algo se rompio')
})
