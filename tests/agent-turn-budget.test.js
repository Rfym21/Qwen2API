'use strict'

/**
 * Ticket 04 de `.scratch/agent-turn-gate/`: un solo significado de "max attempts".
 *
 * El runtime OpenAI aplicaba un piso de 2 sobre el valor que le pasaran — pedir 1 daba 2
 * intentos en silencio — mientras las superficies Anthropic aplicaban piso 1. La misma
 * configuración significaba dos cosas. Ahora "max attempts" es el total de generaciones del
 * upstream por petición de cliente, contando la primera, y pedir 1 da un intento.
 *
 * Lo observable es cuántas veces se le pidió una generación al upstream: el sender es un
 * guion que cuenta.
 */

// Config se congela al importarse y el presupuesto sale de ahí cuando la petición no trae
// uno, así que el pin va antes de cualquier require que lo arrastre.
process.env.AGENT_TURN_MAX_ATTEMPTS = '2'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.LEGACY_REASONING_IN_CONTENT = 'false'
process.env.LOG_LEVEL = 'error'
process.env.ENABLE_FILE_LOG = 'false'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { handleStreamResponse } = require('../src/controllers/chat.js')
const { handleAnthropicNonStream } = require('../src/controllers/anthropic.js')

test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* nada que limpiar */ }
})

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const stop = () => frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'

/** Ronda que no cumple `required`: prosa sin llamada. Siempre rechazada, nunca recupera. */
const proseRound = () => Readable.from([
  frame({ choices: [{ delta: { phase: 'answer', content: 'Voy a revisar el repositorio.' } }] }),
  stop()
])

const createStreamResponse = () => ({
  statusCode: 200,
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  set(headers) { Object.assign(this.headers, headers); return this },
  status(code) { this.statusCode = code; return this },
  write(chunk) { this.headersSent = true; this.output += String(chunk); return true },
  end(chunk = '') { this.output += String(chunk); this.writableEnded = true },
  json(payload) { this.body = payload; this.writableEnded = true; return this }
})

/** Sender guion: cuenta generaciones y siempre devuelve otra ronda de prosa. */
const countingSender = () => {
  const fn = async () => { fn.sends += 1; return { status: true, response: proseRound() } }
  fn.sends = 0
  return fn
}

const runOpenAI = async (budget) => {
  const res = createStreamResponse()
  const sender = countingSender()
  const body = { messages: [{ role: 'user', content: 'do the task' }] }
  await handleStreamResponse(res, proseRound(), false, false, body, {
    has_tools: true,
    tool_choice: 'required',
    allowed_tool_names: ['Bash'],
    sendChatRequest: sender,
    upstream_request_body: body,
    currentAccount: null,
    upstreamOptions: {},
    agent_turn_max_attempts: budget
  })
  return sender.sends + 1 // la primera generación no pasa por el sender
}

const runAnthropic = async (overrides = {}) => {
  const sender = countingSender()
  await handleAnthropicNonStream(
    createStreamResponse(),
    {
      message_id: 'msg_budget',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'required',
      allowedToolNames: ['Bash'],
      requestBody: { messages: [{ role: 'user', content: 'do the task' }] },
      sendRequest: sender,
      historyToolCalls: [],
      upstreamOptions: {},
      ...overrides
    },
    proseRound()
  )
  return sender.sends + 1
}

test('presupuesto 1 significa un intento: la ronda rechazada no se reintenta', async () => {
  assert.equal(await runOpenAI(1), 1,
    'pedir 1 daba 2 generaciones del upstream: el piso de 2 del runtime OpenAI')
})

test('presupuesto 2 significa dos intentos: un reintento y se acabó', async () => {
  assert.equal(await runOpenAI(2), 2)
})

test('la superficie Anthropic honra el mismo presupuesto de configuración', async () => {
  assert.equal(await runAnthropic(), 2,
    'config en 2 = dos generaciones, la misma cuenta que en la superficie OpenAI')
})

test('la superficie Anthropic no tiene override por petición', async () => {
  // No existe ese canal: el ctx no lo lee y el presupuesto sale de config. Se pasa uno
  // igual para fijar que NO se empieza a honrar algo que nadie definió — el día que exista
  // un override de Anthropic, este test es el que obliga a decidirlo en vez de heredarlo.
  assert.equal(await runAnthropic({ agent_turn_max_attempts: 1 }), 2,
    'un override colado en el ctx se ignora: sigue mandando config')
})
