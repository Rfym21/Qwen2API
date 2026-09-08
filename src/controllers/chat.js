const { isJson, generateUUID } = require('../utils/tools.js')
const { createUsageObject } = require('../utils/precise-tokenizer.js')
const { sendChatRequest } = require('../utils/request.js')
const {
    createToolCallStreamParser,
    parseToolCallsFromText,
    createNativeToolCallAccumulator,
    looksLikeUnexecutedToolAction,
    stripToolCallResidue,
    TOOL_CALL_OPEN,
    TOOL_CALL_CLOSE
} = require('../utils/tool-prompt.js')
const { consumeSSEStream, createUpstreamResponseFilter } = require('../utils/sse.js')
const accountManager = require('../utils/account.js')
const config = require('../config/index.js')
const { logger } = require('../utils/logger')
const { createUpstreamDeltaNormalizer, createClientToolNamePredicate } = require('../utils/chat-helpers.js')
const { assertNoUpstreamFailure } = require('../utils/upstream-error.js')
const { runOpenAIAgentTurn, feedNativeFrame } = require('../utils/openai-agent-runtime.js')

const normalizeOpenAIFinishReason = (upstreamReason, hasToolCalls, upstreamCompleted) => {
    if (hasToolCalls) return 'tool_calls'
    if (typeof upstreamReason === 'string' && upstreamReason.length > 0) {
        const aliases = {
            end_turn: 'stop',
            max_tokens: 'length',
            tool_use: 'tool_calls'
        }
        const normalized = aliases[upstreamReason] || upstreamReason
        const supported = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call'])
        return supported.has(normalized) ? normalized : null
    }
    return upstreamCompleted ? 'stop' : null
}

const writeOpenAIStreamError = (res, message, code = 'upstream_incomplete') => {
    res.write(`data: ${JSON.stringify({
        error: {
            message,
            type: 'upstream_stream_error',
            code
        }
    })}\n\n`)
    res.write('data: [DONE]\n\n')
    if (typeof res.flush === 'function') res.flush()
    res.end()
}

/**
 * 设置响应头
 * @param {object} res - Express 响应对象
 * @param {boolean} stream - 是否流式响应
 */
const setResponseHeaders = (res, stream) => {
    try {
        if (stream) {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            })
        } else {
            res.set({
                'Content-Type': 'application/json',
            })
        }
    } catch (e) {
        logger.error('处理聊天请求时发生错误', 'CHAT', '', e)
    }
}

const getImageMarkdownListFromDelta = (delta) => {
    // 常规聊天在触发 image_gen_tool 时，仅使用 image_list 中用于展示的图片链接
    const imageList = []
    const displayImages = delta?.extra?.image_list || []

    for (const item of displayImages) {
        if (item?.image) {
            imageList.push(`![image](${item.image})`)
        }
    }

    return imageList
}

/**
 * 判断 tool_choice 是否要求强制调用工具
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {boolean} 是否需要至少一次工具调用
 */
const requiresToolCall = (toolChoice) => {
    if (toolChoice === 'required') return true
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
        return true
    }
    return false
}

/**
 * 构建 tool_choice=required 重试时追加的强约束提示
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {string} 重试提示词
 */
const buildRequiredRetryHint = (toolChoice) => {
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
        return `You did not call any tool in your previous reply. You MUST now call the tool \`${toolChoice.function.name}\` using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format and nothing else.`
    }
    return `You did not call any tool in your previous reply. You MUST now call exactly one tool using the ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} format and nothing else.`
}

const buildEmptyOutputRetryHint = () => [
    'Your previous reply produced no visible final answer or executable tool call.',
    `Continue the Agent task now. If any action remains, emit the required \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
    'Only give a normal final answer when the task is actually complete; do not repeat hidden reasoning.'
].join(' ')

const buildMissingToolRetryHint = () => [
    'Your previous reply described an action but did not execute any tool call.',
    `Perform that action now by emitting the real \`${TOOL_CALL_OPEN}\` block immediately with no preamble.`,
    'Do not describe the action again or claim completion without a tool result.'
].join(' ')

const appendRetryHintToRequestBody = (requestBody, hint) => {
    const messages = Array.isArray(requestBody?.messages)
        ? requestBody.messages.map(message => ({ ...message }))
        : []
    if (messages.length === 0) {
        messages.push({ role: 'user', content: hint })
    } else {
        const last = messages[messages.length - 1]
        if (typeof last.content === 'string') {
            last.content = `${last.content}\n\n# Tool-call retry\n${hint}`
        } else if (Array.isArray(last.content)) {
            const textPart = last.content.find(part => part?.type === 'text')
            if (textPart) {
                textPart.text = `${textPart.text || ''}\n\n# Tool-call retry\n${hint}`
            } else {
                last.content = [{ type: 'text', text: hint }, ...last.content]
            }
        }
    }
    return { ...requestBody, messages }
}

/**
 * 处理流式响应
 * @param {object} res - Express 响应对象
 * @param {object} response - 上游响应流
 * @param {boolean} enable_thinking - 是否启用思考模式
 * @param {boolean} enable_web_search - 是否启用网络搜索
 * @param {object} requestBody - 原始请求体，用于提取prompt信息
 * @param {object} [options] - 扩展选项
 * @param {boolean} [options.has_tools] - 是否启用工具调用解析
 * @param {string|Object} [options.tool_choice] - OpenAI tool_choice 控制项
 */
/**
 * 安全累计 stats——任何异常都吞掉，不影响响应给客户端
 * @param {Object} account - 当前账户对象（含 email）
 * @param {Object} usage - { prompt_tokens, completion_tokens }
 */
const attributeChatUsage = (account, usage) => {
    if (!account || !account.email || !usage) return
    try {
        accountManager.accumulateStats(account.email, 'chat', {
            input: Number(usage.prompt_tokens) || 0,
            output: Number(usage.completion_tokens) || 0
        })
    } catch (e) {
        // 静默——stats 累计失败不应中断响应
    }
}

const writeOpenAIHttpError = (res, error = {}) => {
    const status = Number(error.status) || 502
    const message = error.message || '上游未能生成有效响应'
    const code = error.code || 'upstream_error'
    if (res.headersSent) {
        if (!res.writableEnded) writeOpenAIStreamError(res, message, code)
        return
    }
    res.status(status)
    res.set({ 'Content-Type': 'application/json' })
    res.json({
        error: {
            message,
            type: status === 429 ? 'rate_limit_error' : 'upstream_error',
            code
        }
    })
}

const runWithProcessingHeartbeat = async (res, work, intervalMs = 15000) => {
    if (typeof res?.writeProcessing !== 'function') return work()
    const heartbeatMs = Math.max(1, Number(intervalMs) || 15000)
    const heartbeat = setInterval(() => {
        if (res.headersSent || res.writableEnded || res.destroyed) return
        try {
            // 102 是临时响应，不会提交最终状态码/响应头。这样既能保持长 thinking
            // 连接活跃，又能在门禁耗尽时返回真正的 HTTP 429/503。
            res.writeProcessing()
        } catch (_) {
            // 某些 HTTP/2/反代适配器不实现临时响应；跳过即可，不能改发 SSE 注释。
        }
    }, heartbeatMs)
    heartbeat.unref?.()
    try {
        return await work()
    } finally {
        clearInterval(heartbeat)
    }
}

const runWithSSEHeartbeat = async (res, work, intervalMs = 15000) => {
    const heartbeatMs = Math.max(1, Number(intervalMs) || 15000)
    const heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return
        try {
            // SSE 已经提交 200 响应后，用注释帧保活。注释不会进入 OpenAI delta，
            // 但能阻止反代在长 thinking 或纠正 attempt 期间把连接判为空闲。
            res.write(': qwen2api-agent-keepalive\n\n')
            if (typeof res.flush === 'function') res.flush()
        } catch (_) {
            // 客户端断开会由后续流消费/写入路径统一收敛。
        }
    }, heartbeatMs)
    heartbeat.unref?.()
    try {
        return await work()
    } finally {
        clearInterval(heartbeat)
    }
}

const normalizeAgentUsage = (attempt, requestBody, completionText) => {
    let usage = { ...(attempt?.totalTokens || {}) }
    if (!usage.prompt_tokens && !usage.completion_tokens) {
        usage = createUsageObject(requestBody?.messages || [], completionText, null)
    }
    usage.prompt_tokens = Math.max(0, Number(usage.prompt_tokens) || 0)
    usage.completion_tokens = Math.max(0, Number(usage.completion_tokens) || 0)
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
    return usage
}

/**
 * Residuo de protocolo que TODAVÍA se puede pelar en la entrega.
 *
 * Lo que ya salió en vivo por el canal de contenido es irrecuperable, y borrarlo del buffer
 * rompería el descuento de handleOpenAIAgentStream (`bufferedContent.startsWith(...)`) y lo
 * duplicaría en el cliente: un residuo entregado una vez es mejor que la respuesta entera
 * entregada dos. Hoy ninguna ronda aceptada llega aquí con texto ya emitido y residuo a la
 * vez (el gate 422 corta antes), así que este filtro es defensa, no un camino vivo.
 */
const deliverableResidueSpans = (attempt, alreadyStreamed = 0) =>
    (attempt?.residueSpans || []).filter(span =>
        span && typeof span.text === 'string' && Number.isInteger(span.at) && span.at >= alreadyStreamed)

const prepareAgentOutput = async (attempt, enableThinking, enableWebSearch, { suppressVisibleText = false, residueSpans = null } = {}) => {
    let reasoning = String(attempt?.reasoning || '')
    // 工具调用旁的正文照常交付（OpenAI 允许 content 与 tool_calls 并存）：严格门禁下文本
    // 通道的调用到这里 visibleText 必为空白；原生晋升的回合带着调用前的正文过来 —— 除非
    // 门禁判定那段正文混着写坏的文本 [TOOL CALL]（suppressVisibleText），那就一个字节不发。
    //
    // 交付层剥残渣（与 anthropic.js:1501/:2164 同一层）：解析器**当场登记**的协议残渣按
    // 位置剥掉，绝不搜索 —— 围栏里引用同一个标记的文档不带 span，原样交付。检测输入
    // （attempt.visibleText）从未被碰过：malformed_protocol 重试仍照旧点火。
    const visibleText = suppressVisibleText
        ? ''
        : stripToolCallResidue(
            String(attempt?.visibleText || ''),
            residueSpans || deliverableResidueSpans(attempt)
        )
    let content = attempt?.toolCalls?.length > 0 && !visibleText.trim() ? '' : visibleText

    if (attempt?.webSearchInfo) {
        const table = await accountManager.generateMarkdownTable(attempt.webSearchInfo, config.searchInfoMode)
        if (enableThinking && reasoning) reasoning = `${table}\n\n${reasoning}`
        else if (enableWebSearch && config.searchInfoMode === 'text') {
            content = `${content}${content ? '\n\n' : ''}---\n${table}`
        }
    }

    if (config.legacyReasoningInContent && reasoning) {
        content = `<think>\n\n${reasoning}\n\n</think>${content ? `\n${content}` : ''}`
        reasoning = ''
    }
    return { reasoning, content }
}

const handleOpenAIAgentStream = async (
    res,
    response,
    enableThinking,
    enableWebSearch,
    requestBody,
    options
) => {
    setResponseHeaders(res, true)
    const messageId = generateUUID()
    const created = Math.round(Date.now() / 1000)
    let firstDelta = true
    const writeDelta = (delta) => {
        if (!delta || Object.keys(delta).length === 0) return
        const normalizedDelta = firstDelta ? { role: 'assistant', ...delta } : delta
        firstDelta = false
        res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${messageId}`,
            object: 'chat.completion.chunk',
            created,
            choices: [{ index: 0, delta: normalizedDelta, finish_reason: null }]
        })}\n\n`)
        if (typeof res.flush === 'function') res.flush()
    }

    // 立即提交标准 SSE 首帧，不能等整个上游 attempt 收完后才让客户端看到响应。
    // 裸正文/工具调用仍由下方门禁缓冲；安全思考与已确认进入 final/blocked
    // 包装体的正式正文会按上游节奏增量输出。
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    writeDelta({ role: 'assistant' })

    const liveReasoningByAttempt = new Map()
    const onReasoningDelta = enableThinking && !config.legacyReasoningInContent
        ? async (text, metadata = {}) => {
            const attemptNumber = Math.max(1, Number(metadata.attemptNumber) || 1)
            if (!liveReasoningByAttempt.has(attemptNumber)) {
                liveReasoningByAttempt.set(attemptNumber, '')
            }
            if (text) {
                liveReasoningByAttempt.set(
                    attemptNumber,
                    `${liveReasoningByAttempt.get(attemptNumber)}${text}`
                )
                writeDelta({ reasoning_content: text })
            }
        }
        : null
    const onContentDelta = !config.legacyReasoningInContent
        ? async (text) => {
            if (text) writeDelta({ content: text })
        }
        : null

    let runtime
    try {
        runtime = await runWithSSEHeartbeat(
            res,
            () => runOpenAIAgentTurn(response, {
                ...options,
                requestBody,
                sendChatRequest: options.sendChatRequest || sendChatRequest,
                on_reasoning_delta: onReasoningDelta,
                on_content_delta: onContentDelta
            }),
            options.agent_processing_heartbeat_ms
        )
    } catch (error) {
        logger.error('OpenAI Agent 回合处理失败', 'AGENT', '', error)
        writeOpenAIHttpError(res, {
            status: 502,
            message: error.publicMessage || '上游 Agent 回合处理失败',
            code: error.code || 'upstream_stream_error'
        })
        return
    }
    if (!runtime.ok) {
        writeOpenAIHttpError(res, runtime.error)
        return
    }

    const { attempt, finishReason, suppressVisibleText } = runtime
    const streamedVisibleText = String(attempt.streamedVisibleText || '')
    // Un único juego de spans para el contenido y para el descuento de abajo: si se pelara
    // el buffer contra un `acceptedVisibleText` sin pelar, el `startsWith` fallaría y el
    // turno entero se reenviaría detrás de lo ya emitido.
    const residueSpans = deliverableResidueSpans(attempt, streamedVisibleText.length)
    const output = await prepareAgentOutput(attempt, enableThinking, enableWebSearch, { suppressVisibleText, residueSpans })
    let bufferedReasoning = output.reasoning
    const acceptedReasoningWasStreamed = liveReasoningByAttempt.has(runtime.attempts)
    const rawAcceptedReasoning = String(attempt.reasoning || '')
    if (acceptedReasoningWasStreamed && rawAcceptedReasoning && bufferedReasoning.endsWith(rawAcceptedReasoning)) {
        // 已实时发送的安全思考不能在门禁通过后再重复回放。若前面附加了搜索表格，
        // 只补发这一段派生前缀。
        bufferedReasoning = bufferedReasoning.slice(0, -rawAcceptedReasoning.length)
    }

    let bufferedContent = output.content
    const acceptedVisibleText = stripToolCallResidue(String(attempt.visibleText || ''), residueSpans)
    if (
        streamedVisibleText &&
        acceptedVisibleText.startsWith(streamedVisibleText) &&
        bufferedContent.startsWith(acceptedVisibleText)
    ) {
        // 正式回复的包装体已经按上游节奏实时发送，只补发极少数尚未发送的尾部，
        // 以及门禁通过后追加的搜索信息等派生内容。
        bufferedContent = `${acceptedVisibleText.slice(streamedVisibleText.length)}${bufferedContent.slice(acceptedVisibleText.length)}`
    } else if (streamedVisibleText && finishReason !== 'stop' && attempt.streamedControlState?.opened) {
        // length/content_filter 等中止发生在包装闭合前时，不能把带控制标签的原始
        // 缓冲再次作为正文回放；已发送的安全正文由对应 finish_reason 正常收尾。
        bufferedContent = ''
    }

    if (bufferedReasoning) writeDelta({ reasoning_content: bufferedReasoning })
    if (bufferedContent) writeDelta({ content: bufferedContent })

    const ARG_CHUNK_SIZE = 32
    for (const call of attempt.toolCalls || []) {
        writeDelta({
            tool_calls: [{
                index: call.index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: '' }
            }]
        })
        const args = call.function.arguments || '{}'
        for (let offset = 0; offset < args.length; offset += ARG_CHUNK_SIZE) {
            writeDelta({
                tool_calls: [{
                    index: call.index,
                    function: { arguments: args.slice(offset, offset + ARG_CHUNK_SIZE) }
                }]
            })
        }
    }
    const completionText = `${output.reasoning}${output.content}${JSON.stringify(attempt.toolCalls || [])}`
    const usage = normalizeAgentUsage(attempt, requestBody, completionText)
    attributeChatUsage(options.currentAccount, usage)
    res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${messageId}`,
        object: 'chat.completion.chunk',
        created,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    })}\n\n`)
    res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${messageId}`,
        object: 'chat.completion.chunk',
        created,
        choices: [],
        usage
    })}\n\n`)
    res.write('data: [DONE]\n\n')
    if (typeof res.flush === 'function') res.flush()
    res.end()
}

const handleOpenAIAgentNonStream = async (
    res,
    response,
    enableThinking,
    enableWebSearch,
    model,
    requestBody,
    options
) => {
    let runtime
    try {
        runtime = await runWithProcessingHeartbeat(
            res,
            () => runOpenAIAgentTurn(response, {
                ...options,
                requestBody,
                sendChatRequest: options.sendChatRequest || sendChatRequest
            }),
            options.agent_processing_heartbeat_ms
        )
    } catch (error) {
        logger.error('OpenAI 非流式 Agent 回合处理失败', 'AGENT', '', error)
        writeOpenAIHttpError(res, {
            status: 502,
            message: error.publicMessage || '上游 Agent 回合处理失败',
            code: error.code || 'upstream_error'
        })
        return
    }
    if (!runtime.ok) {
        writeOpenAIHttpError(res, runtime.error)
        return
    }

    setResponseHeaders(res, false)
    const { attempt, finishReason, suppressVisibleText } = runtime
    const output = await prepareAgentOutput(attempt, enableThinking, enableWebSearch, { suppressVisibleText })
    const assistantMessage = {
        role: 'assistant',
        content: output.content || (attempt.toolCalls.length > 0 ? null : '')
    }
    if (output.reasoning) assistantMessage.reasoning_content = output.reasoning
    if (attempt.toolCalls.length > 0) {
        assistantMessage.tool_calls = attempt.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { ...call.function }
        }))
    }
    const completionText = `${output.reasoning}${output.content}${JSON.stringify(attempt.toolCalls || [])}`
    const usage = normalizeAgentUsage(attempt, requestBody, completionText)
    attributeChatUsage(options.currentAccount, usage)
    res.json({
        id: `chatcmpl-${generateUUID()}`,
        object: 'chat.completion',
        created: Math.round(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
        usage
    })
}

const handleStreamResponse = async (res, response, enable_thinking, enable_web_search, requestBody = null, options = {}) => {
    if (options.has_tools && options.strict_agent_turn !== false) {
        return handleOpenAIAgentStream(
            res,
            response,
            enable_thinking,
            enable_web_search,
            requestBody,
            options
        )
    }
    try {
        const message_id = generateUUID()
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        const normalizeDelta = createUpstreamDeltaNormalizer()
        const acceptUpstreamFrame = createUpstreamResponseFilter()
        let emittedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const requestSender = options.sendChatRequest || sendChatRequest
        const toolChoice = options.tool_choice
        const allowedToolNames = options.allowed_tool_names || []
        const isClientToolName = createClientToolNamePredicate(allowedToolNames)
        let toolParser = hasTools ? createToolCallStreamParser({ allowedToolNames }) : null
        let nativeToolAccumulator = hasTools
            ? createNativeToolCallAccumulator({ allowedToolNames })
            : null
        // 调用方持有唯一的单调 index：文本解析器与原生累积器各自从 0 计数，直接透传会让
        // 两路都写 tool_calls[0]。
        let nextToolCallIndex = 0
        let upstreamFinishReason = null
        let upstreamCompleted = false
        let upstreamEventCount = 0

        // Token消耗量统计
        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
        let completionContent = '' // 收集完整的回复内容用于token估算
        let visibleContent = ''

        // 提取prompt文本用于token估算
        let promptText = ''
        if (requestBody && requestBody.messages) {
            promptText = requestBody.messages.map(msg => {
                if (typeof msg.content === 'string') {
                    return msg.content
                } else if (Array.isArray(msg.content)) {
                    return msg.content.map(item => item.text || '').join('')
                }
                return ''
            }).join('\n')
        }

        /**
         * 写一个标准 OpenAI 文本增量
         * @param {string} text - 文本内容
         */
        const writeContentDelta = (text) => {
            if (!text) return
            visibleContent += text
            res.write(`data: ${JSON.stringify({
                "id": `chatcmpl-${message_id}`,
                "object": "chat.completion.chunk",
                "created": Math.round(new Date().getTime() / 1000),
                "choices": [
                    {
                        "index": 0,
                        "delta": { "content": text },
                        "finish_reason": null
                    }
                ]
            })}\n\n`)
        }

        /**
         * 写一个推理增量（DeepSeek-R1 风格 reasoning_content 字段）
         * @param {string} text - 推理文本
         */
        const writeReasoningDelta = (text) => {
            if (!text) return
            res.write(`data: ${JSON.stringify({
                "id": `chatcmpl-${message_id}`,
                "object": "chat.completion.chunk",
                "created": Math.round(new Date().getTime() / 1000),
                "choices": [
                    {
                        "index": 0,
                        "delta": { "reasoning_content": text },
                        "finish_reason": null
                    }
                ]
            })}\n\n`)
        }

        /**
         * 发送回复正文增量：有工具解析器则先过解析，否则直接写 content
         * @param {string} text - 回复正文文本
         */
        const emitAnswerContent = (text) => {
            if (!text) return
            if (toolParser) {
                const parsed = toolParser.push(text)
                if (parsed.textDelta) writeContentDelta(parsed.textDelta)
                if (parsed.completedCalls.length > 0) writeToolCallsDelta(parsed.completedCalls)
            } else {
                writeContentDelta(text)
            }
        }

        /**
         * 写一个工具调用增量，按 OpenAI 规范分片：
         *   1) 头块：包含 index/id/type 与 function.name + 空 arguments
         *   2) 多个参数块：function.arguments 切片
         * @param {Array<Object>} calls - 已完成的工具调用列表
         */
        const writeToolCallsDelta = (calls) => {
            if (!calls || calls.length === 0) return
            const ARG_CHUNK_SIZE = 32

            for (const call of calls) {
                const index = nextToolCallIndex++
                const headerDelta = {
                    "id": `chatcmpl-${message_id}`,
                    "object": "chat.completion.chunk",
                    "created": Math.round(new Date().getTime() / 1000),
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": index,
                                        "id": call.id,
                                        "type": "function",
                                        "function": {
                                            "name": call.function.name,
                                            "arguments": ""
                                        }
                                    }
                                ]
                            },
                            "finish_reason": null
                        }
                    ]
                }
                res.write(`data: ${JSON.stringify(headerDelta)}\n\n`)

                const argsString = call.function.arguments || ''
                for (let offset = 0; offset < argsString.length; offset += ARG_CHUNK_SIZE) {
                    const piece = argsString.slice(offset, offset + ARG_CHUNK_SIZE)
                    const argDelta = {
                        "id": `chatcmpl-${message_id}`,
                        "object": "chat.completion.chunk",
                        "created": Math.round(new Date().getTime() / 1000),
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": index,
                                            "function": { "arguments": piece }
                                        }
                                    ]
                                },
                                "finish_reason": null
                            }
                        ]
                    }
                    res.write(`data: ${JSON.stringify(argDelta)}\n\n`)
                }
            }
        }

        /**
         * 处理一个 SSE data 段（已剥离 'data: ' 前缀）
         * @param {string} dataContent - 原始 data 段
         */
        const processSSEPayload = async (dataContent) => {
            const decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
            if (decodeJson === null) return
            assertNoUpstreamFailure(decodeJson)
            // 丢弃其余候选回答的帧：上游多路并发会让内容重复
            if (!acceptUpstreamFrame(decodeJson)) return

            if (decodeJson.usage) {
                totalTokens = {
                    prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                    completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                    total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                }
            }

            if (!decodeJson.choices || decodeJson.choices.length === 0) return

            const choice = decodeJson.choices[0]
            const reportedFinishReason = choice.finish_reason ?? choice.delta?.finish_reason
            if (reportedFinishReason !== undefined && reportedFinishReason !== null) {
                upstreamFinishReason = reportedFinishReason
            }

            const delta = choice.delta || {}
            if (nativeToolAccumulator) {
                // 关闭即判定；发射仍在回合尾部 finalize()（旧路径没有中途排放，drain 为空操作）。
                feedNativeFrame(nativeToolAccumulator, delta, reportedFinishReason, { isClientToolName, drain: () => {} })
            }

            if (delta && delta.name === 'web_search') {
                web_search_info = delta.extra.web_search_info
            }

            const imageMarkdownList = getImageMarkdownListFromDelta(delta)
            if (imageMarkdownList.length > 0) {
                const newImageMarkdownList = imageMarkdownList.filter(item => !emittedImageMarkdownSet.has(item))

                if (thinking_start && !thinking_end) {
                    for (const imageMarkdown of newImageMarkdownList) {
                        if (!pendingImageMarkdownList.includes(imageMarkdown)) {
                            pendingImageMarkdownList.push(imageMarkdown)
                        }
                    }
                } else if (newImageMarkdownList.length > 0) {
                    const imageContent = `${newImageMarkdownList.join('\n\n')}\n\n`
                    completionContent += imageContent
                    newImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                    writeContentDelta(imageContent)
                }
            }

            // 兼容 think / thinking_summary；summary 内容来自 extra
            const normalized = normalizeDelta(delta)
            if (!normalized) {
                return
            }
            // 后续逻辑统一用 phase=think|answer
            delta.phase = normalized.phase
            let content = normalized.content
            completionContent += content

            if (config.legacyReasoningInContent) {
                // 旧版：推理以 <think>...</think> 包裹并入 content
                if (delta.phase === 'think' && !thinking_start) {
                    thinking_start = true
                    if (web_search_info) {
                        content = `<think>\n\n${await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)}\n\n${content}`
                    } else {
                        content = `<think>\n\n${content}`
                    }
                }
                if (delta.phase === 'answer' && !thinking_end && thinking_start) {
                    thinking_end = true
                    if (pendingImageMarkdownList.length > 0) {
                        const pendingImageContent = `${pendingImageMarkdownList.join('\n\n')}\n\n`
                        content = `\n\n</think>\n${pendingImageContent}${content}`
                        completionContent += pendingImageContent
                        pendingImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                        pendingImageMarkdownList = []
                    } else {
                        content = `\n\n</think>\n${content}`
                    }
                }

                if (toolParser && delta.phase === 'answer') {
                    const parsed = toolParser.push(content)
                    if (parsed.textDelta) writeContentDelta(parsed.textDelta)
                    if (parsed.completedCalls.length > 0) writeToolCallsDelta(parsed.completedCalls)
                } else {
                    writeContentDelta(content)
                }
                return
            }

            // 新版（默认）：推理走 reasoning_content，content 仅为回复正文
            if (delta.phase === 'think') {
                if (!thinking_start) {
                    thinking_start = true
                    if (web_search_info) {
                        const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                        content = `${webSearchTable}\n\n${content}`
                    }
                }
                writeReasoningDelta(content)
                return
            }

            // delta.phase === 'answer'：首次进入 answer 时结束思考，并冲刷 think 阶段缓存的图片
            if (!thinking_end && thinking_start) {
                thinking_end = true
                if (pendingImageMarkdownList.length > 0) {
                    const pendingImageContent = `${pendingImageMarkdownList.join('\n\n')}\n\n`
                    completionContent += pendingImageContent
                    pendingImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                    pendingImageMarkdownList = []
                    content = `${pendingImageContent}${content}`
                }
            }
            emitAnswerContent(content)
        }

        /**
         * 把一个上游响应流接入解析与转发管线，等其结束
         * @param {object} upstreamResponse - axios stream 响应
         * @returns {Promise<void>} 流处理完成的 Promise
         */
        const pipeUpstream = async (upstreamResponse) => {
            const result = await consumeSSEStream(upstreamResponse, async (frame) => {
                if (!frame.data || frame.data.trim() === '[DONE]') return
                try {
                    await processSSEPayload(frame.data)
                } catch (error) {
                    logger.error('流式数据处理错误', 'CHAT', '', error)
                    throw error
                }
            })
            upstreamCompleted = result.completed
            upstreamEventCount = result.eventCount
        }

        await pipeUpstream(response)

        // Agent 空回合补偿：只有思考、没有正文/工具调用时自动重试一次。
        // required 仍使用更强的指定工具提示；两个条件共用一次重试，避免重复请求。
        const needsRequiredRetry = !!(
            hasTools && toolParser &&
            !toolParser.hasEmittedAnyCall() &&
            !nativeToolAccumulator?.hasAny() &&
            requiresToolCall(toolChoice)
        )
        const needsEmptyOutputRetry = !!(
            !visibleContent.trim() &&
            !toolParser?.hasEmittedAnyCall() &&
            !toolParser?.hasPendingCall() &&
            !toolParser?.hasParseError() &&
            !nativeToolAccumulator?.hasAny() &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)
        )
        const needsMissingToolRetry = !!(
            hasTools && looksLikeUnexecutedToolAction(visibleContent) &&
            !toolParser?.hasEmittedAnyCall() && !toolParser?.hasPendingCall() &&
            !toolParser?.hasParseError() && !nativeToolAccumulator?.hasAny() &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)
        )
        if (needsRequiredRetry || needsEmptyOutputRetry || needsMissingToolRetry) {
            const retryHint = needsRequiredRetry
                ? buildRequiredRetryHint(toolChoice)
                : (needsMissingToolRetry ? buildMissingToolRetryHint() : buildEmptyOutputRetryHint())
            const retryBody = appendRetryHintToRequestBody(requestBody, retryHint)
            logger.warn(
                needsRequiredRetry
                    ? 'tool_choice=required 首次未触发工具调用，进行一次重试'
                    : (needsMissingToolRetry
                        ? 'Agent 首次响应只描述了动作但未调用工具，进行一次补偿重试'
                        : 'Agent 首次响应没有正文或工具调用，进行一次补偿重试'),
                'CHAT'
            )
            try {
                const retryResp = await requestSender(retryBody)
                if (retryResp.status && retryResp.response) {
                    // 与非流式分支同一条：重试是新的回合，解析器与累积器都重建，第一轮的残片
                    // 不能漂进第二轮（其余消费者本来就按 attempt 重建）。
                    if (hasTools) {
                        toolParser = createToolCallStreamParser({ allowedToolNames })
                        nativeToolAccumulator = createNativeToolCallAccumulator({ allowedToolNames })
                    }
                    upstreamFinishReason = null
                    await pipeUpstream(retryResp.response)
                }
            } catch (e) {
                logger.error('Agent 补偿重试失败', 'CHAT', '', e)
                if (e.publicMessage) throw e
            }
        }

        // flush 工具调用解析器中的残留内容
        if (toolParser) {
            const tail = toolParser.flush()
            if (tail.textDelta) writeContentDelta(tail.textDelta)
            if (tail.completedCalls.length > 0) writeToolCallsDelta(tail.completedCalls)
        }

        const nativeToolCalls = nativeToolAccumulator?.hasAny()
            ? nativeToolAccumulator.finalize()
            : []
        if (nativeToolCalls.length > 0) writeToolCallsDelta(nativeToolCalls)

        const hasEmittedToolCalls = !!(
            nativeToolCalls.length > 0 ||
            (toolParser && toolParser.hasEmittedAnyCall())
        )
        const hasToolProtocolError = !!(
            !hasEmittedToolCalls &&
            (requiresToolCall(toolChoice) ||
                (toolParser && toolParser.hasParseError()) ||
                (nativeToolAccumulator && nativeToolAccumulator.hasParseError()))
        )
        if (hasToolProtocolError) {
            writeOpenAIStreamError(res, '上游返回了残缺、非法或不存在的工具调用', 'invalid_tool_call')
            return
        }

        if (!visibleContent.trim() && !hasEmittedToolCalls &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)) {
            writeOpenAIStreamError(res, '上游重试后仍未返回正文或工具调用', 'upstream_empty_output')
            return
        }

        const finishReason = normalizeOpenAIFinishReason(
            upstreamFinishReason,
            hasEmittedToolCalls,
            upstreamCompleted
        )
        if (!finishReason) {
            const detail = upstreamEventCount === 0 ? '上游未返回任何 SSE 事件' : '上游流在结束标记前断开'
            writeOpenAIStreamError(res, detail, 'upstream_incomplete')
            return
        }

        // 处理最终的搜索信息
        // 旧版：维持原行为（outThink 关闭或未思考时把搜索表格追加到 content 末尾）
        // 新版：搜索表格已在 think 阶段写入 reasoning_content，思考开启时不再追加到 content，避免重复
        const appendSearchToContent = config.legacyReasoningInContent
            ? (config.outThink === false || !enable_thinking)
            : !enable_thinking
        if (appendSearchToContent && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            writeContentDelta(`\n\n---\n${webSearchTable}`)
        }

        // 计算最终的token使用量
        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || promptText, completionContent, null)
            logger.info(`流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        } else {
            logger.info(`流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        }

        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
        totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
        totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

        // Daily stats 累计——一次性归属到主请求账户
        // 注：tool_choice=required retry 走的可能是另一个账户，但 retry 路径罕见，
        // 全归属主账户是可接受的精度损失（PR #3wg.1 epic notes 已记）
        attributeChatUsage(options.currentAccount, totalTokens)

        res.write(`data: ${JSON.stringify({
            "id": `chatcmpl-${message_id}`,
            "object": "chat.completion.chunk",
            "created": Math.round(new Date().getTime() / 1000),
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": finishReason
                }
            ]
        })}\n\n`)

        res.write(`data: ${JSON.stringify({
            "id": `chatcmpl-${message_id}`,
            "object": "chat.completion.chunk",
            "created": Math.round(new Date().getTime() / 1000),
            "choices": [],
            "usage": totalTokens
        })}\n\n`)

        res.write(`data: [DONE]\n\n`)
        res.end()
    } catch (error) {
        logger.error('聊天处理错误', 'CHAT', '', error)
        if (res.headersSent) {
            if (!res.writableEnded) {
                writeOpenAIStreamError(
                    res,
                    error.publicMessage || '上游流式传输失败',
                    error.publicMessage ? error.code : 'upstream_stream_error'
                )
            }
        } else {
            res.status(502).json({
                error: {
                    message: error.publicMessage || '上游流式传输失败',
                    type: 'upstream_stream_error',
                    code: error.code || 'upstream_stream_error'
                }
            })
        }
    }
}

/**
 * 处理非流式响应（从流式数据累积完整响应）
 * @param {object} res - Express 响应对象
 * @param {object} response - 上游响应流
 * @param {boolean} enable_thinking - 是否启用思考模式
 * @param {boolean} enable_web_search - 是否启用网络搜索
 * @param {string} model - 模型名称
 * @param {object} requestBody - 原始请求体，用于提取prompt信息
 * @param {object} [options] - 扩展选项
 * @param {boolean} [options.has_tools] - 是否启用工具调用解析
 */
const handleNonStreamResponse = async (res, response, enable_thinking, enable_web_search, model, requestBody = null, options = {}) => {
    if (options.has_tools && options.strict_agent_turn !== false) {
        return handleOpenAIAgentNonStream(
            res,
            response,
            enable_thinking,
            enable_web_search,
            model,
            requestBody,
            options
        )
    }
    try {
        let fullContent = ''
        let fullReasoning = '' // 新版模式下累积的推理内容（reasoning_content）
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        const normalizeDelta = createUpstreamDeltaNormalizer()
        const acceptUpstreamFrame = createUpstreamResponseFilter()
        let appendedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const requestSender = options.sendChatRequest || sendChatRequest
        const toolChoice = options.tool_choice
        const allowedToolNames = options.allowed_tool_names || []
        const isClientToolName = createClientToolNamePredicate(allowedToolNames)
        let nativeToolAccumulator = hasTools
            ? createNativeToolCallAccumulator({ allowedToolNames })
            : null
        let upstreamFinishReason = null
        let upstreamCompleted = false
        let upstreamEventCount = 0

        // Token消耗量统计
        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }

        // 提取prompt文本用于token估算
        let promptText = ''
        if (requestBody && requestBody.messages) {
            promptText = requestBody.messages.map(msg => {
                if (typeof msg.content === 'string') {
                    return msg.content
                } else if (Array.isArray(msg.content)) {
                    return msg.content.map(item => item.text || '').join('')
                }
                return ''
            }).join('\n')
        }

        /**
         * 把一个上游响应流读完并累积到 fullContent
         * @param {object} upstreamResponse - axios stream 响应
         * @returns {Promise<void>} 流处理完成的 Promise
         */
        const processAccumulatedPayload = async (dataContent) => {
            const decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
            if (decodeJson === null) return
            assertNoUpstreamFailure(decodeJson)
            // 丢弃其余候选回答的帧：上游多路并发会让内容重复
            if (!acceptUpstreamFrame(decodeJson)) return

            if (decodeJson.usage) {
                totalTokens = {
                    prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                    completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                    total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                }
            }
            if (!decodeJson.choices || decodeJson.choices.length === 0) return

            const choice = decodeJson.choices[0]
            const reportedFinishReason = choice.finish_reason ?? choice.delta?.finish_reason
            if (reportedFinishReason !== undefined && reportedFinishReason !== null) {
                upstreamFinishReason = reportedFinishReason
            }
            const delta = choice.delta || {}
            if (nativeToolAccumulator) {
                // 关闭即判定；结算在回合尾部 finalize()（drain 为空操作）。
                feedNativeFrame(nativeToolAccumulator, delta, reportedFinishReason, { isClientToolName, drain: () => {} })
            }

            if (delta.name === 'web_search') {
                web_search_info = delta.extra?.web_search_info
            }

            const imageMarkdownList = getImageMarkdownListFromDelta(delta)
            if (imageMarkdownList.length > 0) {
                const newImageMarkdownList = imageMarkdownList.filter(it => !appendedImageMarkdownSet.has(it))
                if (thinking_start && !thinking_end) {
                    for (const imageMarkdown of newImageMarkdownList) {
                        if (!pendingImageMarkdownList.includes(imageMarkdown)) pendingImageMarkdownList.push(imageMarkdown)
                    }
                } else if (newImageMarkdownList.length > 0) {
                    fullContent += `${newImageMarkdownList.join('\n\n')}\n\n`
                    newImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                }
            }

            const normalized = normalizeDelta(delta)
            if (!normalized) return
            delta.phase = normalized.phase
            let content = normalized.content

            if (config.legacyReasoningInContent) {
                if (delta.phase === 'think' && !thinking_start) {
                    thinking_start = true
                    if (web_search_info) {
                        const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                        content = `<think>\n\n${webSearchTable}\n\n${content}`
                    } else {
                        content = `<think>\n\n${content}`
                    }
                }
                if (delta.phase === 'answer' && !thinking_end && thinking_start) {
                    thinking_end = true
                    if (pendingImageMarkdownList.length > 0) {
                        content = `\n\n</think>\n${pendingImageMarkdownList.join('\n\n')}\n\n${content}`
                        pendingImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                        pendingImageMarkdownList = []
                    } else {
                        content = `\n\n</think>\n${content}`
                    }
                }
                fullContent += content
            } else if (delta.phase === 'think') {
                if (!thinking_start && web_search_info) {
                    const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                    content = `${webSearchTable}\n\n${content}`
                }
                thinking_start = true
                fullReasoning += content
            } else {
                if (!thinking_end && thinking_start) {
                    thinking_end = true
                    if (pendingImageMarkdownList.length > 0) {
                        fullContent += `${pendingImageMarkdownList.join('\n\n')}\n\n`
                        pendingImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                        pendingImageMarkdownList = []
                    }
                }
                fullContent += content
            }
        }

        const accumulateUpstream = async (upstreamResponse) => {
            const result = await consumeSSEStream(upstreamResponse, async (frame) => {
                if (!frame.data || frame.data.trim() === '[DONE]') return
                await processAccumulatedPayload(frame.data)
            })
            upstreamCompleted = result.completed
            upstreamEventCount = result.eventCount
        }

        await accumulateUpstream(response)

        if (!upstreamCompleted && !upstreamFinishReason) {
            const detail = upstreamEventCount === 0 ? '上游未返回任何 SSE 事件' : '上游流在结束标记前断开'
            return res.status(502).json({
                error: { message: detail, type: 'upstream_stream_error', code: 'upstream_incomplete' }
            })
        }

        // 同时支持提示词/XML 工具调用与上游原生 delta.tool_calls。
        let assistantContent = fullContent
        let toolCalls = []
        let toolErrors = []
        if (hasTools) {
            const parsed = parseToolCallsFromText(fullContent, { allowedToolNames })
            const nativeCalls = nativeToolAccumulator?.hasAny() ? nativeToolAccumulator.finalize() : []
            assistantContent = parsed.cleanedText
            toolCalls = [...nativeCalls, ...parsed.toolCalls].map((call, index) => ({ ...call, index }))
            toolErrors = [
                ...parsed.errors,
                ...(nativeToolAccumulator?.getErrors() || [])
            ]
        }

        // required 未调用，或只有思考没有可见输出时，共用一次补偿重试。
        const needsRequiredRetry = hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)
        const needsEmptyOutputRetry = toolCalls.length === 0 && toolErrors.length === 0 && !assistantContent.trim() &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)
        const needsMissingToolRetry = hasTools && toolCalls.length === 0 && toolErrors.length === 0 &&
            looksLikeUnexecutedToolAction(assistantContent) &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)
        if (needsRequiredRetry || needsEmptyOutputRetry || needsMissingToolRetry) {
            const retryHint = needsRequiredRetry
                ? buildRequiredRetryHint(toolChoice)
                : (needsMissingToolRetry ? buildMissingToolRetryHint() : buildEmptyOutputRetryHint())
            const retryBody = appendRetryHintToRequestBody(requestBody, retryHint)
            logger.warn(
                needsRequiredRetry
                    ? 'tool_choice=required 首次未触发工具调用，进行一次重试'
                    : (needsMissingToolRetry
                        ? 'Agent 首次响应只描述了动作但未调用工具，进行一次补偿重试'
                        : 'Agent 首次响应没有正文或工具调用，进行一次补偿重试'),
                'CHAT'
            )
            try {
                const retryResp = await requestSender(retryBody)
                if (retryResp.status && retryResp.response) {
                    const before = fullContent
                    nativeToolAccumulator = createNativeToolCallAccumulator({ allowedToolNames })
                    upstreamFinishReason = null
                    await accumulateUpstream(retryResp.response)
                    if (!upstreamCompleted && !upstreamFinishReason) {
                        return res.status(502).json({
                            error: {
                                message: '工具调用重试流在结束标记前断开',
                                type: 'upstream_stream_error',
                                code: 'upstream_incomplete'
                            }
                        })
                    }
                    const retriedText = fullContent.slice(before.length)
                    const parsedRetry = parseToolCallsFromText(retriedText, { allowedToolNames })
                    const nativeRetryCalls = nativeToolAccumulator.hasAny()
                        ? nativeToolAccumulator.finalize()
                        : []
                    toolCalls = [...nativeRetryCalls, ...parsedRetry.toolCalls]
                        .map((call, index) => ({ ...call, index }))
                    assistantContent = parsedRetry.cleanedText
                    toolErrors = [
                        ...parsedRetry.errors,
                        ...nativeToolAccumulator.getErrors()
                    ]
                }
            } catch (e) {
                logger.error('Agent 补偿重试失败', 'CHAT', '', e)
                if (e.publicMessage) throw e
            }
        }

        if (hasTools && toolCalls.length === 0 && (toolErrors.length > 0 || requiresToolCall(toolChoice))) {
            return res.status(502).json({
                error: {
                    message: '上游返回了残缺、非法或不存在的工具调用',
                    type: 'invalid_tool_call',
                    code: 'invalid_tool_call',
                    details: toolErrors
                }
            })
        }

        if (toolCalls.length === 0 && !assistantContent.trim() &&
            !['length', 'max_tokens', 'content_filter', 'refusal'].includes(upstreamFinishReason)) {
            return res.status(502).json({
                error: {
                    message: '上游重试后仍未返回正文或工具调用',
                    type: 'upstream_empty_output',
                    code: 'upstream_empty_output'
                }
            })
        }

        const finishReason = normalizeOpenAIFinishReason(
            upstreamFinishReason,
            toolCalls.length > 0,
            upstreamCompleted
        )
        if (!finishReason) {
            return res.status(502).json({
                error: {
                    message: '上游流在结束标记前断开',
                    type: 'upstream_stream_error',
                    code: 'upstream_incomplete'
                }
            })
        }

        // 处理最终的搜索信息（同流式分支：新版模式思考开启时搜索表格已在 reasoning_content，不再追加到 content）
        const appendSearchToContent = config.legacyReasoningInContent
            ? (config.outThink === false || !enable_thinking)
            : !enable_thinking
        if (appendSearchToContent && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            assistantContent += `\n\n---\n${webSearchTable}`
        }

        // 计算最终的token使用量（推理内容计入 completion，与 DeepSeek 一致；旧版 fullReasoning 为空）
        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || promptText, fullReasoning + fullContent, null)
            logger.info(`非流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        } else {
            logger.info(`非流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        }

        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
        totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
        totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

        // Daily stats 累计——一次性归属到主请求账户（同 stream 分支注释）
        attributeChatUsage(options.currentAccount, totalTokens)

        const assistantMessage = { role: 'assistant', content: assistantContent || null }
        if (fullReasoning) {
            assistantMessage.reasoning_content = fullReasoning
        }
        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls
        }

        const bodyTemplate = {
            "id": `chatcmpl-${generateUUID()}`,
            "object": "chat.completion",
            "created": Math.round(new Date().getTime() / 1000),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": assistantMessage,
                    "finish_reason": finishReason
                }
            ],
            "usage": totalTokens
        }
        res.json(bodyTemplate)
    } catch (error) {
        logger.error('非流式聊天处理错误', 'CHAT', '', error)
        if (!res.headersSent) {
            res.status(502).json({
                error: {
                    message: error.publicMessage || '上游响应处理失败',
                    type: 'upstream_error',
                    code: error.code || 'upstream_error'
                }
            })
        }
    }
}


/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleChatCompletion = async (req, res) => {
    const { stream, model } = req.body

    const enable_thinking = req.enable_thinking
    const enable_web_search = req.enable_web_search

    try {
        const response_data = await sendChatRequest(req.body)

        if (!response_data.status || !response_data.response) {
            res.status(500)
                .json({
                    error: response_data.message || "Request failed"
                })
            return
        }

    // Aviso al cliente cuando el contexto se recortó en silencio. El fallback por fallo
    // del adjunto deja pasar un 200 con una fracción del contexto original: sin esta
    // cabecera el cliente cree que el modelo lo vio todo. Convención existente:
    // anthropic.compatibility.js#X-Qwen2API-Anthropic-Warnings.
        if (response_data.contextCompacted) {
            res.set('X-Qwen2API-Context-Compacted', String(response_data.contextSerializedBytes || 0))
        }

        if (stream) {
            setResponseHeaders(res, true)
            await handleStreamResponse(res, response_data.response, enable_thinking, enable_web_search, req.body, {
                has_tools: req.has_tools,
                tool_choice: req.tool_choice,
                allowed_tool_names: req.allowed_tool_names,
                // Puertas de schema del parser (reparacion de comillas / aceptacion tras
                // prosa). Sin esto ambas fallan cerradas en el runtime de Agent.
                tool_schemas: req.tool_schemas,
                // Semilla del ledger de deduplicacion (chat-middleware.js). Informa, no suprime.
                tool_history_calls: req.tool_history_calls,
                currentAccount: response_data.currentAccount,
                upstream_request_body: response_data.requestBody,
                upstream_context: {
                    chatId: response_data.chatId,
                    parentId: response_data.parentId
                }
            })
        } else {
            setResponseHeaders(res, false)
            await handleNonStreamResponse(res, response_data.response, enable_thinking, enable_web_search, model, req.body, {
                has_tools: req.has_tools,
                tool_choice: req.tool_choice,
                allowed_tool_names: req.allowed_tool_names,
                // Puertas de schema del parser (reparacion de comillas / aceptacion tras
                // prosa). Sin esto ambas fallan cerradas en el runtime de Agent.
                tool_schemas: req.tool_schemas,
                // Semilla del ledger de deduplicacion (chat-middleware.js). Informa, no suprime.
                tool_history_calls: req.tool_history_calls,
                currentAccount: response_data.currentAccount,
                upstream_request_body: response_data.requestBody,
                upstream_context: {
                    chatId: response_data.chatId,
                    parentId: response_data.parentId
                }
            })
        }

    } catch (error) {
        logger.error('聊天处理错误', 'CHAT', '', error)
        res.status(500)
            .json({
                error: "Invalid token, request failed"
            })
    }
}

module.exports = {
    handleChatCompletion,
    handleStreamResponse,
    handleNonStreamResponse,
    setResponseHeaders,
    normalizeOpenAIFinishReason
}
