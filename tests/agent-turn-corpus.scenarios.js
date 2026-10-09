'use strict'

/**
 * Corpus de caracterización del gate de turno agéntico (issue 03, .scratch/agent-turn-gate).
 *
 * Congela QUÉ HACE HOY el código de aceptación de turno en las cuatro células de la
 * matriz — superficie × modo de streaming — para que el refactor de los tickets 04..07
 * (una sola puerta) tenga que aparecer como un diff nombrado contra este archivo. El
 * baseline versionado lo escribe tools/dev-probes/record-agent-turn-corpus.js; el test
 * permanente (tests/agent-turn-corpus.test.js) reproduce el corpus y afirma cada
 * entrada grabada.
 *
 * Este módulo NO lleva sufijo `.test.js` a propósito: no es un archivo de test (el gate
 * de conteo lista tests/*.test.js), es el escenario compartido entre el grabador y el
 * test. No introduce ninguna costura nueva: conduce los handlers ya exportados
 * (`handleStreamResponse` / `handleNonStreamResponse` con `has_tools: true`, y
 * `handleAnthropicStream` / `handleAnthropicNonStream`) inyectando un sender con guion
 * por las opciones que la producción ya usa (`options.sendChatRequest` / `ctx.sendRequest`),
 * con una respuesta falsa. Sin red, sin cuentas, sin login: el sender es un guion.
 *
 * Lo grabado por escenario es lo observable, nunca un interno: status terminal, frames o
 * cuerpo entregados, si el reintento se disparó y cuántos envíos al upstream hizo, y el
 * texto del hint que viajó al modelo (el contrato de cara al modelo es lo primero que
 * deriva en un refactor).
 *
 * Los tokens de razón NO se graban: son internos y sólo se manifiestan a través de su
 * hint. Un renombre de token que deje el hint igual es invisible acá — y también lo es
 * para el cliente, que es lo que este corpus protege.
 *
 * `applicable` y `targets` son la DECLARACIÓN de intención del escenario, no evidencia:
 * viajan a la fila para documentarla, pero las copia la declaración, no una medición. La
 * evidencia son las columnas observadas (status, envíos, frames servidos, hints,
 * entregado), y los invariantes que las cruzan viven en `corpusViolations`.
 */

// Pines de política ANTES de cualquier require que arrastre config/index.js (que hace
// dotenv.config() y congela el entorno al cargarse). El baseline no puede depender de los
// defaults de la máquina que lo corre: sin esto, un LEGACY_REASONING_IN_CONTENT=true en el
// shell del operador reescribiría el baseline.
process.env.AGENT_TURN_MAX_ATTEMPTS = '3'
process.env.AGENT_TURN_ALLOW_PROSE_WITH_TOOLS = 'false'
process.env.AGENT_TURN_ACCEPT_BARE_FINAL = 'false'
process.env.LEGACY_REASONING_IN_CONTENT = 'false'
// Sin cuentas que cargar: en DATA_SAVE_MODE=none un ACCOUNTS no vacío dispara logins reales
// al importar utils/account.js (que los controllers cargan).
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
// Ruido, no comportamiento: el corpus imprime su propia tabla y no debe escribir logs a disco.
process.env.LOG_LEVEL = 'error'
process.env.ENABLE_FILE_LOG = 'false'

const { handleStreamResponse, handleNonStreamResponse } = require('../src/controllers/chat.js')
const { handleAnthropicStream, handleAnthropicNonStream } = require('../src/controllers/anthropic.js')

// ───────────────────────────── herramientas ─────────────────────────────

/** Las mismas tres herramientas en las cuatro células: el corpus compara superficies. */
const ALLOWED_TOOL_NAMES = ['Read', 'Bash', 'Edit']
const TOOL_SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  Edit: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
}

const BASE_PROMPT = 'CORPUS-BASE-PROMPT: do the task'

/** Marcador canónico del protocolo de texto: el mismo que enseña el prompt de agente. */
const textCall = (name, argsJson) => `[TOOL CALL]{"name":"${name}","arguments":${argsJson}}[END TOOL CALL]`
const READ_CALL = textCall('Read', '{"file_path":"a.txt"}')

// ─────────────────────────── builders de frames ───────────────────────────

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`

const answer = (content) => sse({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})
const think = (content) => sse({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})
/**
 * Frame `role:function` con el que la plataforma devuelve el resultado de una llamada (o su
 * ausencia). Es la forma que necesita el escenario `intercepted`: sin este frame no hay
 * nada que el normalizador pueda descartar.
 */
const droppedResult = (name) => sse({
  choices: [{
    delta: {
      role: 'function', phase: 'answer', status: 'typing', name,
      content: `Tool ${name} does not exists.`
    },
    finish_reason: null
  }]
})

/** Terminador de ronda: finish_reason=stop + [DONE]. */
const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

/** Ronda de recuperación compartida: una llamada limpia que satisface cualquier required. */
const RECOVERY_ROUND = [answer(READ_CALL), STOP]

/**
 * Upstream de una ronda. Generador crudo, no Readable.from: un corte del canal de texto
 * destruye el upstream y el generador se detiene donde tocó (Readable.from precargaría).
 * `served` cuenta los frames que el consumidor llegó a tirar: es el observable que hace
 * falsable "la guarda abortó el intento a mitad de stream" (si nadie corta, served = total).
 */
const framesStream = (frames) => {
  const stream = (async function* () {
    for (const frame of frames) {
      stream.served += 1
      yield frame
    }
  })()
  stream.served = 0
  stream.total = frames.length
  return stream
}

// ────────────────────────────── guion del sender ──────────────────────────────

/**
 * Sender con guion: la primera ronda llega como `upstream` al handler; cada llamada
 * posterior consume la siguiente ronda del guion. Agotado el guion devuelve
 * `{status:false}` (el camino "el reintento no arrancó").
 */
const scriptedSender = (retryRounds) => {
  const queue = [...retryRounds]
  const fn = async (body) => {
    fn.calls.push(body)
    const round = queue.shift()
    return round ? { status: true, response: framesStream(round) } : { status: false }
  }
  fn.calls = []
  return fn
}

/** El hint que viajó al upstream: lo que el reintento AÑADIÓ al último mensaje del cuerpo. */
const hintOf = (sentBody, baseBody) => {
  const last = Array.isArray(sentBody?.messages) ? sentBody.messages[sentBody.messages.length - 1] : null
  const baseLast = Array.isArray(baseBody?.messages) ? baseBody.messages[baseBody.messages.length - 1] : null
  const sent = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? null)
  const base = typeof baseLast?.content === 'string' ? baseLast.content : ''
  const added = base && sent.startsWith(base) ? sent.slice(base.length) : sent
  // Se pela sólo el separador que ambas superficies anteponen. El encabezado
  // '# Tool-call retry' de la superficie Anthropic NO se pela: es texto que viaja al modelo,
  // y pelarlo dejaría fuera del baseline cualquier cambio en ese contrato.
  return added.replace(/^\n\n/, '')
}

// ─────────────────────────── respuestas falsas ───────────────────────────

const createStreamResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  destroyed: false,
  statusCode: 200,
  set(headers) { Object.assign(this.headers, headers); return this },
  status(code) { this.statusCode = code; return this },
  write(chunk) { this.headersSent = true; this.output += String(chunk); return true },
  end(chunk = '') { if (chunk) this.write(chunk); this.writableEnded = true },
  json(value) {
    this.headersSent = true
    this.output += JSON.stringify(value)
    this.writableEnded = true
    return this
  }
})

// ──────────────────── extracción del resultado observable ────────────────────

const parseSseFrames = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map((chunk) => {
    const lines = chunk.split('\n')
    const eventLine = lines.find(line => line.startsWith('event: '))
    const dataLine = lines.find(line => line.startsWith('data: '))
    return {
      event: eventLine ? eventLine.slice(7).trim() : null,
      data: dataLine ? dataLine.slice(6) : null
    }
  })
  .filter(frame => frame.data !== null)
  .map((frame) => {
    // [DONE] no es JSON: se marca antes de parsear para que no caiga en `unparsed`.
    if (frame.data === '[DONE]') return { event: frame.event, payload: '[DONE]' }
    try {
      return { event: frame.event, payload: JSON.parse(frame.data) }
    } catch (_) {
      return { event: frame.event, unparsed: frame.data }
    }
  })

// Los ids se acuñan por respuesta (uuid/hex): se graba su FORMA, no su valor, para que el
// baseline no derive en cada corrida. La forma es contrato de cable (prefijos call_/toolu_).
const ID_FORMS = [
  [/^chatcmpl-[0-9a-f-]{36}$/, 'chatcmpl-<uuid>'],
  [/^msg_[0-9a-f]{24}$/, 'msg_<hex24>'],
  [/^call_[0-9a-f]{24}$/, 'call_<hex24>'],
  [/^toolu_[0-9a-f]{24}$/, 'toolu_<hex24>']
]
const scrubId = (id) => {
  if (typeof id !== 'string') return id ?? null
  const match = ID_FORMS.find(([pattern]) => pattern.test(id))
  return match ? match[1] : id
}

/** Frames SSE del cable OpenAI, normalizados a una lista ordenada y estable. */
const openaiStreamOutcome = (res) => {
  const items = []
  for (const frame of parseSseFrames(res.output)) {
    if (frame.unparsed !== undefined) { items.push({ kind: 'unparsed', raw: frame.unparsed }); continue }
    const payload = frame.payload
    if (payload === '[DONE]') { items.push({ kind: 'done' }); continue }
    if (payload.error) {
      items.push({
        kind: 'error',
        code: payload.error.code ?? null,
        type: payload.error.type ?? null,
        message: payload.error.message ?? null
      })
      continue
    }
    if (payload.usage) items.push({ kind: 'usage' })
    const choice = payload.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (delta.role) items.push({ kind: 'role', role: delta.role })
    if (delta.reasoning_content) items.push({ kind: 'reasoning', text: delta.reasoning_content })
    if (delta.content) items.push({ kind: 'content', text: delta.content })
    for (const piece of delta.tool_calls || []) {
      if (piece.function?.name) {
        items.push({ kind: 'tool_call', index: piece.index ?? null, id: scrubId(piece.id), name: piece.function.name })
      } else if (typeof piece.function?.arguments === 'string' && piece.function.arguments) {
        items.push({ kind: 'tool_call_args', index: piece.index ?? null, arguments: piece.function.arguments })
      }
    }
    if (choice.finish_reason) items.push({ kind: 'finish', reason: choice.finish_reason })
  }
  return items
}

/** Cuerpo JSON del cable OpenAI, normalizado. */
const openaiJsonOutcome = (res) => {
  const body = JSON.parse(res.output)
  if (body.error) {
    return [{
      kind: 'error',
      code: body.error.code ?? null,
      type: body.error.type ?? null,
      message: body.error.message ?? null
    }]
  }
  const items = []
  const choice = body.choices?.[0]
  const message = choice?.message || {}
  if (message.reasoning_content) items.push({ kind: 'reasoning', text: message.reasoning_content })
  if (message.content) items.push({ kind: 'content', text: message.content })
  for (const call of message.tool_calls || []) {
    items.push({
      kind: 'tool_call',
      index: call.index ?? null,
      id: scrubId(call.id),
      name: call.function?.name ?? null,
      arguments: call.function?.arguments ?? null
    })
  }
  items.push({ kind: 'finish', reason: choice?.finish_reason ?? null })
  if (body.usage) items.push({ kind: 'usage' })
  return items
}

/** Eventos SSE del cable Anthropic, normalizados (sin ping: es ruido de cadencia, no contenido). */
const anthropicStreamOutcome = (res) => {
  const items = []
  for (const frame of parseSseFrames(res.output)) {
    if (frame.unparsed !== undefined) { items.push({ kind: 'unparsed', raw: frame.unparsed }); continue }
    const payload = frame.payload
    switch (payload.type) {
      case 'message_start':
        items.push({ kind: 'message_start' })
        break
      case 'content_block_start': {
        const block = payload.content_block || {}
        if (block.type === 'tool_use') {
          items.push({ kind: 'tool_use_start', index: payload.index, id: scrubId(block.id), name: block.name })
        } else {
          items.push({ kind: `${block.type}_block_start`, index: payload.index })
        }
        break
      }
      case 'content_block_delta': {
        const delta = payload.delta || {}
        if (delta.type === 'text_delta') items.push({ kind: 'content', text: delta.text })
        else if (delta.type === 'thinking_delta') items.push({ kind: 'thinking', text: delta.thinking })
        else if (delta.type === 'input_json_delta') {
          items.push({ kind: 'tool_use_args', index: payload.index, partial_json: delta.partial_json })
        } else if (delta.type === 'signature_delta') items.push({ kind: 'signature', index: payload.index })
        else items.push({ kind: 'unknown_delta', delta_type: delta.type ?? null })
        break
      }
      case 'content_block_stop':
        items.push({ kind: 'block_stop', index: payload.index })
        break
      case 'message_delta':
        items.push({ kind: 'stop_reason', stop_reason: payload.delta?.stop_reason ?? null })
        break
      case 'message_stop':
        items.push({ kind: 'message_stop' })
        break
      case 'error':
        items.push({
          kind: 'error',
          error_type: payload.error?.type ?? null,
          message: payload.error?.message ?? null
        })
        break
      case 'ping':
        break
      default:
        items.push({ kind: payload.type })
    }
  }
  return items
}

/** Cuerpo JSON del cable Anthropic, normalizado. */
const anthropicJsonOutcome = (res) => {
  const body = JSON.parse(res.output)
  if (body.type === 'error') {
    return [{
      kind: 'error',
      error_type: body.error?.type ?? null,
      message: body.error?.message ?? null
    }]
  }
  const items = []
  for (const block of body.content || []) {
    if (block.type === 'text') items.push({ kind: 'content', text: block.text })
    else if (block.type === 'thinking') items.push({ kind: 'thinking', text: block.thinking })
    else if (block.type === 'tool_use') {
      items.push({ kind: 'tool_use', id: scrubId(block.id), name: block.name, input: block.input })
    } else items.push({ kind: 'unknown_block', block_type: block.type ?? null })
  }
  items.push({ kind: 'stop_reason', stop_reason: body.stop_reason ?? null })
  return items
}

// ───────────────────────────── las cuatro células ─────────────────────────────

const baseRequestBodies = () => ({
  openai: { messages: [{ role: 'user', content: BASE_PROMPT }] },
  anthropic: { messages: [{ role: 'user', content: BASE_PROMPT }] }
})

/** Las opciones que la producción arma para el controlador OpenAI, con el sender inyectado. */
const openAiOptions = (scenario, sender, body) => ({
  has_tools: true,
  tool_choice: scenario.toolChoice || 'auto',
  allowed_tool_names: ALLOWED_TOOL_NAMES,
  tool_schemas: TOOL_SCHEMAS,
  sendChatRequest: sender,
  upstream_request_body: body,
  currentAccount: null,
  upstreamOptions: {}
})

/** El ctx que la producción arma para el controlador Anthropic, con el sender inyectado. */
const anthropicCtx = (scenario, sender, body) => ({
  message_id: 'msg_corpus',
  model: 'qwen-corpus',
  hasTools: true,
  toolChoice: scenario.toolChoice || 'auto',
  requestBody: body,
  allowedToolNames: ALLOWED_TOOL_NAMES,
  toolSchemas: TOOL_SCHEMAS,
  sendRequest: sender,
  historyToolCalls: [],
  upstreamOptions: {}
})

const SURFACES = [
  {
    id: 'openai.stream',
    family: 'openai',
    label: 'OpenAI /v1/chat/completions, stream',
    run: async (scenario, sender) => {
      const res = createStreamResponse()
      const body = baseRequestBodies().openai
      const upstream = framesStream(scenario.rounds[0])
      await handleStreamResponse(res, upstream, true, false, body, openAiOptions(scenario, sender, body))
      return { status: res.statusCode, items: openaiStreamOutcome(res), baseBody: body, upstream }
    }
  },
  {
    id: 'openai.nonstream',
    family: 'openai',
    label: 'OpenAI /v1/chat/completions, non-stream',
    run: async (scenario, sender) => {
      const res = createStreamResponse()
      const body = baseRequestBodies().openai
      const upstream = framesStream(scenario.rounds[0])
      await handleNonStreamResponse(res, upstream, true, false, 'qwen-corpus', body, openAiOptions(scenario, sender, body))
      return { status: res.statusCode, items: openaiJsonOutcome(res), baseBody: body, upstream }
    }
  },
  {
    id: 'anthropic.stream',
    family: 'anthropic',
    label: 'Anthropic /v1/messages, stream',
    run: async (scenario, sender) => {
      const res = createStreamResponse()
      const ctx = anthropicCtx(scenario, sender, baseRequestBodies().anthropic)
      const upstream = framesStream(scenario.rounds[0])
      await handleAnthropicStream(res, ctx, upstream)
      return { status: res.statusCode, items: anthropicStreamOutcome(res), baseBody: ctx.requestBody, upstream }
    }
  },
  {
    id: 'anthropic.nonstream',
    family: 'anthropic',
    label: 'Anthropic /v1/messages, non-stream',
    run: async (scenario, sender) => {
      const res = createStreamResponse()
      const ctx = anthropicCtx(scenario, sender, baseRequestBodies().anthropic)
      const upstream = framesStream(scenario.rounds[0])
      await handleAnthropicNonStream(res, ctx, upstream)
      return { status: res.statusCode, items: anthropicJsonOutcome(res), baseBody: ctx.requestBody, upstream }
    }
  }
]

// ─────────────────────────────── el corpus ───────────────────────────────
//
// `targets` es la lista de tokens de razón que el escenario pretende cubrir EN ESA
// superficie, en orden de ronda (vacía = el escenario es un "aceptar", no un reintento).
// `applicable: false` marca que el token no existe en esa superficie; los frames se
// conducen igual y se graba lo que la superficie HACE con ellos, porque "aquí ese token
// no existe, y esto es lo que ocurre en su lugar" también es parte de lo congelado —
// omitir la fila dejaría creer que la superficie se comporta como la otra.

const NARRATION = 'The Bash tool seems unavailable in this environment, so the task cannot continue.'
const UNEXECUTED_ACTION = 'I will read the file now and then summarise what it contains.'
const PLAIN_PROSE = 'The answer is 42, and no tool is needed for it.'
const BROKEN_SIBLING = textCall('WebFetch', '{"url":"https://example.com"}')
const MALFORMED_PROTOCOL_LEAK = '{"name": "RunCommand", "arguments": {"command": "ls -la"}}'

const SCENARIOS = [
  {
    id: 'accept_tool_call',
    group: 'accept',
    title: 'a clean tool call',
    targets: { 'openai.stream': [], 'openai.nonstream': [], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: true },
    rounds: [[answer(READ_CALL), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'accept_final_answer',
    group: 'accept',
    title: 'final answer with no tool call',
    targets: { 'openai.stream': [], 'openai.nonstream': [], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: true },
    rounds: [[answer('<agent_final>All requested work is complete.</agent_final>'), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'required_tool',
    group: 'retry',
    title: 'tool_choice requires a call, the round has none',
    targets: { 'openai.stream': ['required_tool'], 'openai.nonstream': ['required_tool'], 'anthropic.stream': ['required'], 'anthropic.nonstream': ['required'] },
    applicable: { openai: true, anthropic: true },
    toolChoice: 'required',
    // Ronda sin texto visible a propósito: con una respuesta final envuelta, el texto ya
    // salió al cliente y la guarda de stream invalidado (422) veta el reintento en la
    // superficie OpenAI stream ANTES de que el gate decida — la celda dejaría de cubrir
    // `required_tool`. Sólo piensa: el gate mira `required` antes que `empty`, así que la
    // razón sigue siendo la que el escenario persigue (y el hint lo confirma).
    rounds: [[think('The user wants a tool run, but I should answer in prose instead.'), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'tool_error',
    group: 'retry',
    title: 'a malformed tool call',
    targets: { 'openai.stream': ['invalid_tool_call'], 'openai.nonstream': ['invalid_tool_call'], 'anthropic.stream': ['tool_error'], 'anthropic.nonstream': ['tool_error'] },
    applicable: { openai: true, anthropic: true },
    // Tercera herramienta declarada, nombre inexistente: error DURO del parser (unknown_tool),
    // el mismo que distingue "el modelo inventó un nombre" de "el protocolo se rompió".
    rounds: [[answer(textCall('WebFetch', '{"url":"https://example.com"}')), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'prose_with_tools',
    group: 'retry',
    title: 'prose alongside a parsed tool call',
    // Celda de asimetría deliberada (policy `proseWithTools`): OpenAI reintenta, Anthropic
    // acepta. En Anthropic la fila SÍ aplica — su expectativa es "aceptar y entregar".
    targets: { 'openai.stream': ['invalid_tool_call:prose_with_tools'], 'openai.nonstream': ['invalid_tool_call:prose_with_tools'], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: true },
    rounds: [[answer(`Sure, let me look at that file.\n\n${READ_CALL}`), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'intercepted',
    group: 'retry',
    title: 'a dropped role:function frame with no call',
    targets: { 'openai.stream': ['intercepted'], 'openai.nonstream': ['intercepted'], 'anthropic.stream': ['intercepted'], 'anthropic.nonstream': ['intercepted'] },
    applicable: { openai: true, anthropic: true },
    rounds: [[droppedResult('Read'), answer(NARRATION), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'malformed_protocol',
    group: 'retry',
    title: 'orphan protocol residue in the visible text',
    targets: { 'openai.stream': ['malformed_protocol'], 'openai.nonstream': ['malformed_protocol'], 'anthropic.stream': ['malformed_protocol'], 'anthropic.nonstream': ['malformed_protocol'] },
    applicable: { openai: true, anthropic: true },
    // Payload pelado al inicio y SIN cierre: el gate de rescate lo rechaza en blando (no es
    // error del parser), así que queda como residuo huérfano en la prosa visible.
    rounds: [[answer(MALFORMED_PROTOCOL_LEAK), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'thought_tool_call',
    group: 'retry',
    title: 'a call leaked into the reasoning phase',
    targets: { 'openai.stream': [], 'openai.nonstream': [], 'anthropic.stream': ['thought_tool_call'], 'anthropic.nonstream': ['thought_tool_call'] },
    applicable: { openai: false, anthropic: true },
    rounds: [[think(READ_CALL), answer('I have read the file and here is my summary.'), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'missing_tool',
    group: 'retry',
    title: 'prose that describes an action without calling a tool',
    targets: { 'openai.stream': [], 'openai.nonstream': [], 'anthropic.stream': ['missing_tool'], 'anthropic.nonstream': ['missing_tool'] },
    applicable: { openai: false, anthropic: true },
    rounds: [[answer(UNEXECUTED_ACTION), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'empty',
    group: 'retry',
    title: 'reasoning only, no visible output',
    targets: { 'openai.stream': ['empty'], 'openai.nonstream': ['empty'], 'anthropic.stream': ['empty'], 'anthropic.nonstream': ['empty'] },
    applicable: { openai: true, anthropic: true },
    rounds: [[think('Let me consider the request before answering.'), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'bare',
    group: 'retry',
    title: 'prose with no completion wrapper',
    targets: { 'openai.stream': ['bare'], 'openai.nonstream': ['bare'], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: false },
    rounds: [[answer(PLAIN_PROSE), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'invalid_control',
    group: 'retry',
    title: 'an unbalanced completion wrapper',
    targets: { 'openai.stream': ['invalid_control'], 'openai.nonstream': ['invalid_control'], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: false },
    // La etiqueta abierta SIN cuerpo: con cuerpo, el texto ya salió al cliente y la guarda
    // de stream invalidado (422) veta el reintento antes de que el gate lo decida — la
    // celda dejaría de cubrir `invalid_control` y pasaría a cubrir esa guarda.
    rounds: [[answer('<agent_final>'), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'good_call_with_broken_sibling',
    group: 'combination',
    title: 'one good parsed call beside a broken sibling',
    // Asimetría deliberada (policy `toolErrorsVetoWithCalls`): OpenAI reintenta el conjunto
    // (una llamada parcial es una acción silenciosamente equivocada), Anthropic entrega la
    // llamada buena (bloques discretos: el cliente puede actuar con lo que llegó).
    targets: { 'openai.stream': ['invalid_tool_call:tool_errors'], 'openai.nonstream': ['invalid_tool_call:tool_errors'], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: true },
    rounds: [[answer(`${READ_CALL}\n\n${BROKEN_SIBLING}`), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'tool_error_with_required',
    group: 'combination',
    title: 'a tool error together with an unsatisfied required',
    // Asimetría deliberada (policy `toolErrorsBeforeRequired`): OpenAI veta por error de
    // herramienta antes de mirar `required`; Anthropic mira `required` primero.
    targets: { 'openai.stream': ['invalid_tool_call'], 'openai.nonstream': ['invalid_tool_call'], 'anthropic.stream': ['required'], 'anthropic.nonstream': ['required'] },
    applicable: { openai: true, anthropic: true },
    toolChoice: 'required',
    rounds: [[answer(BROKEN_SIBLING), STOP], RECOVERY_ROUND, RECOVERY_ROUND]
  },
  {
    id: 'delivered_round_then_empty',
    group: 'combination',
    title: 'a delivered round followed by an empty round',
    targets: { 'openai.stream': ['bare', 'empty'], 'openai.nonstream': ['bare', 'empty'], 'anthropic.stream': ['missing_tool'], 'anthropic.nonstream': ['missing_tool', 'empty'] },
    applicable: { openai: true, anthropic: true },
    // Ronda 1 narra sin llamar (rechazada por las tres células que deciden por ronda), ronda
    // 2 sólo piensa. La tercera ronda existe para que el agotamiento no se confunda con "el
    // sender se quedó seco".
    //
    // MEDIDO (2026-10-09): esta fila NO expone la divergencia de alcance de `empty`, que es
    // lo que su comentario afirmaba antes. Mutar el juicio del stream de `visibleText` a
    // `attemptVisibleText` deja el corpus BYTE-IDÉNTICO en las 64 celdas. La razón es
    // estructural: cuando el texto acumulado no está vacío, la guarda de compensación
    // (`if (visibleText.trim())`, anthropic.js) ya se evaluó sobre ese mismo texto acumulado
    // y o bien rompió el loop o bien ya gastó el único reintento posterior a texto visible —
    // así que la ronda vacía nunca llega a decidirse por el alcance de `empty`. La
    // divergencia que la fila sí muestra (2 envíos en el stream contra 3 en las otras dos)
    // la produce esa guarda, no la rama `empty`.
    rounds: [
      [answer(UNEXECUTED_ACTION), STOP],
      [think('Let me reconsider the request from scratch.'), STOP],
      RECOVERY_ROUND
    ]
  },
  {
    id: 'text_channel_cut_with_calls',
    group: 'combination',
    title: 'a text-channel runaway cut with calls already admitted',
    targets: { 'openai.stream': [], 'openai.nonstream': [], 'anthropic.stream': [], 'anthropic.nonstream': [] },
    applicable: { openai: true, anthropic: true },
    requiresCut: true,
    // La ronda repite la llamada (byte-idéntica) y después narra: la guarda corta en el
    // duplicado y destruye el upstream, así que los frames siguientes no se tiran siquiera.
    // El último frame es un hermano roto A PROPÓSITO: si la guarda dejara de cortar, ese
    // error duro entraría al parser y la ronda se reintentaría (2 envíos) en vez de
    // entregarse — el baseline distingue las dos cosas.
    rounds: [
      [
        answer(READ_CALL),
        answer(`\n\n${READ_CALL}`),
        answer('\n\nnarration that must never be served'),
        answer(`\n\n${BROKEN_SIBLING}`),
        STOP
      ],
      RECOVERY_ROUND,
      RECOVERY_ROUND
    ]
  }
]

// ────────────────────────────── el runner ──────────────────────────────

/**
 * Conduce un escenario por una célula y devuelve su resultado observable.
 * @param {Object} scenario - entrada de SCENARIOS
 * @param {Object} surface - entrada de SURFACES
 * @returns {Promise<Object>} entrada del baseline
 */
const runScenario = async (scenario, surface) => {
  const sender = scriptedSender(scenario.rounds.slice(1))
  const { status, items, baseBody, upstream } = await surface.run(scenario, sender)
  const hints = sender.calls.map(call => hintOf(call, baseBody))
  return {
    applicable: scenario.applicable[surface.family] === true,
    targets: scenario.targets[surface.id] ?? [],
    status,
    retried: sender.calls.length > 0,
    upstreamSends: 1 + sender.calls.length,
    // Frames que el handler llegó a tirar del upstream de la primera ronda. served < total
    // es la huella de una guarda que abortó el intento a mitad de stream.
    upstreamFrames: { served: upstream.served, total: upstream.total },
    hints,
    delivered: items
  }
}

/** El corpus completo: { scenarioId: { surfaceId: entrada } }. */
const runCorpus = async () => {
  const out = {}
  for (const scenario of SCENARIOS) {
    out[scenario.id] = {}
    for (const surface of SURFACES) {
      out[scenario.id][surface.id] = await runScenario(scenario, surface)
    }
  }
  return out
}

/** JSON con claves ordenadas: el baseline tiene que diferenciarse limpio. */
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

const stableStringify = (value) => `${JSON.stringify(sortKeys(value), null, 2)}\n`

/**
 * Invariantes anti-baseline-hueco, compartidos por el grabador y el test: una sola
 * implementación, porque dos copias divergen y la que decide si se graba no es la que
 * decide si pasa. Una fila que declara cubrir una razón tiene que haber reintentado (si no,
 * sus frames no llegan al camino que dice cubrir); una fila de aceptación no puede
 * reintentar; toda fila entrega algo al cliente; una fila no aplicable no declara tokens.
 * @param {Object} scenario - entrada de SCENARIOS
 * @param {Object} entry - fila del baseline
 * @param {string} where - etiqueta de la celda para el mensaje
 * @returns {string[]} violaciones; lista vacía = fila sana
 */
const corpusViolations = (scenario, entry, where) => {
  const out = []
  if (entry.delivered.length === 0) out.push(`${where}: no entrega nada al cliente`)
  if (scenario.requiresCut && entry.upstreamFrames.served >= entry.upstreamFrames.total) {
    out.push(`${where}: la guarda de fuga no abortó el stream (${entry.upstreamFrames.served}/${entry.upstreamFrames.total})`)
  }
  if (!entry.applicable) {
    if (entry.targets.length > 0) out.push(`${where}: no aplicable con tokens declarados`)
    return out
  }
  if (entry.targets.length > 0) {
    if (entry.upstreamSends < 2) out.push(`${where}: declara ${entry.targets.join('+')} y no reintentó`)
    // Una razón declarada que no disparó es cobertura que la fila dice tener y no tiene: la
    // fila queda verde afirmando algo que nadie midió. Cada razón declarada dispara una vez,
    // así que el número de hints observados tiene que coincidir con el de tokens declarados.
    if (entry.hints.length !== entry.targets.length) {
      out.push(`${where}: declara ${entry.targets.length} razones (${entry.targets.join('+')}) y sólo ${entry.hints.length} dispararon`)
    }
  } else if (entry.upstreamSends !== 1) {
    out.push(`${where}: es celda de aceptación y reintentó`)
  }
  return out
}

module.exports = {
  SCENARIOS,
  SURFACES,
  runScenario,
  runCorpus,
  corpusViolations,
  stableStringify
}
