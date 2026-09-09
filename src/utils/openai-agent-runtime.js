const { isJson } = require('./tools.js')
const {
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator,
  containsOrphanProtocolResidue,
  ANSWER_PHASES
} = require('./tool-prompt.js')
const { consumeSSEStream, createUpstreamResponseFilter } = require('./sse.js')
const { createUpstreamDeltaNormalizer, createClientToolNamePredicate } = require('./chat-helpers.js')
const { assertNoUpstreamFailure } = require('./upstream-error.js')
const {
  parseAgentControlText,
  createAgentControlStreamParser,
  createAgentTagStripper,
  buildAgentRetryHint,
  // Guarda de fuga del canal de texto: una sola implementacion, compartida con
  // anthropic.js (spec agent-turn-cutoff-openai-parity). El `tag` de log es parametro.
  createToolCallLedger,
  resolveTextToolCallCap,
  createTextChannelRunawayGuard
} = require('./agent-turn.js')
const config = require('../config/index.js')
const { logger } = require('./logger.js')

const NON_RETRYABLE_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'content_filter',
  'refusal'
])

/**
 * Rebasa los spans de residuo de coordenadas de `cleanedText` a las de `visibleText`.
 *
 * `stripToolCallResidue` pela por POSICIÓN, nunca por búsqueda: `at` es el punto que el
 * parser anotó sobre `cleanedText`, y `parseAgentControlText` recorta y — en una ronda
 * final/blocked — desenvuelve el `<agent_final>`, así que entre ambos hay un desplazamiento.
 * Rebasar no es un detalle: envuelto es la ÚNICA forma en la que un residuo llega a
 * entregarse en este camino (el gate rechaza la prosa desnuda con agentTurnAcceptBareFinal
 * en false), o sea que sin esto el pelado no encontraría un solo span y no pelaría nada.
 *
 * DOS MODOS, y el segundo existe por una fuga reproducida:
 *
 * 1. Con `segments` (los que devuelve el desenvoltorio tolerante de agent-turn.js): el texto
 *    entregable NO es un tramo contiguo del original —los tags se quitan de EN MEDIO—, así
 *    que se rebasa segmento a segmento, aritmética pura. Cuando esto no existía, el `indexOf`
 *    del modo 2 devolvía -1 para toda ronda tolerada y se descartaban TODOS los spans: un
 *    `[END TOOL CALL]` huérfano volvía a salir como texto del asistente (la fuga medida en
 *    20 de 29.352 turnos que cerró la spec T7). Verificado por tres revisores adversarios
 *    de forma independiente y pinchado en tests/openai-agent-gate-429.test.js.
 * 2. Sin `segments` (envoltorio exacto, `bare`, `invalid_control`): el texto sí es contiguo;
 *    se exige además que sea NO ambiguo (un `indexOf` a secas elegiría el primero de dos
 *    tramos idénticos y borraría en el sitio equivocado).
 *
 * Fail closed en los dos modos: cada span se revalida contra el destino con la misma regla
 * que aplicará stripToolCallResidue — coincidencia exacta, o cola recortada que sea prefijo
 * del span. Lo que no cuadra se descarta: mejor entregar un residuo que morder la respuesta.
 */
const rebaseResidueSpans = (cleanedText, visibleText, spans, segments = null) => {
  if (!Array.isArray(spans) || spans.length === 0) return []
  const source = String(cleanedText || '')
  const target = String(visibleText || '')
  if (!target) return []
  const usable = spans.filter(span =>
    span && typeof span.text === 'string' && span.text && Number.isInteger(span.at))

  let moved
  if (Array.isArray(segments)) {
    moved = usable
      .map(span => {
        const segment = segments.find(item => span.at >= item.from && span.at < item.to)
        return segment ? { ...span, at: span.at - segment.from + segment.at } : null
      })
      .filter(Boolean)
  } else {
    const offset = source.indexOf(target)
    if (offset === -1 || source.indexOf(target, offset + 1) !== -1) return []
    moved = usable.map(span => ({ ...span, at: span.at - offset }))
  }

  return moved.filter(span => {
    if (span.at < 0 || span.at >= target.length) return false
    const slice = target.slice(span.at, span.at + span.text.length)
    if (slice === span.text) return true
    return slice.length < span.text.length && span.text.startsWith(slice)
  })
}

const normalizeCreatedMetadata = (payload) => {
  const created = payload?.['response.created'] || payload?.response?.created
  if (!created || typeof created !== 'object') return null
  return {
    chatId: created.chat_id || created.chatId || null,
    parentId: created.parent_id || created.parentId || null,
    responseId: created.response_id || created.responseId || null,
    responseIndex: created.response_index ?? created.responseIndex ?? null
  }
}

const imageMarkdownFromDelta = (delta) => {
  const result = []
  for (const item of delta?.extra?.image_list || []) {
    if (item?.image) result.push(`![image](${item.image})`)
  }
  return result
}

/**
 * 原生 function_call 帧的喂入与关闭判定（OpenAI Agent 运行时 / chat.js 旧路径共用；
 * anthropic.js 有同形的私有副本）。完成证据读的是**原始** delta：归一化器对
 * role:function 返回 null（Defect A），不能从它那里拿。
 *
 * - 有 function_call → pushNativeSnapshot（分类在累积器里：无 function_id 且 answer phase
 *   才是客户端候选；think phase / 平台调用关闭时记 unknown_tool，走今天的 invalid_tool_call 重试）。
 * - role:function 且名字是客户端工具（与归一化器同一条谓词）→ closeByName：该调用的
 *   结果帧。无名帧与平台结果帧惰性。
 * - answer 帧 status finished / 非空 finish_reason → 回合结束，打开中的按 round_end 关闭。
 * 每次可能关闭之后都调一次 drain（幂等），关闭即发射。
 * @param {Object} accumulator - createNativeToolCallAccumulator 实例
 * @param {Object} delta - 原始上游 delta
 * @param {*} reportedFinishReason - choice 上报的 finish_reason
 * @param {{ isClientToolName: (name: unknown) => boolean, drain: () => void }} hooks
 */
const feedNativeFrame = (accumulator, delta, reportedFinishReason, { isClientToolName, drain }) => {
  const rawPhase = delta.phase
  if (Array.isArray(delta.tool_calls)) {
    accumulator.push(delta.tool_calls)
  } else if (delta.function_call) {
    accumulator.pushNativeSnapshot({
      name: delta.function_call.name,
      arguments: delta.function_call.arguments,
      phase: rawPhase,
      functionId: delta.function_id
    })
    drain()
  } else if (delta.role === 'function' && isClientToolName(delta.name)) {
    if (accumulator.closeByName(delta.name)) drain()
  }
  const answerFinished = delta.role !== 'function' && ANSWER_PHASES.has(rawPhase) && delta.status === 'finished'
  if ((reportedFinishReason !== undefined && reportedFinishReason !== null) || answerFinished) {
    if (accumulator.closeOpen('round_end')) drain()
  }
}

/**
 * 正文恢复帧：归一化后是 answer、内容非空、原始 role ≠ function、原始 phase ∈ ANSWER_PHASES。
 * 它关闭打开中的调用，也是早停的触发帧（批次已齐时）。
 */
const isProseResume = (delta, normalized, rawPhase) =>
  !!normalized && normalized.phase === 'answer' && !!normalized.content &&
  delta.role !== 'function' && ANSWER_PHASES.has(rawPhase)

/**
 * 早停条件：本轮打开过的客户端调用全部被各自的具名结果帧关闭，且至少一个过闸。
 * 平台调用两侧都不计。达不到就永不早停 —— 保护迟到的第三个并行调用。
 */
const nativeBatchComplete = (accumulator) => {
  const state = accumulator.batchState()
  return state.opened > 0 && state.opened === state.closedByResult && state.gated >= 1
}

/**
 * 完整消费一次 Qwen 上游 attempt。裸正文与工具调用始终留在门禁内；调用方可
 * 实时接收安全思考，以及已经进入 final/blocked 包装体的正式正文增量。
 * 每次调用都新建 parser/filter/accumulator，失败 attempt 不会污染下一次。
 */
const collectOpenAIAgentAttempt = async (upstreamResponse, options = {}) => {
  const hasTools = options.has_tools !== false
  const allowedToolNames = options.allowed_tool_names || []
  // clientToolNames：只有客户端声明过的工具名才算拦截证据（见 chat-helpers.js）。
  const normalizeDelta = createUpstreamDeltaNormalizer({ clientToolNames: allowedToolNames })
  const acceptUpstreamFrame = createUpstreamResponseFilter()
  // Schemas de las herramientas declaradas (nombre -> JSON Schema), via
  // chat-middleware.js#processRequestBody. Sin ellos las puertas de schema del parser
  // (reparacion de comillas internas, aceptacion de un payload tras prosa) y la del
  // acumulador nativo fallan cerradas — el estado de este camino antes de esta spec.
  const toolSchemas = options.tool_schemas || null
  // La puerta de argumentos de las llamadas NATIVAS tambien vive de los schemas
  // (anthropic.js se los pasa en sus tres sitios): sin ellos un function_call al que le
  // falta una clave required se promovia al cliente sin un solo error.
  const nativeTools = hasTools
    ? createNativeToolCallAccumulator({ allowedToolNames, toolSchemas })
    : null
  const isClientToolName = createClientToolNamePredicate(allowedToolNames)
  // 本轮关闭即晋升的原生调用（takeCompleted 排出）。有了第一个之后，后续正文/思考是平台
  // "工具不存在"注入的回声，只丢不记；批次齐了就提前终止上游。
  const promotedNativeCalls = []
  let stopRequested = false
  const drainPromotedNativeCalls = () => {
    for (const call of nativeTools.takeCompleted()) {
      logger.warn(
        `OpenAI Agent 原生工具调用晋升为 tool_call：${call.function.name}（answer phase，无 function_id）`,
        'AGENT'
      )
      promotedNativeCalls.push(call)
    }
  }
  // El canal de PENSAMIENTO no recibe schemas — paridad exacta con anthropic.js (:1201 y
  // :1721 pasan solo allowedToolNames). Con ellos, un [TOOL CALL] reparable por comillas o
  // aceptable tras prosa que solo aparece en think phase se rescataria y se promoveria a
  // llamada ejecutable aqui pero no en Anthropic. El salvage se queda en answer phase.
  const reasoningStreamParser = typeof options.on_reasoning_delta === 'function'
    ? createToolCallStreamParser({ allowedToolNames })
    : null
  const controlStreamParser = typeof options.on_content_delta === 'function'
    ? createAgentControlStreamParser()
    : null
  const controlToolStreamParser = controlStreamParser
    ? createToolCallStreamParser({ allowedToolNames, toolSchemas })
    : null
  // Guarda de fuga del canal de texto — gemela de la rama NO-stream de anthropic.js.
  // Este runtime bufferiza el turno entero hasta EOF, asi que no hay nada "ya emitido" que
  // recoger: se parsea en vivo SOLO para detectar, y la ronda cortada se liquida con lo que
  // el parser de deteccion habia admitido antes del corte. Se crean sin depender de los
  // callbacks (a diferencia de los parsers de arriba), asi que no-stream y
  // LEGACY_REASONING_IN_CONTENT=true quedan cubiertos igual.
  const detectionParser = hasTools
    ? createToolCallStreamParser({ allowedToolNames, toolSchemas })
    : null
  const detectionTagStripper = createAgentTagStripper()
  const maxTextToolCalls = resolveTextToolCallCap()
  const textRunaway = detectionParser
    ? createTextChannelRunawayGuard({
      parser: detectionParser,
      maxToolCalls: maxTextToolCalls,
      label: 'OpenAI Agent',
      tag: 'AGENT'
    })
    : null
  // textDelta crudo admitido (SIN quitar tags de agente): es el cleanedText de la ronda
  // cortada y parseAgentControlText necesita los tags intactos para clasificarla. El
  // stripper de arriba solo alimenta el test de prosa de la regla (c).
  let streamedRawText = ''
  const streamedCalls = []
  const collectTextCall = (call) => {
    streamedCalls.push(call)
    return true
  }
  const cutTextChannelTurn = (rule) => {
    stopRequested = true
    textRunaway.cut(rule)
  }
  /**
   * Liquidacion de la ronda cortada, con la forma que devuelve parseToolCallsFromText.
   * No se re-parsea `answer` entero: una llamada partida entre pushes saldria como
   * truncated_tool_call, el trigger se filtraria como prosa y la llamada que toco el cap
   * se perderia — nada de eso coincide con lo que la ronda realmente admitio.
   * Hueco asumido: el markdown de imagenes entra en `answer` sin pasar por este parser, asi
   * que una ronda cortada no lo incluye (imagenes y herramientas no coexisten en t2t).
   */
  const settledTextRound = () => ({
    cleanedText: streamedRawText,
    toolCalls: streamedCalls,
    // Una ronda cortada NO superficializa errores del parser — ni los del push disparador ni
    // los de pushes anteriores. evaluateOpenAIAgentAttempt mira `toolErrors.length > 0` ANTES
    // que `toolCalls.length > 0`: cualquier error superviviente reintentaria la ronda y
    // volveria a lanzar la fuga que el corte acaba de detener, hasta agotar intentos y morir
    // en 502. Es la paridad con anthropic.js, donde decideRetryReason corta en seco con
    // `if (emittedCalls) return null` (:1080) / `if (toolCalls.length > 0) return null`
    // (:1749) antes de mirar los errores: una ronda cortada con llamadas admitidas SIEMPRE
    // se entrega.
    errors: [],
    residueSpans: detectionParser.getResidueSpans().filter(span => span.channel === 'text')
  })
  let streamedVisibleText = ''
  // Texto rescatado de un <tool_call> que no parseó. No se emite aquí: el turn gate
  // todavía puede rechazar esta ronda, y emitirlo ahora lo duplicaría en cada intento
  // además de contar como "ya salió texto" en la guarda de :409.
  let recoveredContent = ''
  let recoveredReasoning = ''
  let streamedControlKind = null
  let controlToolParserFlushed = false

  const emitReasoningDelta = async (text) => {
    if (typeof options.on_reasoning_delta !== 'function') return
    await options.on_reasoning_delta(text || '', {
      attemptNumber: Math.max(1, Number(options.attempt_number) || 1)
    })
  }

  const emitContentDelta = async (text, kind) => {
    if (!text || typeof options.on_content_delta !== 'function') return
    streamedVisibleText += text
    streamedControlKind = kind || streamedControlKind
    await options.on_content_delta(text, {
      attemptNumber: Math.max(1, Number(options.attempt_number) || 1),
      kind: streamedControlKind
    })
  }

  const consumeControlStreamResult = async (result) => {
    if (!result || !controlToolStreamParser) return
    if (result.textDelta) {
      const parsed = controlToolStreamParser.push(result.textDelta)
      await emitContentDelta(parsed.textDelta, result.kind)
      recoveredContent += parsed.recoveredText
    }
    if (result.closed && !controlToolParserFlushed) {
      controlToolParserFlushed = true
      const parsed = controlToolStreamParser.flush()
      await emitContentDelta(parsed.textDelta, result.kind)
      recoveredContent += parsed.recoveredText
    }
  }

  const appendAnswer = async (text) => {
    if (!text) return
    answer += text
    if (controlStreamParser) {
      await consumeControlStreamResult(controlStreamParser.push(text))
    }
  }

  let reasoning = ''
  let answer = ''
  let answerStarted = false
  let webSearchInfo = null
  let upstreamFinishReason = null
  let acceptedResponseId = null
  const createdByResponseId = new Map()
  let primaryCreated = null
  let lastCreated = null
  const emittedImages = new Set()
  const pendingImages = []
  let totalTokens = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  }

  const streamResult = await consumeSSEStream(upstreamResponse, async (frame) => {
    if (!frame.data || frame.data.trim() === '[DONE]') return
    const decoded = isJson(frame.data) ? JSON.parse(frame.data) : null
    if (decoded === null) return
    assertNoUpstreamFailure(decoded)

    const created = normalizeCreatedMetadata(decoded)
    if (created) {
      lastCreated = created
      if (created.responseId) createdByResponseId.set(created.responseId, created)
      const responseIndex = created.responseIndex === null || created.responseIndex === ''
        ? Number.NaN
        : Number(created.responseIndex)
      if (created.responseId && Number.isFinite(responseIndex) && responseIndex === 0) {
        primaryCreated = created
        acceptedResponseId = created.responseId
      }
    }

    if (!acceptUpstreamFrame(decoded)) return
    if (decoded.response_id) acceptedResponseId = decoded.response_id

    if (decoded.usage) {
      totalTokens = {
        prompt_tokens: decoded.usage.prompt_tokens || totalTokens.prompt_tokens,
        completion_tokens: decoded.usage.completion_tokens || totalTokens.completion_tokens,
        total_tokens: decoded.usage.total_tokens || totalTokens.total_tokens
      }
    }
    if (!Array.isArray(decoded.choices) || decoded.choices.length === 0) return

    const choice = decoded.choices[0]
    const reportedFinishReason = choice.finish_reason ?? choice.delta?.finish_reason
    if (reportedFinishReason !== undefined && reportedFinishReason !== null) {
      upstreamFinishReason = reportedFinishReason
    }

    const delta = choice.delta || {}
    const rawPhase = delta.phase
    if (nativeTools) {
      feedNativeFrame(nativeTools, delta, reportedFinishReason, {
        isClientToolName,
        drain: drainPromotedNativeCalls
      })
    }

    if (delta.name === 'web_search') {
      webSearchInfo = delta.extra?.web_search_info || webSearchInfo
    }

    const normalized = normalizeDelta(delta)
    const phase = normalized?.phase || null
    const images = imageMarkdownFromDelta(delta)
      .filter(item => !emittedImages.has(item) && !pendingImages.includes(item))
    if (images.length > 0) {
      if (phase === 'think' && !answerStarted) {
        pendingImages.push(...images)
      } else {
        const markdown = `${images.join('\n\n')}\n\n`
        await appendAnswer(markdown)
        images.forEach(item => emittedImages.add(item))
      }
    }

    if (!normalized) return
    if (nativeTools && isProseResume(delta, normalized, rawPhase)) {
      // 正文恢复关闭打开中的调用（过闸的随即晋升）。
      if (nativeTools.closeOpen('boundary')) drainPromotedNativeCalls()
    }
    // 批次已齐 —— 每个客户端调用都被自己的结果帧关闭且至少一个过闸 —— 之后模型产出的
    // 第一帧内容（思考**或**正文）就是"工具不存在"叙述的开头：提前终止上游，内容丢弃。
    // 与 anthropic.js 同一条：不能只等正文 —— 生产里（2026-09-01 18:05）模型被拦截后先又
    // 思考了 54s 才开口。批次不齐则永不早停，照旧消费到底（迟到的并行调用以 function_call
    // 帧到达，没有内容，不会触发这里）。
    if (nativeTools && delta.role !== 'function' && normalized.content &&
        nativeBatchComplete(nativeTools)) {
      stopRequested = true
      logger.warn('OpenAI Agent 原生工具批次已晋升，提前终止上游（用量按本地估算）', 'AGENT')
      return
    }
    // 晋升之后的叙述（"工具不可用"）不进 answer/reasoning —— 调用前的正文已经在 answer 里了。
    if (promotedNativeCalls.length > 0) return
    if (normalized.phase === 'think') {
      // Regla (c) en forma "think": pensar despues de una llamada del canal de texto es el
      // arranque de la fuga. Se corta y este frame no entra ni en reasoning ni al cliente.
      const thinkRule = textRunaway?.inspectThink(normalized.content)
      if (thinkRule) {
        cutTextChannelTurn(thinkRule)
        return
      }
      // Ya armado: el think en blanco tampoco entra (inspectThink no dispara con blancos).
      if (textRunaway?.armed()) return
      reasoning += normalized.content
      if (reasoningStreamParser) {
        const streamed = reasoningStreamParser.push(normalized.content)
        await emitReasoningDelta(streamed.textDelta)
        recoveredReasoning += streamed.recoveredText
      }
      return
    }

    answerStarted = true
    if (pendingImages.length > 0) {
      await appendAnswer(`${pendingImages.join('\n\n')}\n\n`)
      pendingImages.forEach(item => emittedImages.add(item))
      pendingImages.length = 0
    }
    if (textRunaway) {
      const parsed = detectionParser.push(normalized.content)
      const stripped = detectionTagStripper.push(parsed.textDelta)
      // Reglas (b)/(c): al disparar, el texto de ESTE push no se admite; las llamadas ya
      // completadas en el mismo push si se recogen (bucle de abajo).
      const pushRule = textRunaway.inspectPush(parsed, stripped)
      if (pushRule) cutTextChannelTurn(pushRule)
      else streamedRawText += parsed.textDelta
      // Reglas (a)/(d): la llamada que toca el cap se entrega igual, y ahi se para.
      for (const call of parsed.completedCalls) {
        // El tope durante el drenaje del push que disparo el corte lo aplica la guarda
        // compartida (agent-turn.js#inspectCall), una sola vez para los tres llamadores.
        const callRule = textRunaway.inspectCall(call, collectTextCall)
        if (!callRule) continue
        cutTextChannelTurn(callRule)
        if (callRule === 'cap') break
      }
      textRunaway.endPush()
      // Cortado: el push disparador no llega a `answer`, ni al controlStreamParser, ni al
      // cliente. `stopRequested` destruye el upstream en el siguiente frame (sse.js).
      if (textRunaway.cutRule()) return
    }
    await appendAnswer(normalized.content)
  }, { shouldStop: () => stopRequested })

  const textChannelCut = !!textRunaway?.cutRule()
  // Tras un corte no se hace flush de ningun parser de texto: lo que queda en el buffer es
  // el resto del push descontrolado (medio trigger / medio payload) y el flush lo condenaria
  // como truncated_tool_call -> toolErrors>0 -> reintento (evaluate :461), anulando el corte.
  if (reasoningStreamParser && !textChannelCut) {
    const streamed = reasoningStreamParser.flush()
    await emitReasoningDelta(streamed.textDelta)
    recoveredReasoning += streamed.recoveredText
  }
  // El mismo guarda para la cadena control -> controlTool -> cliente. Hoy es defensa en
  // profundidad, no un camino vivo: el controlStreamParser solo emite dentro de un cuerpo
  // <agent_final>, y una ronda cortada que arrastre ese envoltorio la rechaza la puerta
  // (invalid_control) antes de entregar nada. Se queda porque la regla es "tras un corte no
  // se hace flush de NINGUN parser de texto" y el dia que la puerta se relaje esto ya esta bien.
  if (controlStreamParser && !textChannelCut) {
    await consumeControlStreamResult(controlStreamParser.flush())
  }

  // La ronda cortada se liquida con el parser de deteccion; las demas siguen re-parseando
  // `answer` entero como hasta ahora.
  const textTools = textChannelCut
    ? settledTextRound()
    : (hasTools
      ? parseToolCallsFromText(answer, { allowedToolNames, toolSchemas })
      : { cleanedText: answer, toolCalls: [], errors: [] })
  // Sin schemas, igual que el parser de streaming del canal de pensamiento (paridad con
  // anthropic.js:1721): el rescate por schema no promueve llamadas desde el think phase.
  const reasoningTools = hasTools && textTools.toolCalls.length === 0 && !textTools.cleanedText.trim()
    ? parseToolCallsFromText(reasoning, { allowedToolNames })
    : { cleanedText: reasoning, toolCalls: [], errors: [] }
  // 回合结束：打开中的原生调用按 round_end 关闭并排出，再 finalize() 单发结算 OpenAI
  // 形状的 tool_calls（原生的已排空，不会出来第二次）。
  let nativeToolCalls = []
  if (nativeTools) {
    nativeTools.closeOpen('round_end')
    drainPromotedNativeCalls()
    nativeToolCalls = [...promotedNativeCalls, ...nativeTools.finalize()]
  }
  // 部分 thinking 模型会把“整个可执行工具块”放进 think phase 后直接 EOF。
  // 仅当 thinking 除独立工具块外没有任何文字时才接纳，避免把推理中的示例或
  // 尚未决定执行的调用当成真实动作。
  const standaloneReasoningCalls = reasoningTools.toolCalls.length > 0 &&
    !reasoningTools.cleanedText.trim() &&
    reasoningTools.errors.length === 0
    ? reasoningTools.toolCalls
    : []
  // 原生优先（本运行时改动前的语义：`nativeToolCalls.length > 0 ? nativeToolCalls : 文本`）：
  // 有一个过闸的原生调用，本轮文本通道的调用整体丢弃 —— 两个通道合并会让一条写坏/顺手写的
  // 文本 [TOOL CALL] 与结构化的原生调用一起执行。这里整轮都在缓冲，丢得掉（anthropic.js
  // 的文本调用是内联发射的，收不回来）。登记簿仍管其余的同名同参数副本，再统一编号。
  const textChannelCalls = textTools.toolCalls.length > 0 ? textTools.toolCalls : standaloneReasoningCalls
  if (nativeToolCalls.length > 0 && textChannelCalls.length > 0) {
    logger.warn(
      `OpenAI Agent 本轮原生工具调用优先，丢弃文本通道的 ${textChannelCalls.length} 个调用（${textChannelCalls.map(call => call.function.name).join(', ')}）`,
      'AGENT'
    )
  }
  // Sembrado con las llamadas ya ejecutadas (chat-middleware.js#processRequestBody).
  // Una entrada sembrada NO suprime — solo deja un warn con nombre y ordinal.
  const admitToolCall = createToolCallLedger({ seed: options.tool_history_calls })
  const toolCalls = [
    ...nativeToolCalls,
    ...(nativeToolCalls.length > 0 ? [] : textChannelCalls)
  ]
    .filter(call => {
      if (admitToolCall(call)) return true
      logger.warn(`OpenAI Agent 本轮重复的工具调用（${call.function.name}，跨通道同名同参数），丢弃后到的副本`, 'AGENT')
      return false
    })
    .map((call, index) => ({ ...call, index }))
  // 文本来源与原生来源分开记：原生接纳时，文本来源的错误意味着 visibleText 里混着写坏的
  // [TOOL CALL]（evaluate 据此把正文置空）；原生来源的（平台调用的 unknown_tool 之类）不算。
  const textToolErrors = [
    ...(textTools.errors || []),
    ...(textTools.toolCalls.length === 0 && !textTools.cleanedText.trim()
      ? (reasoningTools.errors || [])
      : [])
  ]
  const toolErrors = [
    ...textToolErrors,
    ...(nativeTools?.getErrors?.() || [])
  ]
  const control = parseAgentControlText(textTools.cleanedText)
  // Registro del residuo condenado, ya rebasado a coordenadas de `visibleText`: la capa de
  // entrega (chat.js#prepareAgentOutput) lo pela por posición, gemela de anthropic.js:1501.
  // La DETECCIÓN no se toca — `visibleText` sigue byte a byte como salió del parser, porque
  // containsOrphanProtocolResidue decide malformed_protocol sobre él y pelarlo aquí apagaría
  // el reintento que hoy recupera la ronda.
  const residueSpans = hasTools
    ? rebaseResidueSpans(textTools.cleanedText, control.text, textTools.residueSpans, control.segments)
    : []
  const metadata = (acceptedResponseId && createdByResponseId.get(acceptedResponseId)) || primaryCreated || lastCreated || {
    chatId: null,
    parentId: null,
    responseId: acceptedResponseId
  }

  return {
    reasoning: standaloneReasoningCalls.length > 0 ? reasoningTools.cleanedText : reasoning,
    rawAnswer: answer,
    visibleText: control.text,
    controlKind: control.kind,
    // Residuo de protocolo condenado por el parser, en coordenadas de `visibleText`.
    // Hasta esta spec se calculaba y se tiraba al suelo: stripToolCallResidue tenía cuatro
    // llamadores en anthropic.js y CERO aquí, y por eso un `[END TOOL CALL]` huérfano salía
    // como texto del asistente (20 casos medidos sobre 192 sesiones reales).
    residueSpans,
    streamedVisibleText,
    recoveredContent,
    recoveredReasoning,
    streamedControlKind,
    streamedControlState: controlStreamParser?.getState?.() || null,
    toolCalls,
    toolErrors,
    textToolErrors,
    // 本轮过闸晋升的 Qwen 原生 function_call（已并入 toolCalls）。门禁凭它在 toolErrors
    // 否决与"正文不得与工具并存"之前接纳本轮。
    nativeToolCalls: promotedNativeCalls,
    // 平台拦截的现场证据：Defect A 丢弃的 role:function 帧的名字（去重、有上限）。
    // 门禁靠它识别"原生调用被平台吃掉、只剩叙述"的死亡回合。
    interceptedToolNames: normalizeDelta.interceptedToolNames,
    webSearchInfo,
    totalTokens,
    upstreamFinishReason,
    upstreamCompleted: streamResult.completed,
    upstreamEventCount: streamResult.eventCount,
    sawDone: streamResult.sawDone,
    // La guarda de fuga destruyó el upstream a medias. La puerta lo usa para entregar la
    // ronda sin pasar por las reglas de reintento, y el reintento (si alguna vez lo hubiera)
    // para no volver a un chat_id cuya generación abortada sigue viva en Qwen.
    textChannelCut,
    upstreamStopped: streamResult.stopped === true,
    metadata: {
      ...metadata,
      responseId: metadata?.responseId || acceptedResponseId || null
    }
  }
}

const requiresToolCall = (toolChoice) => {
  if (toolChoice === 'required') return true
  return !!(toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name)
}

const evaluateOpenAIAgentAttempt = (attempt, options = {}) => {
  const finishReason = attempt.upstreamFinishReason
  if (NON_RETRYABLE_FINISH_REASONS.has(finishReason)) {
    const normalized = finishReason === 'max_tokens' ? 'length' : finishReason
    return { accepted: true, finishReason: normalized, retryReason: null }
  }
  // 过闸的原生调用是结构化帧，比文本启发式更强的证据：有一个就接纳本轮 —— 排在
  // toolErrors 否决与"正文不得与工具并存"之前，不翻 agentTurnAllowProseWithTools。
  // 调用前的干净正文随 visibleText 交付；调用后的叙述在采集时就已丢弃。但被跳过的两道
  // 否决恰恰说明 visibleText 里可能混着写坏的文本 [TOOL CALL]（文本来源的解析错误 /
  // 孤儿协议残渣）：这种正文不交付 —— suppressVisibleText 让交付层把 content 置空，
  // tool_calls 照常。
  if ((attempt.nativeToolCalls?.length || 0) > 0) {
    const suppressVisibleText = (attempt.textToolErrors?.length || 0) > 0 ||
      containsOrphanProtocolResidue(attempt.visibleText)
    return { accepted: true, finishReason: 'tool_calls', retryReason: null, suppressVisibleText }
  }
  // Ronda cortada por la guarda de fuga con llamadas admitidas: SIEMPRE se entrega (paridad
  // con anthropic.js decideRetryReason :1080/:1749 y la promesa de settledTextRound). Va ANTES
  // del veto por toolErrors y de "prosa no coexiste con tools": rechazarla reintenta la fuga
  // recién detenida y, peor, el reintento cae en el mismo chat_id cuya generación abortada
  // sigue viva en Qwen → CHAT_IN_PROGRESS → 502 (incidente qwen-next 2026-09-06 20:29, gate
  // estricto: narración previa a la llamada + corte por duplicado). La prosa previa al corte
  // viaja sólo si la config la permite; con gate estricto se suprime en vez de rechazar.
  if (attempt.textChannelCut === true && attempt.toolCalls.length > 0) {
    const suppressVisibleText = (attempt.toolErrors?.length || 0) > 0 ||
      containsOrphanProtocolResidue(attempt.visibleText) ||
      (!config.agentTurnAllowProseWithTools && !!attempt.visibleText.trim())
    return { accepted: true, finishReason: 'tool_calls', retryReason: null, suppressVisibleText }
  }
  if (attempt.toolErrors.length > 0) {
    return { accepted: false, finishReason: null, retryReason: 'invalid_tool_call', detail: 'tool_errors' }
  }
  if (attempt.toolCalls.length > 0) {
    if (!config.agentTurnAllowProseWithTools &&
        (attempt.controlKind !== 'empty' || attempt.visibleText.trim())) {
      return { accepted: false, finishReason: null, retryReason: 'invalid_tool_call', detail: 'prose_with_tools' }
    }
    return { accepted: true, finishReason: 'tool_calls', retryReason: null }
  }
  if (requiresToolCall(options.tool_choice)) {
    return { accepted: false, finishReason: null, retryReason: 'required_tool' }
  }
  // 协议恢复防御（与 Anthropic 两个循环同族）。必须排在 final/blocked 接纳之前：
  // 事故正是以 <agent_final> 包着的失败叙述被当成合法完结交付出去的。
  // - intercepted：role:function 丢弃帧 = 平台吃掉了模型的原生调用，只剩叙述。
  // - malformed_protocol：方括号协议写坏（孤儿闭标记 / 开头裸负载）整段泄漏为
  //   可见正文。只是重试信号，泄漏的 JSON 永远不执行。
  // intercepted 在前——丢弃帧是更强的证据。protocol_recovery_used 表示共享的
  // 一次性恢复名额已用：跳过两个检查，让回合按原有规则交付（原样交付胜过死循环）。
  if (options.has_tools !== false && !options.protocol_recovery_used) {
    if ((attempt.interceptedToolNames?.length || 0) > 0) {
      return { accepted: false, finishReason: null, retryReason: 'intercepted' }
    }
    if (containsOrphanProtocolResidue(attempt.visibleText)) {
      return { accepted: false, finishReason: null, retryReason: 'malformed_protocol' }
    }
  }
  if (attempt.controlKind === 'final' || attempt.controlKind === 'blocked') {
    if (attempt.visibleText.trim()) {
      return { accepted: true, finishReason: 'stop', retryReason: null }
    }
    return { accepted: false, finishReason: null, retryReason: 'empty' }
  }
  if (attempt.controlKind === 'empty') {
    return { accepted: false, finishReason: null, retryReason: 'empty' }
  }
  if (attempt.controlKind === 'invalid_control') {
    return { accepted: false, finishReason: null, retryReason: 'invalid_control' }
  }
  if (config.agentTurnAcceptBareFinal && attempt.visibleText.trim()) {
    return { accepted: true, finishReason: 'stop', retryReason: null }
  }
  return { accepted: false, finishReason: null, retryReason: 'bare' }
}

const appendRetryHint = (requestBody, hint) => {
  const clone = requestBody && typeof requestBody === 'object'
    ? JSON.parse(JSON.stringify(requestBody))
    : {}
  const messages = Array.isArray(clone.messages) ? clone.messages : []
  if (messages.length === 0) {
    messages.push({ role: 'user', content: hint })
  } else {
    const last = messages[messages.length - 1]
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${hint}`
    } else if (Array.isArray(last.content)) {
      const textPart = last.content.find(part => part?.type === 'text')
      if (textPart) textPart.text = `${textPart.text || ''}\n\n${hint}`
      else last.content.unshift({ type: 'text', text: hint })
    } else {
      last.content = hint
    }
  }
  clone.messages = messages
  return clone
}

const exhaustedError = (attempt, retryReason) => {
  if (retryReason === 'empty' && !String(attempt?.reasoning || '').trim()) {
    return {
      status: 503,
      message: '上游连续返回空 Agent 回合，任务状态未被标记为完成',
      code: 'upstream_unavailable'
    }
  }
  const messages = {
    empty: '上游连续只返回思考内容，没有给出可执行工具调用或最终答复',
    bare: '上游连续返回未声明完成状态的文本，已阻止 Agent 将未完成任务误判为结束',
    invalid_control: '上游连续返回无效的 Agent 完成标记',
    invalid_tool_call: '上游连续返回残缺、非法或不存在的工具调用',
    required_tool: '上游连续违反 tool_choice，未返回要求的工具调用',
    intercepted: '上游的工具调用被平台拦截，重试后仍未恢复',
    malformed_protocol: '上游持续返回残缺的工具调用协议，未能恢复为可执行调用'
  }
  return {
    // 502, no 429. Nada de esto fue un límite de tasa: es un desacuerdo de protocolo con el
    // upstream. Con 429, chat.js#writeOpenAIHttpError lo etiquetaba `rate_limit_error`, y un
    // cliente agéntico lee eso como "te están limitando, échate atrás y reintenta el turno
    // entero" — multiplicando el gasto de cuota de la cuenta contra la que ya se falló.
    // El 429 real (Qwen RateLimited) sigue saliendo por chat.image.video.js.
    status: 502,
    message: messages[retryReason] || '上游未能生成有效的 Agent 回合',
    code: retryReason === 'invalid_tool_call' ? 'invalid_tool_call' : 'upstream_agent_turn_incomplete'
  }
}

/**
 * 执行严格 Agent 回合：每个 attempt 完全隔离；只有有效工具调用、显式完成/阻塞，
 * 或标准非重试终止原因才能提交给客户端。
 */
const runOpenAIAgentTurn = async (initialResponse, options = {}) => {
  const requestSender = options.sendChatRequest
  const maxAttempts = Math.min(
    6,
    Math.max(2, Number(options.agent_turn_max_attempts) || config.agentTurnMaxAttempts)
  )
  let currentResponse = initialResponse
  let lastAttempt = null
  let lastEvaluation = null
  let upstreamContext = { ...(options.upstream_context || {}) }
  const retryBaseBody = options.upstream_request_body || options.requestBody
  let attemptsMade = 0
  // 协议恢复重试（intercepted / malformed_protocol 共享）整个请求只允许一次。
  // 用过之后 evaluate 会跳过这两个检查，让第二次拦截/残缺按原有规则原样交付。
  let protocolRecoveryRetried = false

  const mergePresent = (base, extra) => {
    const merged = { ...base }
    for (const [key, value] of Object.entries(extra || {})) {
      if (value !== null && value !== undefined && value !== '') merged[key] = value
    }
    return merged
  }

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    attemptsMade = attemptNumber
    const attempt = await collectOpenAIAgentAttempt(currentResponse, {
      ...options,
      attempt_number: attemptNumber
    })
    const evaluation = evaluateOpenAIAgentAttempt(attempt, {
      ...options,
      protocol_recovery_used: protocolRecoveryRetried
    })
    lastAttempt = attempt
    lastEvaluation = evaluation
    upstreamContext = mergePresent(upstreamContext, attempt.metadata)

    if (evaluation.accepted) {
      // 恢复名额已用而本轮仍带拦截/残渣证据 = 第二次事故按原样交付。留一行日志，
      // 生产环境要能区分"提示被采纳、回合恢复"和"第二次、原样交付"。
      if (protocolRecoveryRetried && attempt.toolCalls.length === 0 &&
          ((attempt.interceptedToolNames?.length || 0) > 0 ||
            containsOrphanProtocolResidue(attempt.visibleText))) {
        const giveUpDrops = (attempt.interceptedToolNames?.length || 0) > 0
          ? ` (dropped: ${attempt.interceptedToolNames.join(', ')})`
          : ''
        logger.warn(
          `Agent 协议恢复重试已用完，第二次拦截/残缺协议按原样交付${giveUpDrops}`,
          'AGENT'
        )
      }
      // Solo ahora que la ronda quedó aceptada: si se hubiera emitido al vuelo, cada
      // intento rechazado habría dejado otra copia en el stream del cliente.
      if (attempt.recoveredReasoning && typeof options.on_reasoning_delta === 'function') {
        await options.on_reasoning_delta(attempt.recoveredReasoning, { attemptNumber })
      }
      if (attempt.recoveredContent && typeof options.on_content_delta === 'function') {
        await options.on_content_delta(attempt.recoveredContent, {
          attemptNumber,
          kind: attempt.streamedControlKind
        })
      }
      if (evaluation.suppressVisibleText) {
        logger.warn('OpenAI Agent 原生接纳的回合正文带文本工具错误/协议残渣，content 置空只交付 tool_calls', 'AGENT')
      }
      return {
        ok: true,
        attempt,
        finishReason: evaluation.finishReason,
        attempts: attemptNumber,
        // 原生接纳但正文被文本 [TOOL CALL] 残渣污染：交付层不转发 visibleText。
        suppressVisibleText: evaluation.suppressVisibleText === true
      }
    }

    // 有丢弃帧时任何拒绝理由都带上名字：invalid_tool_call/required_tool 优先级更高
    // 时拦截会被盖住，这行日志是生产环境验证拦截确实发生的抓手。
    const dropSuffix = (attempt.interceptedToolNames?.length || 0) > 0
      ? `; dropped: ${attempt.interceptedToolNames.join(', ')}`
      : ''
    // `detail` distingue en producción los dos invalid_tool_call (toolErrors vs prosa+tools):
    // sin él, el incidente 2026-09-06 fue indistinguible por logs.
    const detailSuffix = evaluation.detail ? `:${evaluation.detail}` : ''
    logger.warn(
      `Agent attempt ${attemptNumber}/${maxAttempts} 被回合门禁拒绝 (${evaluation.retryReason}${detailSuffix}${dropSuffix})`,
      'AGENT'
    )
    if (attempt.streamedVisibleText) {
      return {
        ok: false,
        error: {
          status: 422,
          message: '上游在已开始流式输出正式回复后返回了无效的 Agent 结束结构',
          code: 'upstream_agent_stream_invalidated'
        },
        attempt,
        attempts: attemptNumber
      }
    }
    if (attemptNumber >= maxAttempts || typeof requestSender !== 'function') break

    if (evaluation.retryReason === 'intercepted' || evaluation.retryReason === 'malformed_protocol') {
      protocolRecoveryRetried = true
    }
    let retryHint = buildAgentRetryHint(evaluation.retryReason)
    // 别的理由（invalid_tool_call/required_tool）盖住拦截时，提示词仍要把关键
    // 事实带上：调用没到客户端。不动优先级、不动名额。
    if (evaluation.retryReason !== 'intercepted' &&
        attempt.toolCalls.length === 0 &&
        (attempt.interceptedToolNames?.length || 0) > 0) {
      retryHint = `${retryHint}\n${buildAgentRetryHint('intercepted')}`
    }
    const retryBody = appendRetryHint(retryBaseBody, retryHint)
    // Tras un corte el upstream de esta ronda se destruyó a medias: en Qwen esa generación
    // sigue "in progress" unos segundos y un POST al mismo chat_id responde CHAT_IN_PROGRESS
    // (visto 2026-09-06 20:29 en qwen-next). Defensa en profundidad — hoy toda ronda cortada
    // con llamadas se acepta arriba y no llega aquí —: el reintento abre chat nuevo.
    const chatBusy = attempt.textChannelCut === true || attempt.upstreamStopped === true
    const retryResponse = await requestSender(retryBody, {
      chatId: chatBusy ? null : (upstreamContext.chatId || null),
      parentId: chatBusy ? null : (upstreamContext.responseId || null),
      currentAccount: options.currentAccount || null,
      agentRetry: true
    })
    if (!retryResponse?.status || !retryResponse.response) {
      return {
        ok: false,
        error: {
          status: 502,
          message: retryResponse?.message || 'Agent 回合纠正请求失败',
          code: 'upstream_retry_failed'
        },
        attempt,
        attempts: attemptNumber
      }
    }
    currentResponse = retryResponse.response
    upstreamContext = mergePresent(upstreamContext, {
      chatId: retryResponse.chatId,
      currentAccount: retryResponse.currentAccount
    })
  }

  // NO hay cupo de rendición para `invalid_control`, y es deliberado.
  //
  // Se probó darle uno (entregar el texto pelado con finish_reason=stop tras agotar los
  // intentos) y la verificación adversaria lo tumbó por tres motivos, los tres reproducidos:
  //  - Su justificación era "el modelo SÍ declaró el cierre, sólo escribió mal el envoltorio".
  //    Falso para casi todo lo que le llegaba: tras anclar el cierre al final, las formas que
  //    siguen cayendo en invalid_control son exactamente las que NO declaran un cierre legible
  //    —desbalanceadas («<agent_final>respuesta a medio envolver», sin cierre), invertidas,
  //    dobles, y las dos familias a la vez— es decir el mismo caso que `bare` y `empty` tienen
  //    vetado. Entregaba «terminé» y «necesito tu contraseña» como un turno completo.
  //  - No estaba atado al agotamiento real: el `break` de arriba también salta cuando no hay
  //    requestSender, así que la PRIMERA ronda malformada se entregaba como stop con
  //    attempts=1, sin un solo reintento.
  //  - En SSE ni siquiera se alcanzaba para su propio caso de prueba: con on_content_delta
  //    cableado (chat.js), el texto ya emitido dispara antes el 422 de stream invalidado.
  //
  // Regla que manda, config/index.js:58: 耗尽后必须显式失败，绝不能伪装成 finish_reason=stop.
  // El arreglo real de la fuga de 429 es el desenvoltorio tolerante de arriba, que acepta la
  // forma medida en vivo al PRIMER intento; cuando eso no aplica, agotar es agotar.
  return {
    ok: false,
    error: exhaustedError(lastAttempt, lastEvaluation?.retryReason),
    attempt: lastAttempt,
    attempts: attemptsMade
  }
}

module.exports = {
  NON_RETRYABLE_FINISH_REASONS,
  normalizeCreatedMetadata,
  collectOpenAIAgentAttempt,
  evaluateOpenAIAgentAttempt,
  appendRetryHint,
  runOpenAIAgentTurn,
  // chat.js 旧路径共用的原生帧喂入
  feedNativeFrame
}
