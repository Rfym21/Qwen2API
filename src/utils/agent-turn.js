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
    'Never use the completion wrapper merely because one tool call finished. If verification has not run or any requested work remains, call the next tool.'
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

/**
 * 本轮的工具调用登记簿：同名 + 规范 JSON 相同的第二个调用是跨通道的副本（文本解析器
 * 与原生累积器各自都能产出同一个调用），只保留先到的。文本解析器的调用是边收边发的，
 * 收不回来，所以规则只能是操作性的：丢后到的那个。
 * @returns {(call: Object) => boolean} true = 首次见到，可以发射
 */
const createToolCallLedger = () => {
  const seen = new Set();
  return (call) => {
    const args = call?.function?.arguments || '{}';
    let canonical;
    try {
      canonical = canonicalJson(JSON.parse(args));
    } catch (_) {
      canonical = args;
    }
    const key = `${call?.function?.name || ''}\u0000${canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
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
  createToolCallLedger,
  isRejectedTextCallWarning,
  resolveTextToolCallCap,
  createTextChannelRunawayGuard
}
