'use strict'

/**
 * Ticket 05 de `.scratch/agent-turn-gate/`: la tabla de verdad de la puerta.
 *
 * La puerta es una función pura de un snapshot de intento más la política de la superficie, así
 * que acá no hay ruta HTTP ni config: cada fila es un snapshot, una política y el veredicto que
 * el contrato exige. Cubre cada token del vocabulario, cada campo de la política (encendido y
 * apagado), y las combinaciones que el corpus de caracterización (ticket 03) no tiene.
 *
 * El corpus sigue siendo la red de comportamiento observable de las superficies; esto es la
 * red del seam: barata y exacta porque la puerta no tiene efectos.
 */

// La puerta es una hoja (no lee config ni red), pero el logger sí mira el entorno al importarse.
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.LOG_LEVEL = 'error'
process.env.ENABLE_FILE_LOG = 'false'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  gate,
  REASONS,
  PROTOCOL_RECOVERY_REASONS,
  TERMINAL_FINISH_REASONS,
  RETRY_HINT_BUILDERS,
  retryHintFor,
  appendRetryHint,
  FINISH_STOP,
  FINISH_TOOL_CALLS
} = require('../src/utils/agent-turn-gate.js')
const { buildAgentRetryHint } = require('../src/utils/agent-turn.js')

/** La política que declara la superficie Anthropic (stream y no-stream comparten valores). */
const ANTHROPIC = Object.freeze({
  proseWithTools: true,
  acceptBareFinal: true,
  toolErrorsBeforeRequired: false,
  toolErrorsVetoWithCalls: false
})

/** La política que el spec describe para la superficie OpenAI (todavía sin cablear). */
const OPENAI = Object.freeze({
  proseWithTools: false,
  acceptBareFinal: false,
  toolErrorsBeforeRequired: true,
  toolErrorsVetoWithCalls: true
})

/** Un intento sin nada que objetar; cada fila tuerce solo lo que necesita. */
const snapshot = (overrides) => ({
  finishReason: 'stop',
  visibleText: 'respuesta final',
  controlKind: null,
  toolCalls: [],
  toolErrors: [],
  textToolErrors: [],
  nativeToolCalls: [],
  interceptedToolNames: [],
  thinkEvidence: false,
  callsDelivered: false,
  textChannelCut: false,
  orphanResidue: false,
  hasTools: true,
  requiresToolCall: false,
  ...overrides
})

const call = { name: 'Bash' }
const toolError = { type: 'unknown_tool', name: 'Bash' }
const NARRATED_ACTION = "I'll run the tests now."

/** name → [snapshot overrides, policy, veredicto esperado] */
const TABLE = [
  // --- cada token del vocabulario, por el camino más corto que lo produce ---
  ['empty: sin texto y sin finish terminal', { visibleText: '' }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.EMPTY }],
  ['bare: la superficie no acepta prosa sin envoltorio', { controlKind: 'bare' }, OPENAI,
    { verdict: 'retry', reason: REASONS.BARE }],
  ['bare: sin vocabulario de control y sin texto de cierre aceptado', { visibleText: 'prosa' }, OPENAI,
    { verdict: 'retry', reason: REASONS.BARE }],
  ['invalid_control: el envoltorio de control no cierra', { controlKind: 'invalid_control' }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.INVALID_CONTROL }],
  ['required_tool: el tool_choice exigía una llamada y no hubo', { requiresToolCall: true }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.REQUIRED_TOOL }],
  ['tool_error: un error de herramienta sin llamada que lo acompañe', { toolErrors: [toolError] }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.TOOL_ERROR }],
  ['prose_with_tools: prosa junto a una llamada donde la política la veta',
    { toolCalls: [call], visibleText: 'prosa' }, OPENAI,
    { verdict: 'retry', reason: REASONS.PROSE_WITH_TOOLS }],
  ['intercepted: frames descartados por la plataforma', { interceptedToolNames: ['Bash'] }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.INTERCEPTED }],
  ['malformed_protocol: residuo de protocolo en el texto', { orphanResidue: true }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.MALFORMED_PROTOCOL }],
  ['thought_tool_call: la llamada quedó en la razón oculta', { thinkEvidence: true }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.THOUGHT_TOOL_CALL }],
  ['missing_tool: texto que narra la acción y no la ejecuta',
    { visibleText: NARRATED_ACTION }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.MISSING_TOOL }],

  // --- un campo de política por fila, ambos valores ---
  ['proseWithTools=false veta la prosa junto a llamadas',
    { toolCalls: [call], visibleText: 'prosa' }, OPENAI,
    { verdict: 'retry', reason: REASONS.PROSE_WITH_TOOLS }],
  ['proseWithTools=true la acepta (el cliente ya tiene los bloques)',
    { toolCalls: [call], visibleText: 'prosa' }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['acceptBareFinal=true convierte la prosa pelada en respuesta final',
    { controlKind: 'bare' }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_STOP }],
  ['acceptBareFinal=false la rechaza', { controlKind: 'bare' }, OPENAI,
    { verdict: 'retry', reason: REASONS.BARE }],
  ['toolErrorsBeforeRequired=false: required manda sobre el error',
    { requiresToolCall: true, toolErrors: [toolError] }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.REQUIRED_TOOL }],
  ['toolErrorsBeforeRequired=true: el error veta antes',
    { requiresToolCall: true, toolErrors: [toolError] }, OPENAI,
    { verdict: 'retry', reason: REASONS.TOOL_ERROR }],
  ['toolErrorsVetoWithCalls=false: la llamada parseada sobrevive al error',
    { toolCalls: [call], toolErrors: [toolError] }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['toolErrorsVetoWithCalls=true: el error veta aunque haya llamada',
    { toolCalls: [call], toolErrors: [toolError] }, { ...ANTHROPIC, toolErrorsVetoWithCalls: true },
    { verdict: 'retry', reason: REASONS.TOOL_ERROR }],

  // --- combinaciones que el corpus no cubre ---
  ['una llamada ya entregada no se retracta: gana a todo lo demás',
    { callsDelivered: true, toolErrors: [toolError], interceptedToolNames: ['Bash'], visibleText: '', requiresToolCall: true },
    ANTHROPIC, { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['las llamadas nativas ganan a un error de herramienta',
    { nativeToolCalls: [call], toolErrors: [toolError] }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['la ronda cortada con llamadas admitidas se entrega, con la prosa permitida',
    { textChannelCut: true, toolCalls: [call], visibleText: 'prosa' }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['ronda cortada sin llamadas: no hay nada que entregar, sigue el juicio normal',
    { textChannelCut: true, visibleText: '' }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.EMPTY }],
  ['finish terminal apaga empty', { finishReason: 'length', visibleText: '' }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_STOP }],
  ['finish terminal apaga la evidencia (intercepted/orphan/think/narración)',
    { finishReason: 'content_filter', interceptedToolNames: ['Bash'], orphanResidue: true, thinkEvidence: true, visibleText: NARRATED_ACTION },
    ANTHROPIC, { verdict: 'accept', finishReason: FINISH_STOP }],
  ['finish terminal acota el veto de errores al canal de texto',
    { finishReason: 'length', textToolErrors: [toolError], toolErrors: [toolError] }, ANTHROPIC,
    { verdict: 'retry', reason: REASONS.TOOL_ERROR }],
  ['finish terminal: un error solo nativo no veta',
    { finishReason: 'length', textToolErrors: [], toolErrors: [{ type: 'invalid_arguments', name: 'Bash' }] }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_STOP }],
  ['sin herramientas no hay required ni evidencia que valga',
    { hasTools: false, requiresToolCall: true, interceptedToolNames: ['Bash'], thinkEvidence: true },
    ANTHROPIC, { verdict: 'accept', finishReason: FINISH_STOP }],
  ['required_tool no aplica si la llamada llegó',
    { requiresToolCall: true, toolCalls: [call] }, ANTHROPIC,
    { verdict: 'accept', finishReason: FINISH_TOOL_CALLS }],
  ['controlKind final con texto: respuesta final', { controlKind: 'final' }, OPENAI,
    { verdict: 'accept', finishReason: FINISH_STOP }],
  ['controlKind final sin texto: empty', { controlKind: 'final', visibleText: '' }, OPENAI,
    { verdict: 'retry', reason: REASONS.EMPTY }],
  ['controlKind blocked con texto: también es una respuesta final',
    { controlKind: 'blocked' }, OPENAI, { verdict: 'accept', finishReason: FINISH_STOP }],
  ['controlKind blocked sin texto: empty, igual que final',
    { controlKind: 'blocked', visibleText: '' }, OPENAI,
    { verdict: 'retry', reason: REASONS.EMPTY }],
  ['controlKind empty: la ronda vacía se reintenta', { controlKind: 'empty' }, OPENAI,
    { verdict: 'retry', reason: REASONS.EMPTY }],
  ['missing_tool es de las superficies sin vocabulario de control',
    { controlKind: 'final', visibleText: NARRATED_ACTION }, OPENAI,
    { verdict: 'accept', finishReason: FINISH_STOP }]
]

const run = (overrides, policy) => gate(snapshot(overrides), policy)

for (const [name, overrides, policy, want] of TABLE) {
  test(name, () => {
    const verdict = run(overrides, policy)
    assert.equal(verdict.verdict, want.verdict)
    if (want.reason) assert.equal(verdict.reason, want.reason)
    if (want.finishReason) assert.equal(verdict.finishReason, want.finishReason)
  })
}

test('la escalera de evidencia: intercepted > malformed > thought > missing', () => {
  const all = {
    interceptedToolNames: ['Bash'],
    orphanResidue: true,
    thinkEvidence: true,
    visibleText: NARRATED_ACTION
  }
  assert.equal(run(all, ANTHROPIC).reason, REASONS.INTERCEPTED)
  assert.equal(run({ ...all, interceptedToolNames: [] }, ANTHROPIC).reason, REASONS.MALFORMED_PROTOCOL)
  assert.equal(run({ ...all, interceptedToolNames: [], orphanResidue: false }, ANTHROPIC).reason, REASONS.THOUGHT_TOOL_CALL)
  assert.equal(run({ ...all, interceptedToolNames: [], orphanResidue: false, thinkEvidence: false }, ANTHROPIC).reason, REASONS.MISSING_TOOL)
})

test('la ronda cortada con llamadas suprime el texto que la política no permite', () => {
  const cut = { textChannelCut: true, toolCalls: [call], visibleText: 'prosa' }
  assert.equal(run(cut, ANTHROPIC).suppressVisibleText, false)
  assert.equal(run(cut, OPENAI).suppressVisibleText, true, 'prosaWithTools=false la veta al entregar')
  assert.equal(run({ ...cut, toolErrors: [toolError] }, ANTHROPIC).suppressVisibleText, true)
  assert.equal(run({ textChannelCut: true, toolCalls: [call], orphanResidue: true }, ANTHROPIC).suppressVisibleText, true)
})

test('las llamadas nativas suprimen el texto solo con pruebas de que trae basura', () => {
  assert.equal(run({ nativeToolCalls: [call] }, ANTHROPIC).suppressVisibleText, false)
  assert.equal(run({ nativeToolCalls: [call], textToolErrors: [toolError] }, ANTHROPIC).suppressVisibleText, true)
  assert.equal(run({ nativeToolCalls: [call], orphanResidue: true }, ANTHROPIC).suppressVisibleText, true)
})

test('forma del veredicto: accept no lleva razón, retry no lleva finish reason', () => {
  for (const [name, overrides, policy] of TABLE) {
    const verdict = run(overrides, policy)
    if (verdict.verdict === 'accept') {
      assert.equal(verdict.reason, null, name)
      assert.ok(verdict.finishReason, name)
    } else {
      assert.equal(verdict.finishReason, null, name)
      assert.ok(Object.values(REASONS).includes(verdict.reason), name)
      assert.equal(verdict.suppressVisibleText, false, name)
    }
  }
})

test('max_tokens es terminal igual que length', () => {
  assert.ok(TERMINAL_FINISH_REASONS.has('max_tokens'))
  assert.equal(run({ finishReason: 'max_tokens', visibleText: '' }, ANTHROPIC).verdict, 'accept')
  assert.notEqual(run({ finishReason: 'max_tokens', visibleText: '' }, OPENAI).reason, REASONS.EMPTY)
})

test('cada token del vocabulario tiene constructor de hint y produce texto', () => {
  const hintSnapshot = snapshot({ toolErrors: [toolError], textToolErrors: [toolError], interceptedToolNames: ['Bash'], thinkEvidence: true })
  for (const token of Object.values(REASONS)) {
    assert.ok(RETRY_HINT_BUILDERS[token], `sin constructor: ${token}`)
    const hint = retryHintFor(token, hintSnapshot, { toolChoice: 'required', allowedToolNames: ['Bash'] })
    assert.equal(typeof hint, 'string', token)
    assert.ok(hint.trim().length > 0, token)
  }
})

test('el cupo de recuperación de protocolo es exactamente intercepted/malformed/thought', () => {
  assert.deepEqual([...PROTOCOL_RECOVERY_REASONS].sort(),
    [REASONS.INTERCEPTED, REASONS.MALFORMED_PROTOCOL, REASONS.THOUGHT_TOOL_CALL].sort())
  assert.ok(!PROTOCOL_RECOVERY_REASONS.has(REASONS.MISSING_TOOL))
  assert.ok(!PROTOCOL_RECOVERY_REASONS.has(REASONS.TOOL_ERROR))
  assert.ok(!PROTOCOL_RECOVERY_REASONS.has(REASONS.EMPTY))
})

test('el hint de required_tool lleva el hecho de la intercepción que lo tapa', () => {
  const s = snapshot({ requiresToolCall: true, interceptedToolNames: ['Bash'] })
  const base = RETRY_HINT_BUILDERS[REASONS.REQUIRED_TOOL](s, { toolChoice: 'required' })
  assert.equal(retryHintFor(REASONS.REQUIRED_TOOL, s, { toolChoice: 'required' }),
    `${base}\n${buildAgentRetryHint('intercepted')}`)
})

test('el hint de tool_error lleva el hecho del think leak que lo tapa', () => {
  const s = snapshot({ toolErrors: [toolError], thinkEvidence: true })
  const base = RETRY_HINT_BUILDERS[REASONS.TOOL_ERROR](s, { allowedToolNames: ['Bash'] })
  assert.equal(retryHintFor(REASONS.TOOL_ERROR, s, { allowedToolNames: ['Bash'] }),
    `${base}\n${buildAgentRetryHint('thought_tool_call')}`)
})

test('appendRetryHint: el encabezado va solo en los brazos que agregan a un texto', () => {
  const header = '# Tool-call retry'
  const stringBody = { messages: [{ role: 'user', content: 'contexto' }] }
  assert.equal(appendRetryHint(stringBody, 'HINT', { header }).messages[0].content, `contexto\n\n${header}\nHINT`)
  assert.equal(appendRetryHint(stringBody, 'HINT').messages[0].content, 'contexto\n\nHINT')
  const partsBody = { messages: [{ role: 'user', content: [{ type: 'text', text: 'contexto' }] }] }
  assert.equal(appendRetryHint(partsBody, 'HINT', { header }).messages[0].content[0].text, `contexto\n\n${header}\nHINT`)
  const noTextPart = { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }
  assert.deepEqual(appendRetryHint(noTextPart, 'HINT', { header }).messages[0].content[0], { type: 'text', text: 'HINT' })
  assert.deepEqual(appendRetryHint({ messages: [] }, 'HINT', { header }).messages[0], { role: 'user', content: 'HINT' })
})

test('appendRetryHint no muta el cuerpo original (se reusa entre reintentos)', () => {
  const body = { messages: [{ role: 'user', content: 'contexto' }] }
  const out = appendRetryHint(body, 'HINT', { header: '# Tool-call retry' })
  assert.equal(body.messages[0].content, 'contexto')
  assert.notEqual(out, body)
  assert.equal(out.messages[0].content, 'contexto\n\n# Tool-call retry\nHINT')
})
