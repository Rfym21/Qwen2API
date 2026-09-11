// El 429 "1 de cada 4" de /v1/chat/completions con tools.
//
// Medido en vivo contra Qwen real (2026-09-08, qwen3.8-max, celda F de probe-matrix,
// LOG_LEVEL=INFO para que el warn del gate fuera visible): de 5 rechazos del gate,
// 3 fueron `invalid_control` y 2 `invalid_tool_call:tool_errors`; en esa tanda no salio
// ningun `bare`. OJO CON ESE DATO: una verificacion posterior con n=5 sobre la MISMA celda
// SI observo un rechazo `bare` en el log del gate, asi que la familia `bare` no esta
// descartada — solo es minoritaria, y n=10 era demasiado poco para afirmar lo contrario.
// Un `bare` agotado sigue siendo un error HTTP duro (502) a proposito: ahi el modelo nunca
// declaro un cierre, y fabricarlo esta prohibido por config/index.js:58.
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

const { parseAgentControlText, buildAgentRetryHint, stripAgentTags } = require('../src/utils/agent-turn.js')
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

test('control parse: texto DESPUES del cierre no es un cierre — sigue siendo invalid_control', () => {
  // El cierre tiene que ser lo ultimo. Esta forma nunca se observo en vivo, y aceptarla es
  // justo lo que rompia el veto de `bare`: cualquier prosa con un par balanceado dentro
  // —«luego emito <agent_final>el resumen</agent_final> cuando acabe»— se promovia a `final`
  // y se entregaba como turno COMPLETO al primer intento. Un plan entregado como tarea
  // terminada es exactamente lo que config/index.js:58 prohibe.
  assert.equal(
    parseAgentControlText('<agent_final>Magenta</agent_final>\n\nEspero que ayude.').kind,
    'invalid_control'
  )
})

test('control parse: un tag incidental a mitad de frase NO cierra el turno', () => {
  // Reproducido por el revisor adversario: estas dos formas se entregaban con
  // finish_reason=stop al primer intento, sin un solo reintento.
  assert.equal(
    parseAgentControlText('Next I will read the file and then emit <agent_final>the summary</agent_final> when done.').kind,
    'invalid_control'
  )
  assert.equal(
    parseAgentControlText('To finish, emit <agent_final>your report</agent_final> exactly once.').kind,
    'invalid_control'
  )
})

test('control parse: un par dentro de una valla de codigo no cierra el turno', () => {
  // La valla continua despues del cierre, asi que el tag es documentacion, no un cierre.
  // Tratarlo como `final` ademas entregaria «```\nlisto\n```» como respuesta final, que es
  // peor que regenerar. Es la conducta previa a esta spec, restaurada a proposito.
  assert.equal(parseAgentControlText('```\n<agent_final>listo</agent_final>\n```').kind, 'invalid_control')
})

test('control parse: un desfase de indices por toLowerCase se rechaza, no muerde el texto', () => {
  // `İ` (U+0130) mide 1 en el original y 2 en minusculas, asi que los indices calculados
  // sobre el lowercase dejan de valer. Esos offsets ya no solo recortan el texto: tambien
  // rebasan los spans de residuo, asi que un desfase corromperia la respuesta entregada.
  const skewed = 'İİİ prosa\n<agent_final>Magenta</agent_final>'
  const parsed = parseAgentControlText(skewed)
  assert.equal(parsed.kind, 'invalid_control', 'se regenera en vez de cortar en el sitio equivocado')
  // Sin caracteres que desfasen, la MISMA forma se acepta con normalidad.
  assert.equal(parseAgentControlText('III prosa\n<agent_final>Magenta</agent_final>').kind, 'final')
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
})

test('control parse: hueco conocido — dos pares que abren y cierran la cadena NO se rechazan', () => {
  // Correccion de una afirmacion falsa del commit anterior ("doubled shapes still reject").
  // `unwrapExactTag` esta anclado en los dos extremos pero su cuerpo es perezoso CON
  // backtracking, asi que una cadena que empieza por la apertura y termina por el cierre la
  // absorbe entera, con los tags interiores dentro del cuerpo. Es preexistente (anterior a
  // esta spec) y no lo toca este arreglo; se pincha aqui para que nadie lea el test de arriba
  // como "los pares dobles estan cubiertos".
  const parsed = parseAgentControlText('<agent_final>uno</agent_final> y <agent_final>dos</agent_final>')
  assert.equal(parsed.kind, 'final')
  assert.match(parsed.text, /<\/agent_final>/)
  // No hay fuga al cliente: la capa de entrega pela las etiquetas (chat.js#peelDeliverableText).
  assert.doesNotMatch(stripAgentTags(parsed.text), /agent_final/i)
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

test('gate: un invalid_control agotado falla con 502 — nunca con un stop fabricado', async () => {
  // Aqui NO hay cupo de rendicion, y es deliberado. Se probo darselo y la verificacion
  // adversaria lo tumbo: tras anclar el cierre al final, lo que queda en invalid_control son
  // justo las formas que NO declaran un cierre legible (desbalanceadas, invertidas, dobles,
  // dos familias) — el mismo caso que `bare` y `empty` tienen vetado por config/index.js:58.
  let sent = 0
  const result = await runTurn('<agent_final>respuesta a medio envolver', {
    sendChatRequest: async () => {
      sent += 1
      return { status: true, response: turnStream(answerFrame('<agent_final>respuesta a medio envolver')) }
    }
  })
  assert.equal(sent, 2, 'se gastan los reintentos antes de rendirse')
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 502)
  assert.equal(result.error.code, 'upstream_agent_turn_incomplete')
})

test('gate: sin requestSender la primera ronda malformada tampoco se entrega como stop', async () => {
  // El `break` del bucle salta tanto por agotamiento como por no haber requestSender. Con el
  // cupo de rendicion, ese segundo camino entregaba la PRIMERA ronda malformada con
  // finish_reason=stop y attempts=1, sin un solo reintento.
  const result = await runTurn('<agent_final>respuesta a medio envolver', { sendChatRequest: undefined })
  assert.equal(result.ok, false, 'un turno sin cierre declarado nunca es un stop')
  assert.equal(result.error.status, 502)
})

test('gate: un turno que declara «terminado» y «bloqueado» a la vez nunca se entrega', async () => {
  // Reproducido por el revisor adversario: se entregaba como turno completo con
  // finish_reason=stop, uniendo las dos mitades — «task complete and I need your DB password».
  const contradictory = 'x <agent_final>task complete</agent_final> and <agent_blocked>I need your DB password</agent_blocked>'
  const result = await runTurn(contradictory)
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 502)
})

test('gate: un tag incidental no se entrega como turno terminado', async () => {
  // El plan «luego emito <agent_final>el resumen</agent_final> cuando acabe» llegaba al
  // cliente como tarea terminada, al primer intento y sin reintentos.
  const plan = 'Next I will read the file and then emit <agent_final>the summary</agent_final> when done.'
  const result = await runTurn(plan)
  assert.equal(result.ok, false, 'un plan no es una conclusion')
  assert.equal(result.error.status, 502)
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

// -------------------------------------------------------------- residuo tras el desenvoltorio
//
// El desenvoltorio tolerante quita los tags de EN MEDIO del texto, asi que el entregable deja
// de ser un tramo contiguo de `cleanedText`. rebaseResidueSpans localizaba ese tramo con un
// `indexOf`: devolvia -1 y descartaba TODOS los spans, o sea que la ronda se aceptaba con el
// residuo sin pelar y un `[END TOOL CALL]` huerfano volvia a salir como texto del asistente —
// la fuga (20 de 29.352 turnos reales) que la spec T7 habia cerrado. Los tres revisores
// adversarios la encontraron por separado. Se arregla rebasando por segmentos.
const RESIDUE_ROUND = 'Ya inspeccione el archivo.\n[END TOOL CALL]\nEso es todo.\n\n<agent_final>Listo</agent_final>'

test('residuo: el desenvoltorio tolerante devuelve los segmentos que permiten rebasar', () => {
  const parsed = parseAgentControlText(RESIDUE_ROUND)
  assert.equal(parsed.kind, 'final')
  assert.ok(Array.isArray(parsed.segments) && parsed.segments.length > 0,
    'sin segmentos el rebase vuelve al indexOf que no puede con un corte interior')
  // El texto entregable NO es un tramo contiguo del original: ese es justo el caso que rompia.
  assert.equal(RESIDUE_ROUND.includes(parsed.text), false)
})

test('residuo: una ronda tolerada conserva sus spans en vez de tirarlos al suelo', async () => {
  const result = await runTurn(RESIDUE_ROUND)
  assert.equal(result.ok, true)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.attempt.residueSpans.length, 1, 'el span se descartaba entero (indexOf === -1)')
  const span = result.attempt.residueSpans[0]
  assert.equal(span.text, '[END TOOL CALL]')
  // Rebasado a coordenadas de visibleText: la capa de entrega pela por POSICION, nunca busca.
  assert.equal(result.attempt.visibleText.slice(span.at, span.at + span.text.length), span.text)
})

test('residuo: el marcador huerfano no llega al cliente por SSE', async () => {
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
    turnStream(answerFrame(RESIDUE_ROUND)),
    false,
    false,
    { messages: [{ role: 'user', content: 'que hiciste' }] },
    {
      has_tools: true,
      tool_choice: 'auto',
      allowed_tool_names: ['get_time'],
      agent_turn_max_attempts: 3,
      sendChatRequest: async () => ({ status: true, response: turnStream(answerFrame(RESIDUE_ROUND)) })
    }
  )
  assert.equal(res.statusCode, 200)
  const delivered = res.output.split('\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => { try { return JSON.parse(line.slice(6)) } catch (_) { return null } })
    .map(payload => payload?.choices?.[0]?.delta?.content || '')
    .join('')
  assert.doesNotMatch(delivered, /\[END TOOL CALL\]/, 'protocolo crudo entregado como texto del asistente')
  assert.match(delivered, /Ya inspeccione el archivo/)
  assert.match(delivered, /Listo/)
})

test('residuo: el markdown de imagen que el proxy antepone sobrevive al pelado', async () => {
  // El proxy vuelca `pendingImages` en cuanto arranca el canal de respuesta, o sea que la
  // imagen va SIEMPRE delante del texto del modelo. Quedarse solo con el cuerpo del envoltorio
  // la borraria; el rebase por segmentos tampoco puede desplazarla ni morderla.
  const withImage = '![image](https://x/y.png)\n\n[END TOOL CALL]\n\n<agent_final>Magenta</agent_final>'
  const result = await runTurn(withImage)
  assert.equal(result.ok, true)
  assert.equal(result.attempt.residueSpans.length, 1)
  assert.match(result.attempt.visibleText, /^!\[image\]\(https:\/\/x\/y\.png\)/)
  assert.match(result.attempt.visibleText, /Magenta$/)
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
