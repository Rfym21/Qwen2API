// El 429 "1 de cada 4" de /v1/chat/completions con tools.
//
// Medido en vivo contra Qwen real (2026-09-08, qwen3.8-max, celda F de probe-matrix,
// LOG_LEVEL=INFO para que el warn del gate fuera visible): de 5 rechazos del gate,
// 3 fueron `invalid_control` y 2 `invalid_tool_call:tool_errors`. CERO fueron `bare`.
// El texto exacto que el modelo emitio en los tres invalid_control tenia siempre la
// MISMA forma — prosa de razonamiento filtrada al canal de respuesta, y detras un par
// <agent_final>...</agent_final> perfectamente bien formado:
//
//   "The image is clearly visible - it's a solid magenta/fuchsia color. I can directly
//    identify the dominant color without needing any tools.\n\n<agent_final>Magenta</agent_final>"
//
// La respuesta es correcta y esta completa. `unwrapExactTag` la tiraba porque su regex
// esta anclada en los DOS extremos, asi que solo un envoltorio que ocupe la cadena entera
// parseaba; cualquier otra cosa con un tag dentro caia en `invalid_control` y, sin cupo de
// rendicion para esa familia, quemaba los 3 intentos y salia como HTTP 429.
//
// El gemelo Anthropic ya entrega esta misma forma con 200 (createAgentTagStripper, cuyo
// comentario en agent-turn.js:224-229 dice literalmente que juzgar "prosa + envoltorio"
// como invalido solo hace fallar el turno entero). Esto es paridad, no politica nueva.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const { parseAgentControlText, buildAgentRetryHint } = require('../src/utils/agent-turn.js')
const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime.js')
const { Logger } = require('../src/utils/logger.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

// La forma exacta observada en vivo, byte por byte.
const LIVE_PROSE_THEN_WRAPPER = "The image is clearly visible - it's a solid magenta/fuchsia color. I can directly identify the dominant color without needing any tools.\n\n<agent_final>Magenta</agent_final>"

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`
const turnStream = (...frames) => Readable.from([
  ...frames,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
])
const runTurn = (text, overrides = {}) => runOpenAIAgentTurn(
  turnStream(answerFrame(text)),
  {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: ['get_time'],
    agent_turn_max_attempts: 3,
    upstream_request_body: { messages: [{ role: 'user', content: 'name the dominant colour' }] },
    sendChatRequest: async () => ({ status: true, response: turnStream(answerFrame(text)) }),
    ...overrides
  }
)

// ---------------------------------------------------------------- parseAgentControlText

test('control parse: la forma medida en vivo (prosa + par bien formado) es un final valido', () => {
  const parsed = parseAgentControlText(LIVE_PROSE_THEN_WRAPPER)
  assert.equal(parsed.kind, 'final')
  // Se conservan las DOS mitades, sin tags: identico a lo que el gemelo Anthropic ya
  // entrega hoy para este mismo texto. Nada de lo que el modelo produjo se pierde.
  assert.match(parsed.text, /^The image is clearly visible/)
  assert.match(parsed.text, /Magenta$/)
  assert.doesNotMatch(parsed.text, /<\/?agent_final>/i)
})

test('control parse: prosa DESPUES del par tambien es un final valido', () => {
  const parsed = parseAgentControlText('<agent_final>Magenta</agent_final>\n\nEspero que ayude.')
  assert.equal(parsed.kind, 'final')
  assert.equal(parsed.text, 'Magenta\n\nEspero que ayude.')
})

test('control parse: el par dentro de una valla de codigo sigue siendo un final valido', () => {
  const parsed = parseAgentControlText('```\n<agent_final>listo</agent_final>\n```')
  assert.equal(parsed.kind, 'final')
  assert.match(parsed.text, /listo/)
  assert.doesNotMatch(parsed.text, /agent_final/i)
})

test('control parse: agent_blocked con prosa alrededor conserva su clase', () => {
  const parsed = parseAgentControlText('Necesito permiso.\n<agent_blocked>falta el token</agent_blocked>')
  assert.equal(parsed.kind, 'blocked')
  assert.match(parsed.text, /falta el token/)
})

// El envoltorio exacto es el camino feliz y no puede cambiar ni un byte.
test('control parse: el envoltorio exacto sigue devolviendo solo el cuerpo', () => {
  assert.deepEqual(parseAgentControlText('<agent_final>done</agent_final>'), { kind: 'final', text: 'done' })
  assert.equal(parseAgentControlText('done').kind, 'bare')
  assert.equal(parseAgentControlText('').kind, 'empty')
})

// Lo que SIGUE siendo invalido: formas realmente rotas, no resbalones de formato.
test('control parse: un tag desbalanceado sigue siendo invalid_control', () => {
  assert.equal(parseAgentControlText('<agent_final>sin cerrar').kind, 'invalid_control')
  assert.equal(parseAgentControlText('sin abrir</agent_final>').kind, 'invalid_control')
  assert.equal(parseAgentControlText('</agent_final>texto<agent_final>').kind, 'invalid_control')
})

test('control parse: dos pares o dos familias con prosa alrededor siguen siendo invalid_control', () => {
  // El turno declara "terminé" y "estoy bloqueado" a la vez: no hay lectura correcta.
  assert.equal(
    parseAgentControlText('Texto <agent_final>hecho</agent_final> y <agent_blocked>o no</agent_blocked>').kind,
    'invalid_control'
  )
  // Dos conclusiones distintas para el mismo turno.
  assert.equal(
    parseAgentControlText('Antes <agent_final>uno</agent_final> y <agent_final>dos</agent_final> despues').kind,
    'invalid_control'
  )
  // Nota de alcance: una cadena que EMPIEZA por el tag de apertura y TERMINA por el de
  // cierre la sigue absorbiendo `unwrapExactTag` con su body perezoso, exactamente igual
  // que antes de este arreglo. Es comportamiento preexistente, no lo toca esta spec.
})

// --------------------------------------------------------------------- runOpenAIAgentTurn

test('gate: la ronda medida en vivo se entrega con 200 al primer intento, no con 429', async () => {
  const result = await runTurn(LIVE_PROSE_THEN_WRAPPER)
  assert.equal(result.ok, true, 'esta ronda producia HTTP 429 upstream_agent_turn_incomplete')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.attempts, 1, 'sin reintentos: no se gasta cuota corrigiendo una respuesta correcta')
  assert.match(result.attempt.visibleText, /Magenta/)
  assert.doesNotMatch(result.attempt.visibleText, /agent_final/i)
})

test('gate: un invalid_control real se entrega en el ultimo intento en vez de morir con 429', async () => {
  // Desbalanceado de verdad: se reintenta (el hint puede corregirlo), pero si el modelo
  // insiste, el cliente recibe la respuesta pelada — nunca un error HTTP. Es la unica
  // familia de rechazo que hoy no tiene cupo de rendicion; intercepted/malformed_protocol
  // ya lo tienen (protocol_recovery_used).
  let sent = 0
  const result = await runTurn('<agent_final>respuesta a medio envolver', {
    sendChatRequest: async () => {
      sent += 1
      return { status: true, response: turnStream(answerFrame('<agent_final>respuesta a medio envolver')) }
    }
  })
  assert.equal(sent, 2, 'se agotan los reintentos antes de rendirse')
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.attempt.visibleText.includes('respuesta a medio envolver'), true)
  assert.doesNotMatch(result.attempt.visibleText, /agent_final/i, 'el tag nunca se filtra al cliente')
})

test('gate: sin texto entregable el invalid_control agotado sigue siendo un error, no un stop falso', async () => {
  const result = await runTurn('<agent_final>   ', {
    sendChatRequest: async () => ({ status: true, response: turnStream(answerFrame('<agent_final>   ')) })
  })
  assert.equal(result.ok, false, 'no hay nada que entregar: inventar un stop seria mentir')
})

test('gate: el agotamiento deja de anunciarse como rate limit (429) y pasa a 502', async () => {
  // `bare` conserva su politica deliberada (no fabricar una conclusion), pero el status
  // 429 hacia que chat.js:188 lo etiquetara `rate_limit_error`: un cliente agentico lee
  // "te estan limitando, echate atras" cuando nadie limito nada, y reintenta el turno
  // entero contra la misma cuenta. Nada aqui fue un limite de tasa.
  const result = await runTurn('Looks good.')
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 502)
  assert.equal(result.error.code, 'upstream_agent_turn_incomplete')
})

test('streaming: la ronda medida en vivo llega entera al cliente SSE, sin tags y sin duplicar', async () => {
  // El parser incremental marca `invalid` en cuanto ve prosa antes del tag, asi que NO emite
  // nada en vivo (streamedVisibleText vacio → no dispara el 422 de stream invalidado). El
  // texto tiene que salir entero por el buffer del final. Este es el camino con mas riesgo
  // del arreglo: si saliera vacio, el cliente veria un `stop` sin un solo delta de contenido.
  const { handleStreamResponse } = require('../src/controllers/chat.js')
  const res = {
    output: '', headers: {}, statusCode: 200,
    status(code) { this.statusCode = code; return this },
    set(h) { Object.assign(this.headers, h); return this },
    write(chunk) { this.output += chunk; return true },
    end(chunk) { if (chunk) this.output += chunk; this.writableEnded = true },
    json(payload) { this.output += JSON.stringify(payload) },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) }
  }
  await handleStreamResponse(
    res,
    turnStream(answerFrame(LIVE_PROSE_THEN_WRAPPER)),
    false,
    false,
    { messages: [{ role: 'user', content: 'name the dominant colour' }] },
    { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'], agent_turn_max_attempts: 3 }
  )

  assert.equal(res.statusCode, 200)
  assert.doesNotMatch(res.output, /upstream_agent_turn_incomplete/)
  const streamed = res.output.split('\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => { try { return JSON.parse(line.slice(6)) } catch (_) { return null } })
    .map(payload => payload?.choices?.[0]?.delta?.content || '')
    .join('')
  assert.match(streamed, /Magenta/)
  assert.match(streamed, /^The image is clearly visible/)
  assert.doesNotMatch(streamed, /agent_final/i)
  assert.equal(streamed.match(/Magenta/g).length, 1, 'una sola copia: nada se emitio en vivo y luego otra vez')
})

test('gate: el hint de invalid_control nombra la restriccion que se sigue exigiendo', () => {
  const hint = buildAgentRetryHint('invalid_control')
  // Con el desanclaje, invalid_control ya solo significa tags desbalanceados/duplicados.
  // El hint tiene que decir ESO; el texto anterior ("malformed or mixed wrapper") no le
  // decia al modelo que arreglar, y por eso los 3 intentos fallaban identicos.
  assert.match(hint, /exactly one/i)
  assert.match(hint, /<agent_final>/)
})

// ------------------------------------------------------------------------------- logger

test('logger: un LOG_LEVEL en minusculas no puede apagar todos los logs', () => {
  // .env de este repo trae `LOG_LEVEL=info` en minusculas. `levels['info']` es undefined y
  // `undefined >= 1` es false, asi que TODO log quedaba silenciado — incluido el unico
  // rastro que este fallo deja en produccion (`Agent attempt N/M 被回合门禁拒绝 (...)`).
  const lower = new Logger({ level: 'info' })
  assert.equal(lower.shouldLog('WARN'), true)
  assert.equal(lower.shouldLog('DEBUG'), false)
  // Un valor desconocido no debe apagar nada: se cae a INFO.
  const bogus = new Logger({ level: 'verbose' })
  assert.equal(bogus.shouldLog('WARN'), true)
})
