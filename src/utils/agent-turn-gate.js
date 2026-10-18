'use strict'

/**
 * La puerta del turno agéntico: qué intento del upstream se acepta y cuál se reintenta.
 *
 * Entra el snapshot de **un intento** más la política de la superficie; sale el veredicto.
 * Acá viven el vocabulario de razones, los dos presupuestos, el mapa de hints de reintento
 * con sus constructores y el helper de append. El loop conserva lo que es suyo: el
 * presupuesto de intentos, la bandera mutable del cupo de recuperación de protocolo y la
 * maquinaria de entrega. La puerta no sabe de presupuestos agotados ni de códigos de cable:
 * "intentos agotados" es propiedad del loop, y los códigos terminales son vocabulario de
 * cada superficie (ADR 0001).
 *
 * No lee configuración, no toca red y no loguea: `gate` es una función pura de sus dos
 * argumentos, y por eso la tabla de verdad del seam es barata. Hoja en dependencias tampoco
 * lo es del todo — importa `tool-prompt.js`, que arrastra el logger, que lee entorno al
 * importarse; la pureza que importa es la de `gate`, no la del grafo de imports.
 */

const {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  buildAgentRetryHint
} = require('./agent-turn.js')
// El heurístico de "prosa que narra una acción" vive con el resto de la maquinaria de
// marcadores (tool-prompt.js): la puerta lo consume, no lo reimplementa.
const { looksLikeUnexecutedToolAction } = require('./tool-prompt.js')

/** Piso del presupuesto: 1 = una sola generación, sin reintentos. */
const MIN_ATTEMPT_BUDGET = 1

/** Techo del presupuesto: el mismo tope que ya aplicaba el runtime OpenAI. */
const MAX_ATTEMPT_BUDGET = 6

/** Terminaciones que el upstream ya explicó: reintentar no las arregla. */
const TERMINAL_FINISH_REASONS = new Set(['length', 'max_tokens', 'content_filter', 'refusal'])

/** Valores de `finishReason` con los que la puerta acepta un turno. */
const FINISH_TOOL_CALLS = 'tool_calls'
const FINISH_STOP = 'stop'

/**
 * Un vocabulario, un significado por token. El par sinónimo (`required` / `required_tool`)
 * se fusiona acá en `required_tool`. `invalid_tool_call` de la superficie OpenAI no existe
 * como token: se parte en `tool_error` (errores de herramienta) más `prose_with_tools`
 * (prosa junto a llamadas) — fusionarlos enteros ensancharía una regla en silencio.
 *
 * Los tokens de una sola superficie siguen siendo de esa superficie: `bare`,
 * `invalid_control` y `prose_with_tools` los emite la superficie OpenAI; `thought_tool_call`
 * y `missing_tool` son de las Anthropic. Los compartidos son `empty`, `required_tool`,
 * `tool_error`, `intercepted` y `malformed_protocol`.
 */
const REASONS = Object.freeze({
  EMPTY: 'empty',
  BARE: 'bare',
  INVALID_CONTROL: 'invalid_control',
  REQUIRED_TOOL: 'required_tool',
  TOOL_ERROR: 'tool_error',
  PROSE_WITH_TOOLS: 'prose_with_tools',
  INTERCEPTED: 'intercepted',
  MALFORMED_PROTOCOL: 'malformed_protocol',
  THOUGHT_TOOL_CALL: 'thought_tool_call',
  MISSING_TOOL: 'missing_tool'
})

/**
 * Las razones que gastan el cupo único de recuperación de protocolo de una petición. El loop
 * conserva la bandera mutable; acá vive la regla. Es la unión de las tres disyunciones a mano
 * que esto reemplaza — `anthropic.js` (loop streaming y no-stream) listaba
 * `intercepted || malformed_protocol || thought_tool_call`; `openai-agent-runtime.js` listaba
 * `intercepted || malformed_protocol` (esa superficie no detecta think leak).
 */
const PROTOCOL_RECOVERY_REASONS = new Set([
  REASONS.INTERCEPTED,
  REASONS.MALFORMED_PROTOCOL,
  REASONS.THOUGHT_TOOL_CALL
])

/**
 * Un solo significado de "max attempts": total de generaciones del upstream para una
 * petición de cliente, **contando la primera**. El runtime OpenAI aplicaba un piso de 2 y
 * convertía en 2 el 1 que le pidieran, mientras las superficies Anthropic aplicaban piso 1:
 * la misma cifra significaba dos cosas según quién la leyera.
 *
 * Alcance exacto de lo que esto arregla, para que nadie lo lea de más: el piso de 1 es
 * alcanzable **sólo por el valor por petición**. La configuración sigue clampeada a [2, 6]
 * en config/index.js — a propósito, y por eso `AGENT_TURN_MAX_ATTEMPTS=1` sigue dando 2.
 * Hoy el único llamador que trae un valor por petición son los tests; cuando exista uno de
 * producción, el piso de acá ya lo cubre.
 * @param {number|string|null} [requested] - valor por petición; null, ausente, no finito o
 *   ≤ 0 cuentan como "no hay" y cae al de configuración. Ojo: un negativo antes se aplanaba
 *   a 2 y un `Infinity` a 6 — entradas que ningún llamador real produce, pero que cambian
 *   de resultado, así que van declaradas y no escondidas.
 * @param {number|string} [fallback] - valor de configuración para cuando no lo trae
 * @returns {number} intentos totales, entre MIN_ATTEMPT_BUDGET y MAX_ATTEMPT_BUDGET
 */
const resolveAttemptBudget = (requested, fallback) => {
  const wanted = Number(requested)
  const base = Number.isFinite(wanted) && wanted > 0 ? wanted : Number(fallback)
  if (!Number.isFinite(base) || base <= 0) return MIN_ATTEMPT_BUDGET
  return Math.min(MAX_ATTEMPT_BUDGET, Math.max(MIN_ATTEMPT_BUDGET, base))
}

// ---------------------------------------------------------------------------
// Hints de reintento: un mapa indexado por el vocabulario, un texto por token
// ---------------------------------------------------------------------------

/**
 * 构建 required 重试提示
 * @param {string|Object} toolChoice - 内部 tool_choice
 * @returns {string} 提示文本
 */
const buildRequiredToolRetryHint = (toolChoice) => {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return `You did not call any tool. You MUST now call \`${toolChoice.function.name}\` using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format.`
  }
  return `You did not call any tool. You MUST now call exactly one tool using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format.`
}

/**
 * El hint del caso vacío. Antes vivía en tres módulos (`anthropic.js`, `chat.js` y el
 * runtime OpenAI arman el suyo con `buildAgentRetryHint('empty')`); este es el texto que
 * el corpus grabó para las superficies Anthropic, byte a byte.
 */
const buildEmptyOutputRetryHint = () => [
  'Your previous reply produced no visible final answer or executable tool call.',
  `Continue the Agent task now. If any action remains, emit the required \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
  'Only give a normal final answer when the task is actually complete; do not repeat hidden reasoning.'
].join(' ')

/** El hint de "describió la acción y no la ejecutó" (`missing_tool`), solo Anthropic. */
const buildMissingToolRetryHint = () => [
  'Your previous reply described an action but did not execute any tool call.',
  `Perform that action now by emitting the real \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
  'Do not describe the action again or claim completion without a tool result.'
].join(' ')

/**
 * 工具错误的重试提示。基础文本复用 agent-turn.js 的通用提示；当错误是编造的工具名时，
 * 补上真实的名字 —— 那是让这类错误可恢复的唯一信息。原生调用的参数不合法
 * （invalid_arguments / schema_mismatch）时，点名该工具：模型要重发的是参数，不是名字。
 * @param {Array<Object>} errors - 本轮的工具错误
 * @param {Array<string>} allowedToolNames - 本次请求真正提供的工具名
 * @returns {string} 提示文本
 */
const buildToolErrorRetryHint = (errors, allowedToolNames) => {
  const base = buildAgentRetryHint('invalid_tool_call')
  const unknown = [...new Set(
    errors.filter(e => e?.type === 'unknown_tool').map(e => e.name).filter(Boolean)
  )]
  const badArguments = [...new Set(
    errors.filter(e => e?.type === 'invalid_arguments' || e?.type === 'schema_mismatch').map(e => e.name).filter(Boolean)
  )]
  const lines = [base]
  if (unknown.length && allowedToolNames?.length) {
    lines.push(
      `The tool name(s) ${unknown.join(', ')} do not exist.`,
      `Use ONLY these exact tool names: ${allowedToolNames.join(', ')}.`
    )
  }
  if (badArguments.length) {
    lines.push(`Your arguments for tool ${badArguments.join(', ')} were not a valid JSON object or missed required keys. Re-emit the call with a complete JSON object that matches the tool's input schema.`)
  }
  return lines.join('\n')
}

/**
 * El mapa: un token del vocabulario, un constructor de hint. Los cuerpos compartidos salen
 * de `agent-turn.js#buildAgentRetryHint` (una sola copia de esos textos); los tres tokens
 * que ese mapa no tenía (`required_tool`, `missing_tool`, `tool_error`) entran con el texto
 * exacto que ya producían los constructores locales del controlador.
 *
 * `prose_with_tools` es el detalle con el que la superficie OpenAI rechaza prosa junto a
 * llamadas: su hint hoy es el cuerpo `invalid_tool_call` de agent-turn.js, así que el token
 * lo conserva textualmente. La forma de hint de `required_tool` que usa la superficie
 * OpenAI (el cuerpo genérico, sin `tool_choice` que nombrar) es otra: la decide el ticket
 * que cablea esa superficie, no esta.
 */
const RETRY_HINT_BUILDERS = Object.freeze({
  [REASONS.EMPTY]: () => buildEmptyOutputRetryHint(),
  [REASONS.BARE]: () => buildAgentRetryHint('bare'),
  [REASONS.INVALID_CONTROL]: () => buildAgentRetryHint('invalid_control'),
  [REASONS.REQUIRED_TOOL]: (snapshot, context) => buildRequiredToolRetryHint(context?.toolChoice),
  [REASONS.TOOL_ERROR]: (snapshot, context) => buildToolErrorRetryHint(snapshot.toolErrors || [], context?.allowedToolNames),
  [REASONS.PROSE_WITH_TOOLS]: () => buildAgentRetryHint('invalid_tool_call'),
  [REASONS.INTERCEPTED]: () => buildAgentRetryHint('intercepted'),
  [REASONS.MALFORMED_PROTOCOL]: () => buildAgentRetryHint('malformed_protocol'),
  [REASONS.THOUGHT_TOOL_CALL]: () => buildAgentRetryHint('thought_tool_call'),
  [REASONS.MISSING_TOOL]: () => buildMissingToolRetryHint()
})

/**
 * El hint de una razón, con los dos apéndices que hoy agrega el controlador:
 * - `required_tool` / `missing_tool` ganan la prioridad sobre `intercepted` y lo esconden;
 *   el hint no cambia la prioridad — solo lleva el hecho clave: la llamada no llegó.
 * - `required_tool` / `tool_error` tapan `thought_tool_call`; el hint lleva igual el hecho
 *   de que la llamada quedó escrita en la razón oculta del modelo.
 * @param {string} reason - token del vocabulario
 * @param {Object} snapshot - el snapshot del intento (de acá salen errores y evidencia)
 * @param {{ toolChoice?: string|Object, allowedToolNames?: Array<string> }} [context]
 * @returns {string} hint de reintento
 */
const retryHintFor = (reason, snapshot, context = {}) => {
  const build = RETRY_HINT_BUILDERS[reason]
  let hint = build ? build(snapshot || {}, context) : buildAgentRetryHint(reason)
  if ((reason === REASONS.REQUIRED_TOOL || reason === REASONS.MISSING_TOOL) &&
      (snapshot?.interceptedToolNames || []).length > 0) {
    hint = `${hint}\n${buildAgentRetryHint('intercepted')}`
  }
  if ((reason === REASONS.REQUIRED_TOOL || reason === REASONS.TOOL_ERROR) && snapshot?.thinkEvidence) {
    hint = `${hint}\n${buildAgentRetryHint('thought_tool_call')}`
  }
  return hint
}

// ---------------------------------------------------------------------------
// Mensajes de agotamiento: el segundo mapa indexado por el mismo vocabulario
// ---------------------------------------------------------------------------

/**
 * Qué se le dice al cliente cuando el presupuesto de intentos se agota y el último intento
 * seguía rechazado. Vivía en `openai-agent-runtime.js` con la clave `invalid_tool_call` —la
 * misma condición que este vocabulario parte en `tool_error` (errores de herramienta) y
 * `prose_with_tools` (prosa junto a llamadas)—, y las dos mitades conservan el texto de la
 * clave vieja: el renombre es del vocabulario, no del mensaje que ya viajaba al cliente.
 *
 * El mapa NO lleva el status ni el código de cable: estos son vocabulario de cada superficie
 * (ADR 0001) y los pone el runtime que consume el mapa.
 */
const EXHAUSTED_TURN_MESSAGES = Object.freeze({
  [REASONS.EMPTY]: '上游连续只返回思考内容，没有给出可执行工具调用或最终答复',
  [REASONS.BARE]: '上游连续返回未声明完成状态的文本，已阻止 Agent 将未完成任务误判为结束',
  [REASONS.INVALID_CONTROL]: '上游连续返回无效的 Agent 完成标记',
  [REASONS.TOOL_ERROR]: '上游连续返回残缺、非法或不存在的工具调用',
  [REASONS.PROSE_WITH_TOOLS]: '上游连续返回残缺、非法或不存在的工具调用',
  [REASONS.REQUIRED_TOOL]: '上游连续违反 tool_choice，未返回要求的工具调用',
  [REASONS.INTERCEPTED]: '上游的工具调用被平台拦截，重试后仍未恢复',
  [REASONS.MALFORMED_PROTOCOL]: '上游持续返回残缺的工具调用协议，未能恢复为可执行调用'
})

/**
 * Añade un hint de reintento al último mensaje del cuerpo interno. Una sola implementación
 * para las tres superficies: `header` es lo único que cambia entre ellas (el Anthropic manda
 * `# Tool-call retry` delante; el runtime OpenAI no manda encabezado) y va donde hoy lo
 * mandan sus llamadores — en los dos brazos que **agregan a un texto existente**. Los brazos
 * que insertan un bloque nuevo lo hacen sin encabezado, como hoy.
 *
 * Devuelve un clon: el cuerpo original se reusa entre reintentos y no puede llevar la marca
 * del intento anterior.
 * @param {Object} body - cuerpo interno de la petición
 * @param {string} hint - hint de reintento
 * @param {{ header?: string|null }} [options] - encabezado a intercalar, si la superficie lo usa
 * @returns {Object} cuerpo nuevo con el hint al final
 */
const appendRetryHint = (body, hint, { header = null } = {}) => {
  const clone = body && typeof body === 'object'
    ? JSON.parse(JSON.stringify(body))
    : {}
  const messages = Array.isArray(clone.messages) ? clone.messages : []
  const separator = header ? `\n\n${header}\n` : '\n\n'
  if (messages.length === 0) {
    messages.push({ role: 'user', content: hint })
  } else {
    const last = messages[messages.length - 1]
    if (typeof last.content === 'string') {
      last.content = `${last.content}${separator}${hint}`
    } else if (Array.isArray(last.content)) {
      const textPart = last.content.find(part => part?.type === 'text')
      if (textPart) textPart.text = `${textPart.text || ''}${separator}${hint}`
      else last.content.unshift({ type: 'text', text: hint })
    } else {
      last.content = hint
    }
  }
  clone.messages = messages
  return clone
}

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

/**
 * Lo que la superficie OpenAI hoy retira de la entrega cuando acepta una ronda por sus
 * llamadas nativas: el texto que la acompaña puede traer llamadas de texto mal escritas o
 * residuo de protocolo, y ese texto no viaja.
 */
const suppressForNativeAccept = (snapshot) =>
  (snapshot.textToolErrors || []).length > 0 || snapshot.orphanResidue === true

/**
 * La misma idea en la rama de la ronda cortada: acá el veto mira **todos** los errores (no
 * solo los del canal de texto) y, además, la prosa que la política no permite junto a tools.
 */
const suppressForCutAccept = (snapshot, policy) =>
  (snapshot.toolErrors || []).length > 0 ||
  snapshot.orphanResidue === true ||
  (policy?.proseWithTools !== true && String(snapshot.visibleText || '').trim() !== '')

const accept = (finishReason, suppressVisibleText = false) => ({
  verdict: 'accept',
  finishReason,
  reason: null,
  suppressVisibleText
})

const retry = (reason) => ({
  verdict: 'retry',
  finishReason: null,
  reason,
  suppressVisibleText: false
})

/**
 * La decisión de un intento. Función pura de un snapshot más una política.
 *
 * Snapshot — describe **exactamente un intento** (lo compartido entre intentos, el cupo de
 * recuperación de protocolo y si alguna vez se entregó texto, se queda en el loop):
 *   finishReason          razón cruda del upstream
 *   visibleText           texto visible **de este intento** (el insumo de detección)
 *   controlKind           'final' | 'blocked' | 'empty' | 'invalid_control' | 'bare' | null
 *                         (null = una superficie sin vocabulario de control, como las Anthropic)
 *   toolCalls             llamadas admisibles de este intento
 *   toolErrors            todos los errores de herramienta del intento
 *   textToolErrors        el subconjunto del canal de texto (decide con finish terminal)
 *   nativeToolCalls       llamadas estructuradas admitidas por el gate de schema
 *   interceptedToolNames  frames role:function que la plataforma se comió
 *   thinkEvidence         una llamada quedó escrita en la razón oculta
 *   callsDelivered        un bloque tool_use ya llegó al cliente (no se puede retractar)
 *   textChannelCut        la guarda de fuga cortó el texto del intento a mitad de stream
 *   orphanResidue         residuo de protocolo malformado en visibleText
 *   hasTools              la petición declaró herramientas
 *   requiresToolCall      el tool_choice de la petición exige una llamada
 * Los dos últimos son los únicos hechos de **petición** que la puerta necesita; hoy viven en
 * `options` del runtime OpenAI y en el `ctx` de los controladores Anthropic.
 *
 * Política — cuatro campos con nombre, decididos por el llamador (la puerta no lee el
 * singleton de configuración):
 *   proseWithTools          ¿la prosa junto a llamadas se acepta? (OpenAI no, Anthropic sí)
 *   acceptBareFinal         ¿la prosa sin envoltorio de cierre es una respuesta final?
 *   toolErrorsBeforeRequired ¿los errores de herramienta vetan antes que `required_tool`?
 *   toolErrorsVetoWithCalls ¿un error de herramienta veta aunque haya una llamada parseada?
 *
 * @param {Object} snapshot - un intento
 * @param {Object} policy - la política de la superficie
 * @returns {{ verdict: 'accept'|'retry', finishReason: string|null, reason: string|null, suppressVisibleText: boolean }}
 */
const gate = (snapshot, policy) => {
  const s = snapshot || {}
  const p = policy || {}
  const terminal = TERMINAL_FINISH_REASONS.has(s.finishReason)
  const hasTools = s.hasTools !== false
  const visibleText = typeof s.visibleText === 'string' ? s.visibleText : ''
  const calls = s.toolCalls || []
  const nativeToolCalls = s.nativeToolCalls || []
  const intercepted = s.interceptedToolNames || []
  const controlKind = s.controlKind || null
  // Con finish terminal, el error nativo (el snapshot truncado del acumulador) no veta: la
  // fuente de texto mantiene su comportamiento. Sin terminal, vetan los dos canales.
  const toolErrors = terminal ? (s.textToolErrors || []) : (s.toolErrors || [])

  // El cliente ya tiene un bloque tool_use: no hay nada que retractar. Este es el campo que
  // hace que stream y no-stream sean la misma decisión.
  if (s.callsDelivered === true) return accept(FINISH_TOOL_CALLS)

  // Llamadas nativas estructuradas: evidencia más dura que cualquier veto textual, va antes
  // de los errores y de "la prosa no convive con tools".
  if (nativeToolCalls.length > 0) {
    return accept(FINISH_TOOL_CALLS, suppressForNativeAccept(s))
  }

  // Ronda cortada por la guarda de fuga con llamadas admitidas: se entrega siempre (rechazarla
  // reintenta la fuga recién detenida, y el reintento cae en el chat_id cuya generación
  // abortada sigue viva en Qwen → CHAT_IN_PROGRESS).
  if (s.textChannelCut === true && calls.length > 0) {
    return accept(FINISH_TOOL_CALLS, suppressForCutAccept(s, p))
  }

  // Errores de herramienta: la precedencia respecto de `required_tool` — y si vetar o no
  // cuando además hay una llamada parseada — es política de la superficie.
  const toolErrorVeto = toolErrors.length > 0 &&
    (calls.length === 0 || p.toolErrorsVetoWithCalls === true)
  if (p.toolErrorsBeforeRequired === true && toolErrorVeto) return retry(REASONS.TOOL_ERROR)

  // tool_choice exigía una llamada y este intento no entregó ninguna.
  if (hasTools && s.requiresToolCall === true && calls.length === 0) return retry(REASONS.REQUIRED_TOOL)

  if (toolErrorVeto) return retry(REASONS.TOOL_ERROR)

  // Terminaciones que el upstream ya explicó: la ronda se entrega como está, reintentar no
  // las arregla. Va después de los vetos —con finish terminal el error del canal de texto
  // todavía veta, y `required_tool` también— y antes de la rama de llamadas, para que una
  // ronda truncada con llamadas se entregue en vez de reintentarse por su prosa.
  if (terminal) return accept(FINISH_STOP)

  // Llamadas admisibles: la superficie OpenAI veta la prosa que las acompaña; las Anthropic
  // aceptan — el cliente recibe bloques tool_use discretos y puede actuar con lo que llegó.
  if (calls.length > 0) {
    if (p.proseWithTools !== true && (controlKind !== 'empty' || visibleText.trim())) {
      return retry(REASONS.PROSE_WITH_TOOLS)
    }
    return accept(FINISH_TOOL_CALLS)
  }

  // Evidencia de protocolo. Con finish terminal no se reintenta (la generación ya terminó
  // por una razón que el reintento no arregla) y sin herramientas no hay evidencia que valga.
  if (hasTools && !terminal) {
    // intercepted primero: el frame descartado es la evidencia más fuerte.
    if (intercepted.length > 0) return retry(REASONS.INTERCEPTED)
    // El cupo de recuperación de protocolo ya gastado no reintenta por residuo — pero el
    // residuo sigue contando para la supresión de la entrega (ver `suppressForNativeAccept`).
    // Sólo la superficie que lleva ese cupo lo declara; donde el campo no llega, la regla es
    // la de siempre.
    if (s.orphanResidue === true && s.protocolRecoverySpent !== true) return retry(REASONS.MALFORMED_PROTOCOL)
    if (s.thinkEvidence === true) return retry(REASONS.THOUGHT_TOOL_CALL)
    // Solo en una superficie sin vocabulario de control: donde hay envoltorio, la prosa la
    // deciden las reglas del envoltorio (la superficie OpenAI no detecta `missing_tool`).
    if (controlKind === null && looksLikeUnexecutedToolAction(visibleText)) {
      return retry(REASONS.MISSING_TOOL)
    }
  }

  // El envoltorio de cierre (vocabulario de la superficie OpenAI; las Anthropic pelan los
  // tags sin interpretarlos, así que llegan acá con controlKind null).
  if (controlKind === 'final' || controlKind === 'blocked') {
    return visibleText.trim() ? accept(FINISH_STOP) : retry(REASONS.EMPTY)
  }
  if (controlKind === 'empty') return retry(REASONS.EMPTY)
  if (controlKind === 'invalid_control') return retry(REASONS.INVALID_CONTROL)
  if (controlKind === 'bare') {
    return p.acceptBareFinal === true ? accept(FINISH_STOP) : retry(REASONS.BARE)
  }

  // Sin envoltorio: `empty` es alcance de intento (el texto que cuenta es el de este intento,
  // no el acumulado), y la prosa que queda es una respuesta final si la superficie lo dice.
  if (!terminal && !visibleText.trim()) return retry(REASONS.EMPTY)
  return p.acceptBareFinal === true ? accept(FINISH_STOP) : retry(REASONS.BARE)
}

module.exports = {
  gate,
  REASONS,
  PROTOCOL_RECOVERY_REASONS,
  TERMINAL_FINISH_REASONS,
  FINISH_STOP,
  FINISH_TOOL_CALLS,
  resolveAttemptBudget,
  RETRY_HINT_BUILDERS,
  EXHAUSTED_TURN_MESSAGES,
  retryHintFor,
  appendRetryHint,
  buildRequiredToolRetryHint,
  buildEmptyOutputRetryHint,
  buildMissingToolRetryHint,
  buildToolErrorRetryHint,
  MIN_ATTEMPT_BUDGET,
  MAX_ATTEMPT_BUDGET
}
