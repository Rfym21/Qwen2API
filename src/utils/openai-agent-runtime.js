const { isJson } = require('./tools.js')
const {
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator
} = require('./tool-prompt.js')
const { consumeSSEStream, createUpstreamResponseFilter } = require('./sse.js')
const { createUpstreamDeltaNormalizer } = require('./chat-helpers.js')
const { assertNoUpstreamFailure } = require('./upstream-error.js')
const {
  parseAgentControlText,
  createAgentControlStreamParser,
  buildAgentRetryHint
} = require('./agent-turn.js')
const config = require('../config/index.js')
const { logger } = require('./logger.js')

const NON_RETRYABLE_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'content_filter',
  'refusal'
])

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
 * 完整消费一次 Qwen 上游 attempt。裸正文与工具调用始终留在门禁内；调用方可
 * 实时接收安全思考，以及已经进入 final/blocked 包装体的正式正文增量。
 * 每次调用都新建 parser/filter/accumulator，失败 attempt 不会污染下一次。
 */
const collectOpenAIAgentAttempt = async (upstreamResponse, options = {}) => {
  const hasTools = options.has_tools !== false
  const allowedToolNames = options.allowed_tool_names || []
  const normalizeDelta = createUpstreamDeltaNormalizer()
  const acceptUpstreamFrame = createUpstreamResponseFilter()
  const nativeTools = hasTools
    ? createNativeToolCallAccumulator({ allowedToolNames })
    : null
  const reasoningStreamParser = typeof options.on_reasoning_delta === 'function'
    ? createToolCallStreamParser({ allowedToolNames })
    : null
  const controlStreamParser = typeof options.on_content_delta === 'function'
    ? createAgentControlStreamParser()
    : null
  const controlToolStreamParser = controlStreamParser
    ? createToolCallStreamParser({ allowedToolNames })
    : null
  let streamedVisibleText = ''
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
    }
    if (result.closed && !controlToolParserFlushed) {
      controlToolParserFlushed = true
      const parsed = controlToolStreamParser.flush()
      await emitContentDelta(parsed.textDelta, result.kind)
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
    if (nativeTools && Array.isArray(delta.tool_calls)) {
      nativeTools.push(delta.tool_calls)
    } else if (nativeTools && delta.function_call) {
      nativeTools.push([{
        index: 0,
        type: 'function',
        function: delta.function_call
      }])
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
    if (normalized.phase === 'think') {
      reasoning += normalized.content
      if (reasoningStreamParser) {
        const streamed = reasoningStreamParser.push(normalized.content)
        await emitReasoningDelta(streamed.textDelta)
      }
      return
    }

    answerStarted = true
    if (pendingImages.length > 0) {
      await appendAnswer(`${pendingImages.join('\n\n')}\n\n`)
      pendingImages.forEach(item => emittedImages.add(item))
      pendingImages.length = 0
    }
    await appendAnswer(normalized.content)
  })

  if (reasoningStreamParser) {
    const streamed = reasoningStreamParser.flush()
    await emitReasoningDelta(streamed.textDelta)
  }
  if (controlStreamParser) {
    await consumeControlStreamResult(controlStreamParser.flush())
  }

  const textTools = hasTools
    ? parseToolCallsFromText(answer, { allowedToolNames })
    : { cleanedText: answer, toolCalls: [], errors: [] }
  const reasoningTools = hasTools && textTools.toolCalls.length === 0 && !textTools.cleanedText.trim()
    ? parseToolCallsFromText(reasoning, { allowedToolNames })
    : { cleanedText: reasoning, toolCalls: [], errors: [] }
  const nativeToolCalls = nativeTools?.hasAny() ? nativeTools.finalize() : []
  // 部分 thinking 模型会把“整个可执行工具块”放进 think phase 后直接 EOF。
  // 仅当 thinking 除独立工具块外没有任何文字时才接纳，避免把推理中的示例或
  // 尚未决定执行的调用当成真实动作。
  const standaloneReasoningCalls = reasoningTools.toolCalls.length > 0 &&
    !reasoningTools.cleanedText.trim() &&
    reasoningTools.errors.length === 0
    ? reasoningTools.toolCalls
    : []
  const toolCalls = nativeToolCalls.length > 0
    ? nativeToolCalls
    : (textTools.toolCalls.length > 0 ? textTools.toolCalls : standaloneReasoningCalls)
  const toolErrors = [
    ...(textTools.errors || []),
    ...(textTools.toolCalls.length === 0 && !textTools.cleanedText.trim()
      ? (reasoningTools.errors || [])
      : []),
    ...(nativeTools?.getErrors?.() || [])
  ]
  const control = parseAgentControlText(textTools.cleanedText)
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
    streamedVisibleText,
    streamedControlKind,
    streamedControlState: controlStreamParser?.getState?.() || null,
    toolCalls,
    toolErrors,
    webSearchInfo,
    totalTokens,
    upstreamFinishReason,
    upstreamCompleted: streamResult.completed,
    upstreamEventCount: streamResult.eventCount,
    sawDone: streamResult.sawDone,
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
  if (attempt.toolErrors.length > 0) {
    return { accepted: false, finishReason: null, retryReason: 'invalid_tool_call' }
  }
  if (attempt.toolCalls.length > 0) {
    if (!config.agentTurnAllowProseWithTools &&
        (attempt.controlKind !== 'empty' || attempt.visibleText.trim())) {
      return { accepted: false, finishReason: null, retryReason: 'invalid_tool_call' }
    }
    return { accepted: true, finishReason: 'tool_calls', retryReason: null }
  }
  if (requiresToolCall(options.tool_choice)) {
    return { accepted: false, finishReason: null, retryReason: 'required_tool' }
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
    required_tool: '上游连续违反 tool_choice，未返回要求的工具调用'
  }
  return {
    status: 429,
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
    const evaluation = evaluateOpenAIAgentAttempt(attempt, options)
    lastAttempt = attempt
    lastEvaluation = evaluation
    upstreamContext = mergePresent(upstreamContext, attempt.metadata)

    if (evaluation.accepted) {
      return {
        ok: true,
        attempt,
        finishReason: evaluation.finishReason,
        attempts: attemptNumber
      }
    }

    logger.warn(
      `Agent attempt ${attemptNumber}/${maxAttempts} 被回合门禁拒绝 (${evaluation.retryReason})`,
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

    const retryBody = appendRetryHint(
      retryBaseBody,
      buildAgentRetryHint(evaluation.retryReason)
    )
    const retryResponse = await requestSender(retryBody, {
      chatId: upstreamContext.chatId || null,
      parentId: upstreamContext.responseId || null,
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
  runOpenAIAgentTurn
}
