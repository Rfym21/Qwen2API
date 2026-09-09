// El logger es la unica dependencia externa de este modulo (fs/path adentro): agent-turn.js
// sigue siendo hoja del grafo — tool-prompt.js lo requiere, no al reves.
const { logger } = require('./logger.js')

const AGENT_FINAL_OPEN = '<agent_final>'
const AGENT_FINAL_CLOSE = '</agent_final>'
const AGENT_BLOCKED_OPEN = '<agent_blocked>'
const AGENT_BLOCKED_CLOSE = '</agent_blocked>'

// 工具调用的规范标记。定义在这里（依赖图的叶子），tool-prompt.js 和各重试提示共同引用，
// 保证提示词、折叠回写和重试提示永远教同一种形式。
//
// 为什么不是 <tool_call>：那是 Qwen 平台的**原生**格式，而原生意味着平台自己的
// server-side agent loop 也在盯着它 —— 模型一吐出来就被拦截，拿去查平台自己的
// tool registry（里面没有我们的工具），然后把 "Tool <name> does not exists" 塞回
// 模型的生成上下文。模型看到"工具全坏了"，就放弃调用改为口头汇报失败。
// 实测：2026-08-30 19:56 的会话死亡与 5 条 role:function 拦截逐秒对应，名字正是
// "Bash"/"Read"；auto_search:false 也关不掉这个拦截器（18/18 探针通过但拦截照发）。
// 换成平台不认识的标记，拦截器就出局了。旧尖括号形式在读取侧仍然被识别（RL 惯性
// 输出），只是不再教、不再写 —— 见 tool-prompt.js 的 TOOL_CALL_TRIGGER_RE。
const TOOL_CALL_OPEN = '[TOOL CALL]'
const TOOL_CALL_CLOSE = '[END TOOL CALL]'

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const unwrapExactTag = (value, openTag, closeTag) => {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(openTag)}([\\s\\S]*?)${escapeRegExp(closeTag)}\\s*$`,
    'i'
  )
  const matched = String(value || '').match(pattern)
  return matched ? matched[1].trim() : null
}

/**
 * Agent 请求的可见输出必须明确声明本回合是“已完成”还是“需要用户输入”。
 * 工具调用由 tool-prompt 解析器先行抽取，因此这里仅处理剩余文本。
 */
const parseAgentControlText = (value) => {
  const raw = String(value || '')
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'empty', text: '' }

  const finalText = unwrapExactTag(trimmed, AGENT_FINAL_OPEN, AGENT_FINAL_CLOSE)
  if (finalText !== null) return { kind: 'final', text: finalText }

  const blockedText = unwrapExactTag(trimmed, AGENT_BLOCKED_OPEN, AGENT_BLOCKED_CLOSE)
  if (blockedText !== null) return { kind: 'blocked', text: blockedText }

  if (/<\/?agent_(?:final|blocked)>/i.test(trimmed)) {
    return { kind: 'invalid_control', text: trimmed }
  }
  return { kind: 'bare', text: trimmed }
}

/**
 * 增量识别严格 Agent 的 final/blocked 包装。只有开标签位于首个非空白位置时
 * 才开放正文；闭标签及其可能跨 chunk 的前缀始终留在缓冲区。
 *
 * 正文采用与 parseAgentControlText 相同的 trim 语义：丢弃包装内的首尾空白，
 * 中间空白仍按原顺序增量输出。完整合法性最终仍由 parseAgentControlText 判定。
 */
const createAgentControlStreamParser = () => {
  const modes = [
    { kind: 'final', open: AGENT_FINAL_OPEN, close: AGENT_FINAL_CLOSE },
    { kind: 'blocked', open: AGENT_BLOCKED_OPEN, close: AGENT_BLOCKED_CLOSE }
  ]
  let state = 'prefix'
  let mode = null
  let pending = ''
  let bodyStarted = false
  let trailingWhitespace = ''
  let emittedText = false
  let invalid = false

  const createResult = () => ({
    textDelta: '',
    kind: mode?.kind || null,
    opened: false,
    closed: state === 'closed' && !invalid,
    invalid
  })

  const appendBodyText = (value, final, result) => {
    let text = String(value || '')
    if (!bodyStarted) {
      text = text.replace(/^\s+/, '')
      if (!text) {
        if (final) trailingWhitespace = ''
        return
      }
      bodyStarted = true
    }

    const combined = `${trailingWhitespace}${text}`
    const trailing = combined.match(/\s+$/)?.[0] || ''
    const safe = trailing ? combined.slice(0, -trailing.length) : combined
    if (safe) {
      result.textDelta += safe
      emittedText = true
    }
    trailingWhitespace = final ? '' : trailing
  }

  const splitClosePrefix = (value, closeTag) => {
    const lower = value.toLowerCase()
    const close = closeTag.toLowerCase()
    const maxLength = Math.min(lower.length, close.length - 1)
    for (let length = maxLength; length > 0; length--) {
      if (close.startsWith(lower.slice(-length))) {
        return {
          safe: value.slice(0, -length),
          remainder: value.slice(-length)
        }
      }
    }
    return { safe: value, remainder: '' }
  }

  const processBody = (result) => {
    const closeTag = mode.close
    const closeIndex = pending.toLowerCase().indexOf(closeTag.toLowerCase())
    if (closeIndex !== -1) {
      appendBodyText(pending.slice(0, closeIndex), true, result)
      pending = pending.slice(closeIndex + closeTag.length)
      state = 'closed'
      result.closed = true
      if (pending.trim()) {
        invalid = true
        state = 'invalid'
        result.invalid = true
        result.closed = false
      }
      return
    }

    const split = splitClosePrefix(pending, closeTag)
    pending = split.remainder
    appendBodyText(split.safe, false, result)
  }

  const processPrefix = (result) => {
    const leadingLength = pending.match(/^\s*/)?.[0].length || 0
    const candidate = pending.slice(leadingLength)
    if (!candidate) return
    const lowerCandidate = candidate.toLowerCase()
    const matchedMode = modes.find(item => lowerCandidate.startsWith(item.open.toLowerCase()))
    if (matchedMode) {
      mode = matchedMode
      pending = candidate.slice(matchedMode.open.length)
      state = 'body'
      result.kind = mode.kind
      result.opened = true
      processBody(result)
      return
    }

    const isOpenPrefix = modes.some(item => item.open.toLowerCase().startsWith(lowerCandidate))
    if (!isOpenPrefix) {
      invalid = true
      state = 'invalid'
      result.invalid = true
    }
  }

  const push = (chunk) => {
    const result = createResult()
    if (typeof chunk !== 'string' || chunk.length === 0 || state === 'invalid') return result
    pending += chunk
    if (state === 'prefix') processPrefix(result)
    else if (state === 'body') processBody(result)
    else if (state === 'closed' && pending.trim()) {
      invalid = true
      state = 'invalid'
      result.invalid = true
      result.closed = false
    }
    result.kind = mode?.kind || result.kind
    return result
  }

  const flush = () => {
    const result = createResult()
    if (state !== 'closed' || pending.trim()) {
      invalid = true
      state = 'invalid'
      result.invalid = true
      result.closed = false
    }
    result.kind = mode?.kind || null
    return result
  }

  return {
    push,
    flush,
    getState: () => ({
      kind: mode?.kind || null,
      opened: mode !== null,
      closed: state === 'closed' && !invalid,
      invalid,
      hasEmittedText: emittedText
    })
  }
}

const AGENT_CONTROL_TAGS = [
  AGENT_FINAL_OPEN,
  AGENT_FINAL_CLOSE,
  AGENT_BLOCKED_OPEN,
  AGENT_BLOCKED_CLOSE
]

/**
 * 从可见正文中剥离 Agent 回合包装标签。
 *
 * /v1/messages 注入的是与 OpenAI 路径同一份工具提示词，所以模型同样会输出
 * <agent_final>...</agent_final>；但 Anthropic 控制器没有接 Agent 回合门禁，
 * 标签因此原样透传给客户端。这里只做剥离，不做合法性判定：没有门禁就没有
 * 重生回合的地方，把“散文 + 包装”的回合判成 invalid 只会让整个回合失败。
 *
 * 流式必须缓冲：标签可能被切在两个 chunk 中间。push 只返回确定不属于标签的
 * 前缀，结束时必须调用一次 flush 取回缓冲区，否则末尾文本会丢。缓冲区最多
 * 保留一个标签长度的前缀，不会随流增长。
 */
const createAgentTagStripper = () => {
  let pending = ''

  const push = (chunk) => {
    if (typeof chunk !== 'string' || !chunk) return ''
    pending += chunk
    let out = ''
    for (;;) {
      const start = pending.indexOf('<')
      if (start === -1) {
        out += pending
        pending = ''
        return out
      }
      out += pending.slice(0, start)
      pending = pending.slice(start)

      const lower = pending.toLowerCase()
      const matched = AGENT_CONTROL_TAGS.find(tag => lower.startsWith(tag.toLowerCase()))
      if (matched) {
        pending = pending.slice(matched.length)
        continue
      }
      // 可能是被 chunk 边界切断的标签前缀：留在缓冲区等下一段。
      if (AGENT_CONTROL_TAGS.some(tag => tag.toLowerCase().startsWith(lower))) return out
      // 确定不是标签：'<' 属于正文，跳过它继续扫描。
      out += '<'
      pending = pending.slice(1)
    }
  }

  const flush = () => {
    const rest = pending
    pending = ''
    return rest
  }

  return { push, flush }
}

const stripAgentTags = (value) => {
  const stripper = createAgentTagStripper()
  return `${stripper.push(String(value || ''))}${stripper.flush()}`
}

const buildAgentTurnDirective = ({ afterToolResult = false } = {}) => {
  const continuation = afterToolResult
    ? 'The current message is a tool result from the same unfinished task. It is evidence to inspect, not a new task and not a reason to stop after one action.'
    : 'Treat this request as one step in an Agent task. Recover the original acceptance criteria from the conversation before deciding whether the task is complete.'

  return [
    '# Agent loop control (highest-priority output contract)',
    continuation,
    'The client executes tools and automatically sends each tool result back in the next request. Keep that loop alive until the original task is genuinely complete.',
    'Before responding, check the original request, every claimed deliverable, failures in tool results, and whether verification is still missing.',
    'Your entire visible response MUST be exactly one of these modes:',
    `1. If any action, inspection, edit, command, test, retry, or verification remains: emit one or more valid \`${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE}\` blocks and no prose.`,
    `2. Only when every requested outcome is complete and supported by tool-result evidence: emit ${AGENT_FINAL_OPEN}a concise final report${AGENT_FINAL_CLOSE}.`,
    `3. Only when progress is impossible without new user input or authority: emit ${AGENT_BLOCKED_OPEN}the exact blocker and required input${AGENT_BLOCKED_CLOSE}.`,
    'Bare prose, a plan, a progress update, hidden reasoning without visible output, or a claim such as “done” without the completion wrapper is an invalid Agent turn and will be regenerated.',
    'Never use the completion wrapper merely because one tool call finished. If verification has not run or any requested work remains, call the next tool.',
    // Contrapeso a las tres lineas de arriba, que solo empujan a emitir MAS llamadas.
    // Medido: 526 de 1.451 duplicados no tenian colision de nombre — el modelo reemitio
    // una llamada que ya habia hecho. No es una prohibicion: releer un archivo despues
    // de editarlo es la conducta correcta, y por eso la excepcion va en la misma linea.
    'Do not re-issue a call whose result is already in this context; read that result instead, unless a preceding action could have changed it.'
  ].join('\n')
}

const buildAgentRetryHint = (reason = 'incomplete') => {
  const reasonText = {
    empty: 'The previous attempt ended without a visible answer or executable tool call.',
    bare: 'The previous attempt returned bare prose without declaring a verified final result or emitting the next tool call.',
    invalid_control: 'The previous attempt used a malformed or mixed Agent completion wrapper.',
    invalid_tool_call: 'The previous attempt contained an invalid, truncated, or unknown tool call.',
    required_tool: 'The previous attempt violated tool_choice and did not call the required tool.',
    intercepted: `Your tool call did not reach the client. Re-emit it now using EXACTLY the \`${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE}\` format as the first content of your answer — never any other format.`,
    malformed_protocol: `Your tool call was malformed and was NOT executed. Re-emit it now: output ${TOOL_CALL_OPEN} as the FIRST content of your answer, then the JSON payload, then ${TOOL_CALL_CLOSE} — nothing before, between, or after.`,
    // 泄漏在 think phase 的调用：模型把整个可执行负载写进了隐藏推理，然后在正文里
    // 叙述"已完成"。推理里的调用永远不执行、永远到不了客户端 —— 提示词只带这个
    // 关键事实与规范标记，不带平台机制。
    thought_tool_call: `Your tool call was emitted inside your hidden reasoning, so it was never executed and never reached the client. Re-emit it now as the FIRST content of your answer, using EXACTLY the \`${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE}\` format — never inside reasoning, never any other format.`
  }[reason] || 'The previous attempt did not produce a valid Agent turn.'

  return [
    '# Agent turn recovery',
    reasonText,
    'Continue the SAME original task. Re-check its acceptance criteria and the latest tool result.',
    `If work remains, output only valid \`${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE}\` blocks. If and only if all work is verified complete, output ${AGENT_FINAL_OPEN}the final report${AGENT_FINAL_CLOSE}.`,
    `If user input is strictly required, output ${AGENT_BLOCKED_OPEN}the blocker${AGENT_BLOCKED_CLOSE}. Do not output bare planning prose.`
  ].join('\n')
}

/** 键排序后的规范 JSON：跨通道去重要把 `{"a":1,"b":2}` 与 `{"b": 2, "a": 1}` 判成同一份参数。 */
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// `[THINKING]` / `[END THINKING]` es la tercera familia de delimitadores que el proxy
// escribe en el prompt (controllers/anthropic.js). Vive AQUI, en la regla compartida, y
// no en el sitio que lo emite, porque el texto no confiable entra al prompt por cuatro
// puertas — el cuerpo del propio `thinking`, el texto hermano del mismo mensaje, el
// cuerpo de un `tool_result` y el digest del ledger — y las cuatro tienen que fallar
// igual. Con la neutralizacion solo en el emisor, un fichero leido que contuviera
// `[END THINKING]` volvia crudo a la historia y cerraba un bloque que no era suyo.
//
// Se aceptan las variantes que un modelo escribiria de verdad (`[/THINKING]`,
// `[END_THINKING]`, `[END\nTHINKING]`, `[THINKING: por que]`), pero se exige `]` o `:`
// tras la palabra: sin ese ancla, prosa legitima como `[thinking about lunch]` quedaria
// mutilada, y mutilar prosa por un delimitador que nadie estaba forjando es peor negocio.
const THINKING_MARKER_RE = /\[(?=[ \t]{0,4}(?:END[ \t\r\n_-]{1,2}|\/[ \t]{0,4})?THINKING[ \t]*[\]:])/gi;

/**
 * Rompe el corchete de cualquier delimitador de razonamiento incrustado en el texto.
 * Un caracter ASCII por otro: nunca alarga, asi que los topes de bytes siguen exactos.
 * @param {string} value - texto no confiable
 * @returns {string} texto con los delimitadores de thinking inertes
 */
const defuseThinkingMarkers = (value) => String(value).replace(THINKING_MARKER_RE, '(');

/**
 * Un corte por unidades UTF-16 (`slice`) puede partir un par subrogado por la mitad.
 * `JSON.stringify` escapa la mitad huerfana sin quejarse, asi que no revienta aqui:
 * revienta arriba, como U+FFFD o como error de parseo segun quien lo lea. Se tira la
 * mitad suelta de cada punta. Solo acorta, asi que ningun tope se rompe.
 * @param {string} value - texto ya recortado
 * @returns {string} texto sin subrogados sueltos en los extremos
 */
const trimLoneSurrogates = (value) => {
  let out = String(value);
  const first = out.charCodeAt(0);
  if (first >= 0xDC00 && first <= 0xDFFF) out = out.slice(1);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1);
  return out;
};

/**
 * 结果正文必须对它自己封闭。工具结果是**不可信内容** —— 文件、网页、命令输出 —— 里面
 * 完全可能出现 `[END TOOL RESULT]`。原样写出去，块就在那里提前结束，后面的内容就变成了
 * 对模型说的话。把正文里的标记打断，让它再也关不掉这个块。
 *
 * 住在这里（依赖图的叶子）而不是 tool-prompt.js：折叠回写（foldToolMessages）和
 * 执行过的调用清单（buildToolHistoryLedger）都要把同一批不可信文本重新塞回提示词，
 * 两边必须用**同一份**失效规则。tool-prompt.js 以同名导入它。
 * @param {string} value - 原始结果正文
 * @returns {string} 标记已失效的正文
 */
const neutraliseResultMarkers = (value) => String(value)
  .replace(/\[[ \t]*END[ \t]+TOOL[ \t]+RESULT[ \t]*\]/gi, '(END TOOL RESULT)')
  // 只打断头字符，不重写整段。结果头现在可能带序号（`[TOOL RESULT #3: X]`），旧写法
  // 要求 RESULT 后面**紧跟冒号**，认不出编号形式 —— 于是不可信正文可以伪造一个编号头，
  // 冒充某次真实调用的答复。这里不再要求冒号：`[` 后面是 TOOL RESULT 就失效。
  .replace(/\[(?=[ \t]*TOOL[ \t]+RESULT\b)/gi, '(')
  // 调用标记同样要在结果正文里失效：不可信内容里的 `[TOOL CALL]` / `<tool_call>`
  // 一旦被模型原样引用到回答开头，就是一个可以点火的触发器。把头字符换掉，
  // 触发器正则（tool-prompt.js 的 TOOL_CALL_TRIGGER_RE，与这里锁步）就永远匹配不上。
  .replace(/\[(?=[ \t]{0,4}tool[ \t_-]{1,2}calls?)/gi, '(')
  .replace(/\[(?=[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?)/gi, '(')
  // i 标志不可省：TOOL_CALL_TRIGGER_RE 的尖括号臂是 case-insensitive，缺 i 时
  // `<TOOL_CALL>` 从不可信正文里原样漏过，被模型引用到回答开头就能点火调起工具。
  .replace(/<(?=[ \t]{0,4}\/?[ \t]{0,4}tool_calls?)/gi, '(')
  // Las dos cabeceras del sobre (utils/request.js#parseAgentEnvelope) tambien son
  // marcadores de protocolo, y desde que el ledger vive en el PREFIJO hay texto derivado
  // de herramientas por DELANTE de la cabecera real. parseAgentEnvelope parte por
  // `indexOf` en la historia (gana la PRIMERA) y por `lastIndexOf` en el mensaje actual
  // (gana la ULTIMA), asi que un resultado que contenga la cadena literal mueve el corte:
  // la cola del prefijo se reclasifica como historia y sus lineas se parsean como JSONL
  // legitimo. Se rompe el `#` de cabecera, igual que arriba se rompe el `[` o el `<`.
  // Un solo caracter ASCII por otro: la neutralizacion nunca alarga, asi que los topes
  // de bytes del ledger se mantienen exactos.
  .replace(/#(?=[ \t]{0,4}Conversation[ \t]+history[ \t]*\(JSONL\))/gi, '(')
  .replace(/#(?=[ \t]{0,4}Current[ \t]+message\b)/gi, '(');

/**
 * Un cuerpo del que NADA es nuestro: un fichero, una pagina, la salida de un comando.
 *
 * Es `neutraliseResultMarkers` mas el brazo THINKING, y existe separado por una razon
 * concreta: `neutraliseResultMarkers` tambien se aplica al contenido de un mensaje
 * `assistant` (tool-prompt.js, la rama con tool_calls y `neutraliseMessageMarkers`), y
 * ese contenido SI lleva delimitadores nuestros — el bloque `[THINKING]` que escribe
 * controllers/anthropic.js. Meter el brazo en la regla general defusaba el delimitador
 * REAL junto con los forjados y dejaba el razonamiento sin marcar.
 *
 * Regla: si el texto lo escribio integramente algo de fuera, pasa por aqui.
 * @param {string} value - cuerpo no confiable
 * @returns {string} cuerpo con todos los marcadores de protocolo inertes
 */
const neutraliseUntrustedBody = (value) => defuseThinkingMarkers(neutraliseResultMarkers(value));

const LEDGER_HEADER = '# Already executed this task';
// La leyenda es lo unico que hace el bloque legible por si solo: llega al modelo lejos
// del prompt de herramientas y sin ella es una lista de numeros sin contrato.
const LEDGER_CAPTION = 'These calls already ran and their results are above. Reuse a result instead of repeating its call, unless a later action could have changed it.';
// Sin esta nota, una lista recortada se lee como exhaustiva: "no esta en el ledger" pasaria
// a significar "no se llamo nunca", que es justo la conclusion falsa que dispara el duplicado.
const LEDGER_TRUNCATED_NOTE = '(older calls omitted)';
const LEDGER_DIGEST_CHARS = 120;
// Los argumentos IDENTIFICAN la llamada, asi que se recortan mucho mas tarde que el digest.
// Un heredoc de 10 KB en un Bash igual no puede comerse el bloque entero; cuando se recorta,
// el ordinal sigue distinguiendo dos llamadas que quedaron renderizadas igual.
const LEDGER_ARGS_CHARS = 200;

/** Una linea, sin saltos: el ledger es una entrada por linea y el contenido no es confiable. */
const collapseToOneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const truncateChars = (value, limit) =>
  value.length <= limit ? value : `${trimLoneSurrogates(value.slice(0, limit - 1))}…`;

/**
 * El contenido de un mensaje de resultado, resumido para el digest del ledger.
 *
 * Existe porque el resultado de una herramienta **no siempre es texto**: el Read de
 * Claude Code devuelve la imagen dentro de `tool_result.content`, y cada ruta la mueve a
 * un sitio distinto antes de llegar aqui — la Anthropic la saca a `message.media` y deja
 * `content: ''`; la OpenAI la deja como item dentro del array de `content`. Con
 * `JSON.stringify(content)` como unica regla las dos rutas rendian textos DISTINTOS para
 * la misma llamada (`(empty)` contra `[]`) y las dos mentian: decirle al modelo que un
 * Read no devolvio nada, bajo una leyenda que le pide reusar el resultado en vez de
 * repetir la llamada, es el empujon mas fuerte posible hacia el duplicado — y Read es la
 * herramienta mas repetida de la medicion (802 de 1.451).
 *
 * Los items que no son texto se CUENTAN, nunca se serializan: un item de imagen lleva el
 * data URI base64 completo y `JSON.stringify` lo metia crudo en el prompt (recortado a
 * 120 caracteres, o sea base64 partido a la mitad haciendose pasar por el resultado).
 *
 * @param {Object} message - mensaje con role tool/function, en cualquiera de las dos formas
 * @returns {{ text: string, attachments: number }}
 */
const summariseToolResultContent = (message) => {
  const raw = message?.content;
  // El bypass de medios de la ruta Anthropic (anthropic.js#flattenAnthropicMessages).
  let attachments = Array.isArray(message?.media) ? message.media.length : 0;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    const texts = [];
    for (const item of raw) {
      if (typeof item === 'string') texts.push(item);
      else if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
      else if (item !== null && item !== undefined) attachments += 1;
    }
    text = texts.join('\n');
  } else if (raw !== null && raw !== undefined) {
    // Un objeto de verdad (resultado estructurado) sigue siendo su JSON.
    text = JSON.stringify(raw);
  }
  // La nota de medios se convierte en el contador, no en prosa del digest.
  if (text) {
    const kept = [];
    for (const line of text.split('\n')) {
      const noted = line.trim().match(TOOL_RESULT_MEDIA_NOTE_RE);
      if (noted) attachments = Math.max(attachments, Number(noted[1]));
      else kept.push(line);
    }
    text = kept.join('\n');
  }
  return { text, attachments };
};

/** `(1 image)` / `(3 images)`: el digest DICE que hubo adjunto, sin poder cargarlo. */
const attachmentNote = (count) => (count === 1 ? '(1 image)' : `(${count} images)`);

/**
 * Lo que el CUERPO del resultado dice cuando la herramienta devolvio medios.
 *
 * Medido 2026-09-08 contra Qwen real: un tool_result que solo trae un bloque image (lo
 * EXACTO que manda Claude Code al hacer Read de una imagen) dejaba `resultContent` vacio,
 * y foldToolMessages lo renderizaba como `(empty)`. La imagen SI llegaba a files[] —el
 * cuerpo upstream era identico byte a byte al de un control que funciona, salvo ese texto—
 * asi que el modelo leia «el Read no devolvio nada» con una imagen sin explicar al lado, y
 * contestaba NO_IMAGE. El prompt ademas se contradecia: el ledger de agent-turn ya decia
 * `-> (1 image)` para esa misma llamada.
 *
 * La nota NO dice «adjunta»: solo se sube el medio del ULTIMO turno (los dos escaneos
 * gemelos), y aun ahi la deduplicacion por URL o HARVEST_MEDIA_CAP pueden descartarlo.
 * Prometer un adjunto que el modelo no puede ver es peor que el `(empty)` que sustituye.
 * Se queda en el hecho comprobable —la herramienta devolvio N medios— y concuerda con el
 * digest del ledger.
 *
 * @param {number} count - cuantos medios traia el resultado
 * @param {string} [noun] - 'image' salvo que el resultado traiga algo que no sea imagen
 * @returns {string} la linea que sustituye/acompana al cuerpo del resultado
 */
const toolResultMediaNote = (count, noun = 'image') =>
  `[${count} ${noun}${count === 1 ? '' : 's'} returned by this tool]`;

// La MISMA nota, reconocida de vuelta. El digest del ledger tiene que contar el adjunto
// una sola vez: segun el camino, la nota llega ya escrita en el cuerpo (Anthropic, y
// OpenAI despues del harvest) o el medio sigue como item del array (OpenAI antes). Sin
// esto la linea del ledger diverge entre rutas y ademas se lee `-> [1 image returned by
// this tool] (1 image)`. Un cuerpo no confiable puede falsificar la linea, pero lo unico
// que consigue es inflar un contador del ledger: no es un marcador de protocolo.
const TOOL_RESULT_MEDIA_NOTE_RE = /^\[(\d+) (?:image|attachment)s? returned by this tool\]$/;

/**
 * Las llamadas ya ejecutadas que viven en la historia, como bloque de texto.
 *
 * Por que existe: medido sobre 192 sesiones reales de Claude Code (15.337 bloques
 * tool_use), 1.451 llamadas eran duplicados entre turnos, y en 526 (36,3%) no habia
 * ninguna otra llamada a la misma herramienta entre la original y la copia — no era
 * confusion de correlacion (eso lo arregla la numeracion de foldToolMessages), era que
 * nada en el prompt desalentaba repetir. Nada en el servidor sabia del pasado tampoco:
 * los tres createToolCallLedger() son por-intento.
 *
 * Esto NO suprime: la decision sigue siendo del modelo, porque repetir es a veces
 * correcto (releer un archivo despues de editarlo). Solo hace visible lo que ya corrio.
 *
 * La numeracion es la MISMA que escribe foldToolMessages (tool-prompt.js): ordinal
 * monotono por request, en orden de llamada, contando cada tool_call de cada mensaje
 * assistant. Si las dos se desincronizan, el ledger dice `#3` y la historia llama `#3`
 * a otra llamada — peor que no numerar. tests/tool-repetition.test.js las clava juntas.
 *
 * @param {Array<Object>} messages - mensajes en forma OpenAI, ANTES de foldToolMessages
 *   (con assistant.tool_calls y role=tool estructurados, no ya convertidos a texto)
 * @param {Object} [options]
 * @param {number} [options.maxEntries=40] - tope de entradas, las mas recientes primero
 * @param {number} [options.maxBytes=6000] - tope duro del bloque completo; compite contra
 *   el umbral de externalizacion de 90 KiB en CADA request. Medido con llamadas realistas
 *   (Read con ruta absoluta + digest lleno) una entrada ASCII pesa ~215 B, asi que el tope
 *   de bytes muerde antes que maxEntries: ~26 entradas y ~6 KB (7% del presupuesto). La
 *   cifra es por BYTES, no por caracteres: con nombres, rutas y resultados en CJK la misma
 *   entrada pesa ~460 B y solo entran ~12. Degrada sin mentir — la nota de omision se
 *   dispara igual — pero la capacidad real se parte a la mitad frente al numero ASCII. Se
 *   conservan las MAS RECIENTES, que son las que el modelo esta a punto de repetir.
 * @returns {string} el bloque, o '' si no hay historia de herramientas
 */
const buildToolHistoryLedger = (messages, { maxEntries = 40, maxBytes = 6000 } = {}) => {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const limit = Number.isFinite(maxEntries) ? Math.max(0, Math.trunc(maxEntries)) : 40;
  if (limit === 0) return '';
  // Sin este guard un maxBytes basura (NaN) hace que toda comparacion sea false y el
  // bloque salga SIN tope — justo lo que no puede pasar en algo que se inyecta siempre.
  const byteCap = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : 6000;

  const byKey = new Map();   // name + canonicalJson(args) -> entrada
  // id de la llamada -> { clave, ordinal DE ESA llamada }. El ordinal va aqui y no en la
  // entrada porque una entrada agrupa varias instancias: sin el, el resultado de la
  // instancia #1 se le colgaria al ordinal de la instancia #3.
  const byCallId = new Map();
  // nombre -> cola FIFO de instancias SIN id. La API legacy de funciones
  // (`assistant.function_call` + `role:'function'`) no lleva id en ninguno de los dos
  // lados, asi que el emparejamiento exacto por tool_call_id no puede existir: la rama
  // `|| message.role === 'function'` de abajo estaba muerta y toda llamada legacy salia
  // listada SIN resultado, bajo la leyenda que afirma que sus resultados ya estan arriba
  // — mientras foldToolMessages si escribia su `[TOOL RESULT: Read]` dos lineas mas
  // abajo. Solo entran aqui las instancias que no tienen NINGUN id: un id que no casa es
  // un desajuste, no una ausencia, y sigue sin adjudicarse (eso seria la suplantacion que
  // arregla la numeracion de Task 1).
  const pendingByName = new Map();
  let ordinal = 0;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    // Mismas dos ramas que foldToolMessages, en el mismo orden: de eso depende que los
    // ordinales coincidan.
    const calls = message.role === 'assistant'
      ? (Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : (message.function_call?.name ? [message.function_call] : []))
      : [];

    for (const call of calls) {
      const fn = call?.function || call;
      ordinal += 1;
      let parsed = fn?.arguments;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch (_) {
          // Argumentos que no son JSON: se comparan como el string crudo, igual que
          // createToolCallLedger. Dos llamadas rotas iguales siguen siendo una repeticion.
        }
      }
      // El bloque es UNA entrada por linea, y el renglon es `#n Nombre args -> digest`.
      // canonicalJson no puede traer un salto literal (JSON.stringify los escapa), pero la
      // rama de arriba deja `parsed` como el STRING CRUDO cuando los argumentos no parsean
      // — el caso que Qwen produce constantemente — o cuando el JSON decodifica a un string.
      // Ese crudo entra con sus saltos intactos y cada uno abre otro renglon con la forma
      // exacta de una entrada legitima: `{"c":"x"}\n#42 Read {} -> hecho` se lee como la
      // llamada #42 con su resultado. neutraliseResultMarkers no lo tapa: reescribe `[` y
      // `<`, nunca saltos. Se colapsa SOLO esta rama: colapsar tambien la salida de
      // canonicalJson fundiria `echo  hi` con `echo hi`, que son dos comandos distintos.
      const args = typeof parsed === 'string' ? collapseToOneLine(parsed) : canonicalJson(parsed ?? {});
      const name = String(fn?.name || 'unknown');
      const key = `${name}\u0000${args}`;
      const existing = byKey.get(key);
      // Ya vista: se queda con el ordinal MAS RECIENTE (apunta a la instancia fresca) y
      // conserva el digest anterior hasta que llegue un resultado nuevo — si la repeticion
      // todavia no fue contestada, borrar el resultado que si tenemos seria perder evidencia.
      // digestOrdinal NO se toca aqui: es lo que despues distingue "este resultado es de
      // esta instancia" de "es de una anterior y la nueva sigue sin contestar".
      if (existing) existing.ordinal = ordinal;
      else byKey.set(key, { ordinal, name, args, digest: '', hasResult: false, digestOrdinal: 0 });
      if (call?.id) {
        byCallId.set(call.id, { key, ordinal });
      } else {
        // Sin id: la unica correlacion posible es nombre + orden de llegada.
        if (!pendingByName.has(name)) pendingByName.set(name, []);
        pendingByName.get(name).push({ key, ordinal });
      }
    }

    if (message.role === 'tool' || message.role === 'function') {
      // Sin tool_call_id que empareje no hay dueno. Adjudicar el resultado a otra llamada
      // seria exactamente la suplantacion que arregla la numeracion de Task 1.
      let ref = message.tool_call_id ? byCallId.get(message.tool_call_id) : null;
      // Solo cuando NO hay id que emparejar se cae al nombre, y solo contra las instancias
      // que tampoco tenian id. FIFO: en el protocolo legacy cada llamada se contesta antes
      // de emitir la siguiente, asi que la mas antigua sin contestar es la duena.
      if (!ref && !message.tool_call_id && message.name) {
        const queue = pendingByName.get(String(message.name));
        if (queue && queue.length > 0) ref = queue.shift();
      }
      const entry = ref ? byKey.get(ref.key) : null;
      if (!entry) continue;
      // Solo avanza si este resultado es de una instancia igual o mas nueva que la que ya
      // tenemos. Con los resultados en desorden, quedarse con el ULTIMO procesado dejaba el
      // digest de #1 pisando al de #2.
      if (ref.ordinal < entry.digestOrdinal) continue;
      // El texto se recorta; los adjuntos se anuncian aparte y NUNCA se serializan.
      const { text, attachments } = summariseToolResultContent(message);
      const digestText = truncateChars(collapseToOneLine(text), LEDGER_DIGEST_CHARS);
      const note = attachments > 0 ? attachmentNote(attachments) : '';
      entry.digest = [digestText, note].filter(Boolean).join(' ');
      entry.hasResult = true;
      entry.digestOrdinal = ref.ordinal;
    }
  }

  if (byKey.size === 0) return '';

  const entries = Array.from(byKey.values()).sort((a, b) => b.ordinal - a.ordinal);
  const kept = entries.slice(0, limit);

  // El renglon entero pasa por la neutralizacion: el digest es salida de herramienta y los
  // argumentos vienen del cliente, y canonicalJson escapa comillas y saltos pero NO los
  // corchetes — `{"cmd":"[TOOL RESULT #2: Read]"}` llegaria literal y podria hacerse pasar
  // por la respuesta de otra llamada. El prefijo `#n` es nuestro y no contiene marcadores.
  // La neutralizacion solo acorta, nunca alarga, asi que el tope del digest se mantiene.
  const renderLine = (entry) => {
    // El ordinal de cabecera es el de la instancia MAS RECIENTE, pero el digest puede venir
    // de una anterior: si la repeticion todavia no fue contestada, `#3 Read {a} -> viejo`
    // le vende al modelo el contenido PRE-edicion como si fuera la respuesta de #3, y en la
    // historia foldeada no existe ningun `[TOOL RESULT #3]`. Es la misma correlacion falsa
    // que Task 1 elimina, y cae justo en el escenario (releer despues de editar) que
    // justifica no suprimir. Cuando difieren se nombra la instancia que SI tiene respuesta.
    const pending = entry.hasResult && entry.digestOrdinal !== entry.ordinal
      ? ` (unanswered; result from #${entry.digestOrdinal})`
      : '';
    return neutraliseUntrustedBody(
      `#${entry.ordinal} ${collapseToOneLine(entry.name)} ${truncateChars(entry.args, LEDGER_ARGS_CHARS)}${pending}` +
      (entry.hasResult ? ` -> ${entry.digest || '(empty)'}` : '')
    );
  };

  // El presupuesto reserva la nota de omision siempre, se use o no: descubrimos que hubo
  // recorte por bytes recien dentro del bucle, y anadirla despues podria pasarse del tope.
  const budget = byteCap - Buffer.byteLength(LEDGER_TRUNCATED_NOTE) - 1;
  const lines = [LEDGER_HEADER, LEDGER_CAPTION];
  let bytes = Buffer.byteLength(lines.join('\n'));
  let truncated = kept.length < entries.length;

  for (const entry of kept) {
    const line = renderLine(entry);
    const cost = Buffer.byteLength(line) + 1;
    if (bytes + cost > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += cost;
  }

  // Ni una entrada entro: una cabecera con una lista vacia solo gasta contexto y miente.
  if (lines.length === 2) return '';
  if (truncated) lines.push(LEDGER_TRUNCATED_NOTE);
  return lines.join('\n');
};

/**
 * 历史里**已经执行过**的工具调用，按调用顺序，用来给登记簿播种。
 *
 * 序号必须与 foldToolMessages（tool-prompt.js）写进历史的 `[TOOL CALL #n]` 逐一对应：
 * 同一套遍历（assistant 的 tool_calls，退回单个 function_call），每个调用 +1。两边一旦
 * 错位，日志里的 #2 就指向模型看到的另一次调用 —— 比不编号更坏。
 * @param {Array<Object>} messages - OpenAI 形状、**折叠之前**的消息（折叠后调用只剩文本）
 * @returns {Array<{name: string, arguments: string, ordinal: number}>}
 */
const extractHistoryToolCalls = (messages) => {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    const calls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : (message.function_call?.name ? [message.function_call] : []);
    for (const call of calls) {
      const fn = call?.function || call;
      const raw = fn?.arguments;
      out.push({
        name: String(fn?.name || 'unknown'),
        // 统一成字符串：登记簿的键对出站调用做 JSON.parse，历史必须走同一条路径才能对上。
        arguments: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}),
        ordinal: out.length + 1
      });
    }
  }
  return out;
};

/** 出站调用与历史种子共用的键：不同的规范化 = 播了也永远匹配不上。 */
const toolCallLedgerKey = (name, rawArgs) => {
  const args = rawArgs || '{}';
  let canonical;
  try {
    canonical = canonicalJson(JSON.parse(args));
  } catch (_) {
    canonical = args;
  }
  return `${name || ''}\u0000${canonical}`;
};

/**
 * 本轮的工具调用登记簿：同名 + 规范 JSON 相同的第二个调用是跨通道的副本（文本解析器
 * 与原生累积器各自都能产出同一个调用），只保留先到的。文本解析器的调用是边收边发的，
 * 收不回来，所以规则只能是操作性的：丢后到的那个。
 *
 * seed = 历史里跑过的调用（extractHistoryToolCalls）。**种下的条目绝不抑制**：三个
 * 登记簿一直都是「按 attempt」的，谁都没比对过入站 messages 里的 tool_use，所以
 * 1.451 次跨回合重复一行日志都没留下。但压制会毁掉合法的重复 —— 编辑完再读一遍同一个
 * 文件是**正确**行为。所以发射判定一个字节都不变，新增的只有告警：名字 + 序号，
 * 永远不带参数负载（tests/tool-prompt.test.js:1503,1774）。
 * @param {Object} [options]
 * @param {Iterable<{name: string, arguments: string, ordinal?: number}>} [options.seed]
 * @returns {((call: Object) => boolean) & { wasInHistory: (call: Object) => boolean }}
 *   true = 本轮首次见到，可以发射
 */
const createToolCallLedger = ({ seed } = {}) => {
  const seen = new Set();
  // key -> 历史序号。只用于报告，永远不进 seen。
  const history = new Map();
  if (seed && typeof seed[Symbol.iterator] === 'function') {
    let index = 0;
    for (const entry of seed) {
      index += 1;
      if (!entry) continue;
      // 同一把调用在历史里出现多次时留**最新**的序号，与 buildToolHistoryLedger 的选择
      // 一致：两处报出来的 #n 必须是同一个，否则日志和模型看到的清单互相矛盾。
      history.set(
        toolCallLedgerKey(entry.name, entry.arguments),
        Number.isFinite(entry.ordinal) ? entry.ordinal : index
      );
    }
  }

  const admit = (call) => {
    const key = toolCallLedgerKey(call?.function?.name, call?.function?.arguments);
    if (seen.has(key)) return false;
    seen.add(key);
    const ordinal = history.get(key);
    if (ordinal !== undefined) {
      logger.warn(
        `Agent 工具调用在历史里已经执行过（${call?.function?.name || 'unknown'}，历史 #${ordinal}）；按设计不抑制，仅记录`,
        'AGENT'
      );
    }
    return true;
  };
  admit.wasInHistory = (call) =>
    history.has(toolCallLedgerKey(call?.function?.name, call?.function?.arguments));
  return admit;
};

/**
 * 文本通道失控信号的告警形态：合成开端被拒（synthetic_rejected），或正文之后的触发器
 * 没过语义门（after prose: …）。其余 triggered_unrecovered（谈论标签、代码围栏、
 * Markdown 链接）不是调用，不算失控。
 */
const isRejectedTextCallWarning = (warning) =>
  warning?.type === 'synthetic_rejected' ||
  (warning?.type === 'triggered_unrecovered' && /^after prose: /.test(String(warning.reason || '')));

/** 一轮里文本通道 tool_use 的上限（config 已钳位 4..256；与 maxAttempts 同样再兜一次底）。 */
const resolveTextToolCallCap = () => {
  const config = require('../config/index.js');
  return Math.min(256, Math.max(4, Number(config.agentTurnMaxToolCalls) || 24));
};

/**
 * 文本通道失控守卫（一轮 attempt 一个；流式 / 非流式共用）。
 *
 * 生产 2026-09-03..06：模型写完一个叙述的 [TOOL_CALL] 之后继续生成 —— 同一调用重复
 * 上百次，或幻想整段 agent 会话（单条回复 245/437/531 个背靠背调用，客户端在 bypass
 * 下全部执行；流长 6-60 分钟）。原生 function_call 批次早有早停（nativeBatchComplete），
 * 文本通道的调用却从不置 stopRequested。这里是它的镜像：本轮**更早的一次 push**（push =
 * 一个上游 delta）已经放行 ≥1 个文本通道调用之后，第一个失控信号就截断回合 ——
 *   (a) duplicate：文本通道同名同参数的第二个调用。只看文本通道自己的登记簿：原生调用
 *       + 它的文本抄本是跨通道去重，由共享登记簿静默丢弃，不是失控信号；
 *   (b) rejected：解析器新增硬错误 / 非空 recoveredText / 合成开端被拒 / 正文之后的
 *       触发器没过语义门；
 *   (c) prose / think：剥掉 agent 标签后仍有非空白正文，或 think phase 的非空白内容；
 *   (d) cap：第 N 个已放行的调用（agentTurnMaxToolCalls）—— 该调用照常交付，之后截断。
 * 武装条件（armed）：本轮**更早的一次 push** 已经放行过 ≥1 个文本通道调用。(a)/(b)/(c)
 * 只在武装后判定 —— 与完成调用同一 push 里的文本是调用之前的散文，照常交付；背靠背
 * 调用之间纯空白的 textDelta 永不触发。(d) 不设武装门：第 N 个已放行的调用就是第 N 个，
 * 与 push 边界无关（一个 delta 里挤着 30 个完整调用同样只交付 N 个）。截断之后守卫不再
 * 产生规则 —— 同一 push 里剩下的已登记调用仍由调用方发射（cap 除外：调用方在第 N 个
 * 之后立刻停手）。
 */
const createTextChannelRunawayGuard = ({ parser, maxToolCalls, label, tag }) => {
  const admitTextCall = createToolCallLedger();
  let admittedInPriorPush = false;
  let admittedCount = 0;
  let errorsSeen = 0;
  let warningsSeen = 0;
  let cutRule = null;

  /** 正文 push 之后立刻调用（同时推进错误/告警游标）：规则 (b)/(c)，返回规则名或 null。 */
  const inspectPush = (parsed, strippedText) => {
    const errors = parser.getErrors().length;
    const warnings = parser.getWarnings();
    const rejected = errors > errorsSeen || !!parsed.recoveredText ||
      warnings.slice(warningsSeen).some(isRejectedTextCallWarning);
    errorsSeen = errors;
    warningsSeen = warnings.length;
    if (cutRule || !admittedInPriorPush) return null;
    if (rejected) return 'rejected';
    if (/\S/.test(strippedText)) return 'prose';
    return null;
  };

  /**
   * 每个完成的文本通道调用：先过文本登记簿；首次见到的交给 emit（返回 false = 共享
   * 登记簿判为跨通道副本，没上线也不计数）。返回规则 (a)/(d) 或 null。
   */
  const inspectCall = (call, emit) => {
    // El cap manda TAMBIEN mientras se drena el push que disparo un corte por otra regla.
    // Tras un corte esta funcion deja de devolver reglas (incluida 'cap') —— ver el `return
    // null` de mas abajo —— asi que sin este tope las llamadas restantes de ese mismo push
    // se admitian y emitian todas: un solo delta con 40 llamadas mas entregaba 41 contra un
    // cap de 24. En la rama de streaming de Anthropic `emitToolUse` escribe el bloque
    // tool_use en el cable al instante, asi que ese exceso es irrecuperable.
    //
    // Va ANTES del registro (no se toca el ledger) y esta condicionado a `cutRule`, asi que
    // no puede alterar el camino sin corte: ahi `inspectCall` devuelve 'cap' exactamente al
    // llegar al tope y todos los llamadores hacen `break`, de modo que nunca se vuelve a
    // entrar con admittedCount >= maxToolCalls. El unico modo de pasarse del cap era este.
    if (cutRule && admittedCount >= maxToolCalls) return null;
    if (!admitTextCall(call)) {
      logger.warn(
        `${label} 本轮文本通道重复的工具调用（${call.function.name}，同名同参数），丢弃后到的副本`,
        tag
      );
      return cutRule || !admittedInPriorPush ? null : 'duplicate';
    }
    const emitted = emit(call);
    if (emitted) admittedCount += 1;
    if (cutRule) return null;
    // cap 不设武装门：第 N 个就是第 N 个，与 push 边界无关。
    return emitted && admittedCount >= maxToolCalls ? 'cap' : null;
  };

  /** think phase 的一帧：规则 (c) 的思考形态。 */
  const inspectThink = (content) =>
    (!cutRule && admittedInPriorPush && /\S/.test(content || '')) ? 'think' : null;

  /** 一个 push 收尾：此后已放行的调用算"更早的 push"。 */
  const endPush = () => {
    if (admittedCount > 0) admittedInPriorPush = true;
  };

  /** 记录截断规则；每次截断恰好一行告警，点名规则。 */
  const cut = (rule) => {
    cutRule = rule;
    // 分母只对 cap 有意义；其余规则只报数（"31/24" 读起来像 bug）。
    const tally = rule === 'cap' ? `${admittedCount}/${maxToolCalls}` : `${admittedCount}`;
    logger.warn(
      `${label} 文本通道 tool_use 之后出现失控信号 (${rule})，提前终止上游（本轮已放行 ${tally} 个文本通道调用，用量按本地估算）`,
      tag
    );
  };

  return {
    inspectPush,
    inspectCall,
    inspectThink,
    endPush,
    cut,
    cutRule: () => cutRule,
    /** 已武装 = 更早的 push 放行过文本通道调用。 */
    armed: () => admittedInPriorPush
  };
};

module.exports = {
  AGENT_FINAL_OPEN,
  AGENT_FINAL_CLOSE,
  AGENT_BLOCKED_OPEN,
  AGENT_BLOCKED_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  parseAgentControlText,
  createAgentControlStreamParser,
  createAgentTagStripper,
  stripAgentTags,
  buildAgentTurnDirective,
  buildAgentRetryHint,
  // Guarda de fuga del canal de texto — compartida por anthropic.js y openai-agent-runtime.js.
  canonicalJson,
  // Neutralizacion de marcadores: fuente unica para foldToolMessages (tool-prompt.js) y
  // para el ledger de aqui. Todo texto no confiable que vuelve al prompt pasa por ella.
  neutraliseResultMarkers,
  // El brazo THINKING de la regla de arriba, suelto: el emisor del delimitador
  // (controllers/anthropic.js) tiene que poder defusar el texto HERMANO del mismo
  // mensaje sin pasarlo por el resto de la neutralizacion, que es para otro canal.
  defuseThinkingMarkers,
  neutraliseUntrustedBody,
  // Cortar por unidades UTF-16 parte pares subrogados. Exportado porque el tope de
  // razonamiento de anthropic.js corta igual que el digest del ledger de aqui.
  trimLoneSurrogates,
  buildToolHistoryLedger,
  // El cuerpo del resultado cuando la herramienta devolvio medios. Lo usan los DOS
  // caminos (controllers/anthropic.js#flattenAnthropicMessages y
  // utils/chat-helpers.js#harvestCurrentTurnMedia) para no divergir en el texto.
  toolResultMediaNote,
  extractHistoryToolCalls,
  createToolCallLedger,
  isRejectedTextCallWarning,
  resolveTextToolCallCap,
  createTextChannelRunawayGuard
}
