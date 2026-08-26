const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('./proxy-helper')
const { generateUUID, getTimezoneHeader } = require('./tools.js')
const { uploadAgentContextFile } = require('./upload.js')

// 传输层（非 HTTP）错误码 — 这些重试的, HTTP 响应不重试
const RETRYABLE_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EAI_AGAIN'
])

const isRetryableNetworkError = (error) => {
    if (!error) return false
    // 已收到 HTTP 响应 = 上游回包了, 不是传输问题
    if (error.response) return false
    if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true
    if (typeof error.message === 'string' && error.message.includes('socket hang up')) return true
    return false
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const HISTORY_MARKER = '# Conversation history (JSONL)'
const CURRENT_MESSAGE_MARKER = '# Current message'

const byteLength = (value) => Buffer.byteLength(String(value || ''), 'utf8')

const truncateUtf8 = (value, maxBytes, fromEnd = false) => {
    const buffer = Buffer.from(String(value || ''), 'utf8')
    if (buffer.length <= maxBytes) return buffer.toString('utf8')
    const slice = fromEnd
        ? buffer.subarray(Math.max(0, buffer.length - maxBytes))
        : buffer.subarray(0, maxBytes)
    return slice.toString('utf8').replace(/^\uFFFD|\uFFFD$/g, '')
}

const truncateUtf8HeadTail = (
    value,
    maxBytes,
    headRatio = 0.55,
    separator = '\n...[inline context compacted; complete copy is in the attachment]...\n'
) => {
    const text = String(value || '')
    const buffer = Buffer.from(text, 'utf8')
    const limit = Math.max(0, Number(maxBytes) || 0)
    if (buffer.length <= limit) return text
    if (limit === 0) return ''

    const separatorBytes = byteLength(separator)
    if (limit <= separatorBytes + 2) return truncateUtf8(text, limit)

    const contentBudget = limit - separatorBytes
    const headBytes = Math.max(1, Math.floor(contentBudget * headRatio))
    const tailBytes = Math.max(1, contentBudget - headBytes)
    return `${truncateUtf8(text, headBytes)}${separator}${truncateUtf8(text, tailBytes, true)}`
}

const parseAgentEnvelope = (value) => {
    const text = String(value || '')
    const historyIndex = text.indexOf(HISTORY_MARKER)
    const currentIndex = text.lastIndexOf(CURRENT_MESSAGE_MARKER)
    if (historyIndex < 0) {
        if (currentIndex >= 0) {
            return {
                prefix: text.slice(0, currentIndex).trim(),
                history: '',
                current: text.slice(currentIndex).trim(),
                entries: []
            }
        }
        return { prefix: text, history: '', current: '', entries: [] }
    }

    const historyStart = historyIndex + HISTORY_MARKER.length
    const hasCurrent = currentIndex > historyStart
    const history = text.slice(historyStart, hasCurrent ? currentIndex : text.length).trim()
    const entries = []
    for (const line of history.split('\n')) {
        const raw = line.trim()
        if (!raw) continue
        try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                entries.push({
                    raw,
                    role: String(parsed.role || '').toLowerCase(),
                    content: typeof parsed.content === 'string'
                        ? parsed.content
                        : JSON.stringify(parsed.content ?? '')
                })
            }
        } catch (_) {
            // 历史中可能包含旧版非 JSONL 内容；recent history 仍会按原文保留。
        }
    }
    return {
        prefix: text.slice(0, historyIndex).trim(),
        history,
        current: hasCurrent ? text.slice(currentIndex).trim() : '',
        entries
    }
}

const buildEssentialAgentHistory = (entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return ''
    const systemEntries = entries.filter(entry => ['system', 'developer'].includes(entry.role))
    const activeTask = [...entries].reverse().find(entry =>
        entry.role === 'user' &&
        !/^\s*<tool_response\b/i.test(entry.content) &&
        !/^\s*\[tool[_ ]result/i.test(entry.content)
    )

    const sections = []
    if (systemEntries.length > 0) {
        sections.push('## System/developer instructions', systemEntries.map(entry => entry.raw).join('\n'))
    }
    if (activeTask) {
        sections.push('## Active user task', activeTask.raw)
    }
    return sections.join('\n')
}

const buildRecentAgentHistory = (
    envelope,
    maxBytes,
    compactionSeparator = '\n...[inline context compacted; complete copy is in the attachment]...\n'
) => {
    const limit = Math.max(0, Number(maxBytes) || 0)
    if (limit === 0) return ''
    const entries = envelope?.entries || []
    if (entries.length === 0) {
        return truncateUtf8HeadTail(envelope?.history || '', limit, 0.35, compactionSeparator)
    }

    const latest = entries[entries.length - 1].raw
    const previous = entries.slice(Math.max(0, entries.length - 4), -1)
        .map(entry => entry.raw)
        .join('\n')
    if (!previous) return truncateUtf8HeadTail(latest, limit, 0.4, compactionSeparator)

    const previousBudget = Math.floor(limit * 0.32)
    const latestBudget = Math.max(0, limit - previousBudget - 1)
    return [
        truncateUtf8HeadTail(previous, previousBudget, 0.45, compactionSeparator),
        truncateUtf8HeadTail(latest, latestBudget, 0.4, compactionSeparator)
    ].filter(Boolean).join('\n')
}

const buildBudgetedAgentPrompt = (
    original,
    maxBytes,
    notice,
    { attachmentAvailable = true } = {}
) => {
    const envelope = parseAgentEnvelope(original)
    const essential = buildEssentialAgentHistory(envelope.entries)
    const sections = [
        { header: '', value: envelope.prefix, weight: 34, headRatio: 0.55, kind: 'text' },
        {
            header: '# Essential Agent state retained inline',
            value: essential,
            weight: 24,
            headRatio: 0.65,
            kind: 'text'
        },
        {
            header: '# Recent Agent history retained inline',
            value: envelope.history,
            weight: 18,
            headRatio: 0.4,
            kind: 'recent'
        },
        { header: '', value: envelope.current, weight: 24, headRatio: 0.45, kind: 'text' }
    ].filter(section => String(section.value || '').trim())

    const max = Math.max(1024, Number(maxBytes) || config.agentContextLivePromptBytes)
    const joinSeparator = '\n\n'
    const fixedBytes = byteLength(notice) +
        (sections.length * byteLength(joinSeparator)) +
        sections.reduce((sum, section) => (
            sum + (section.header ? byteLength(`${section.header}\n`) : 0)
        ), 0)
    if (fixedBytes >= max) return truncateUtf8(notice, max)

    let remainingBytes = max - fixedBytes
    let remainingWeight = sections.reduce((sum, section) => sum + section.weight, 0)
    const compactionSeparator = attachmentAvailable
        ? '\n...[inline context compacted; complete copy is in the attachment]...\n'
        : '\n...[older inline context compacted after attachment recovery failed]...\n'
    const rendered = sections.map((section, index) => {
        const isLast = index === sections.length - 1
        const budget = isLast
            ? remainingBytes
            : Math.floor(remainingBytes * section.weight / remainingWeight)
        remainingBytes -= budget
        remainingWeight -= section.weight
        const content = section.kind === 'recent'
            ? buildRecentAgentHistory(envelope, budget, compactionSeparator)
            : truncateUtf8HeadTail(
                section.value,
                budget,
                section.headRatio,
                compactionSeparator
            )
        return section.header ? `${section.header}\n${content}` : content
    })

    return [notice, ...rendered].join(joinSeparator)
}

const getMessageTextContent = (message) => {
    if (typeof message?.content === 'string') return message.content
    if (!Array.isArray(message?.content)) return null
    const textPart = message.content.find(item =>
        item && typeof item.text === 'string' &&
        (item.text.includes(HISTORY_MARKER) || item.text.includes(CURRENT_MESSAGE_MARKER))
    ) || message.content.find(item => item && typeof item.text === 'string')
    return textPart?.text ?? null
}

const replaceMessageTextContent = (message, text) => {
    if (typeof message?.content === 'string') return { ...message, content: text }
    if (!Array.isArray(message?.content)) return message

    let replaced = false
    const content = message.content.map(item => {
        const isPreferred = item && typeof item.text === 'string' &&
            (item.text.includes(HISTORY_MARKER) || item.text.includes(CURRENT_MESSAGE_MARKER))
        if (!replaced && isPreferred) {
            replaced = true
            return { ...item, text }
        }
        return item
    })
    if (!replaced) {
        const fallbackIndex = content.findIndex(item => item && typeof item.text === 'string')
        if (fallbackIndex >= 0) {
            content[fallbackIndex] = { ...content[fallbackIndex], text }
        }
    }
    return { ...message, content }
}

/**
 * 附件外置后仍留在 HTTP 请求体中的高优先级提示。
 * 优先保留工具协议与当前回合；完整原文始终存在附件中。
 */
const buildAgentContextLivePrompt = (
    original,
    maxBytes = config.agentContextLivePromptBytes,
    attachmentName = 'QWEN2API_AGENT_CONTEXT.txt'
) => {
    const notice = [
        '# Agent context attachment',
        `The complete system instructions, tool schemas, conversation history and current task are attached as ${attachmentName}.`,
        'Read that attachment as authoritative context before acting. The essential task state and recent tool progress are also retained inline below so the Agent loop must not reset if attachment parsing is delayed.',
        'Continue from the latest state; do not restart the task, stop after one intermediate action, or claim completion without tool-result verification.',
        'When an available tool is needed, emit the real `<tool_call>` block immediately. Do not replace it with prose such as “I will run...” or “done”.'
    ].join('\n')
    return buildBudgetedAgentPrompt(original, maxBytes, notice, { attachmentAvailable: true })
}

const compactAgentContextFallback = (original, maxBytes = config.agentContextLivePromptBytes) => {
    const notice = [
        '# Agent context recovery',
        'The upstream document attachment failed, so older context was compacted to stay below the Qwen Web request limit.',
        'The system/developer rules, active user task, recent tool progress, and current tool result retained below remain authoritative.',
        'Continue the latest Agent task using that state. Use a real tool call whenever more work is required; do not report completion before verification.'
    ].join('\n')
    return buildBudgetedAgentPrompt(original, maxBytes, notice, { attachmentAvailable: false })
}

/**
 * 超过安全阈值时把完整 Agent 上下文上传为 Qwen 文档。
 * uploader 可注入，便于在无真实账号的测试环境验证整个变换。
 */
const externalizeOversizedAgentContext = async (
    payload,
    currentToken,
    currentAccount,
    options = {}
) => {
    const thresholdBytes = Math.max(1024, Number(options.thresholdBytes) || config.agentContextFileThresholdBytes)
    const serializedBytes = byteLength(JSON.stringify(payload))
    const message = payload?.messages?.[0]
    const originalContent = getMessageTextContent(message)
    if (serializedBytes <= thresholdBytes || !message || originalContent === null) {
        return { payload, externalized: false, serializedBytes }
    }

    const uploader = options.uploader || uploadAgentContextFile
    let file
    try {
        file = await uploader(originalContent, currentToken, currentAccount, options)
    } catch (error) {
        logger.error('Agent long-context attachment upload/parse failed, falling back to recent context', 'REQUEST', '', error)
        const fallbackMessage = replaceMessageTextContent(
            message,
            compactAgentContextFallback(originalContent, options.livePromptBytes)
        )
        fallbackMessage.files = Array.isArray(message.files) ? [...message.files] : []
        return {
            payload: { ...payload, messages: [fallbackMessage, ...payload.messages.slice(1)] },
            externalized: false,
            compacted: true,
            serializedBytes
        }
    }

    const attachmentName = file?.name || file?.file?.filename || 'QWEN2API_AGENT_CONTEXT.txt'
    const externalizedMessage = replaceMessageTextContent(
        message,
        buildAgentContextLivePrompt(originalContent, options.livePromptBytes, attachmentName)
    )
    externalizedMessage.files = [...(Array.isArray(message.files) ? message.files : []), file]
    return {
        payload: { ...payload, messages: [externalizedMessage, ...payload.messages.slice(1)] },
        externalized: true,
        serializedBytes
    }
}

/**
 * 发送聊天请求
 * @param {Object} body - 请求体
 * @returns {Promise<Object>} 响应结果
 */
const sendChatRequest = async (body, options = {}) => {
    // 获取可用的账户（包含 proxy 等完整字段）
    const currentAccount = options.currentAccount?.token
        ? options.currentAccount
        : accountManager.getAccount()
    const currentToken = currentAccount ? currentAccount.token : null

    if (!currentToken) {
        // 把具体原因（data.json 损坏 / 尚未初始化 / 没有账户）透传给客户端，
        // 否则调用方只能看到笼统的「Request failed」，排查要靠翻服务端日志
        const reason = accountManager.getUnavailableReason() || '无法获取有效的访问令牌'
        logger.error(reason, 'TOKEN')
        return {
            status: false,
            response: null,
            message: reason
        }
    }

    const chatBaseUrl = getChatBaseUrl()
    const proxyAgent = getProxyAgent(currentAccount)

    // 构建请求配置（与通义千问 React Web 客户端完全一致，对齐 FE 0.2.81）
    const requestConfig = {
        headers: {
            'sec-ch-ua-platform': '"Windows"',
            'referer': `${chatBaseUrl}/`,
            'accept-language': 'zh-CN,zh;q=0.9',
            'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
            'content-type': 'application/json',
            'accept': 'application/json',
            'accept-encoding': 'gzip, deflate, br, zstd',
            // WAF 客户端标识头（必须与 React Web 客户端一致）
            'source': 'web',
            'version': '0.2.81',
            'timezone': getTimezoneHeader(),
            'x-request-id': generateUUID(),
            'connection': 'keep-alive',
            // Cookie: JWT token + SSXMOD 反爬链（双重认证；浏览器不带 authorization 头，鉴权全走 cookie）
            'cookie': `token=${currentToken};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
            'host': chatBaseUrl.replace('https://', ''),
            'origin': chatBaseUrl,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'x-accel-buffering': 'no',
        },
        responseType: 'stream', // Always use streaming (upstream doesn't support stream=false)
        timeout: 10 * 60 * 1000, // Max/thinking models may exceed 60s before answer
    }

    // 添加代理配置
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false // 禁用axios默认代理，使用httpsAgent
    }

    const chatType = body.chat_type || body.messages?.[0]?.chat_type || 't2t'
    // chat_mode 已由入口（middleware / anthropic builder）通过 resolveChatMode 解析，这里只读取
    const chatMode = body.chat_mode === 'local' ? 'local' : 'normal'
    const chat_id = options.chatId || await generateChatID(currentToken, body.model, currentAccount, chatType, chatMode)
    if (!chat_id) {
        return {
            status: false,
            response: null,
            message: '无法创建或续接 Qwen 会话'
        }
    }
    // 浏览器 referer 为 /c/<chat_id>（在 chat_id 生成后动态设置）；临时聊天为 /c/local
    requestConfig.headers.referer = `${chatBaseUrl}/c/${chatMode === 'local' ? 'local' : chat_id}`
    const url = `${chatBaseUrl}/api/v2/chat/completions?chat_id=` + chat_id
    // 对齐网页双写 chatId/parentId（FE 0.2.81）
    const parentId = options.parentId ?? body.parentId ?? body.parent_id ?? null
    const messages = Array.isArray(body.messages)
        ? body.messages.map(message => ({
            ...message,
            parent_id: parentId,
            parentId
        }))
        : body.messages
    const rawPayload = {
        ...body,
        stream: true,
        chat_id,
        chatId: chat_id,
        parent_id: parentId,
        parentId,
        messages
    }
    const contextResult = await externalizeOversizedAgentContext(
        rawPayload,
        currentToken,
        currentAccount
    )
    const payload = contextResult.payload
    if (contextResult.externalized) {
        logger.info(`Agent context exported as Qwen doc (original request ${contextResult.serializedBytes} bytes)`, 'REQUEST', '📎')
    } else if (contextResult.compacted) {
        logger.warn(`Agent context attachment failed, kept recent context (original request ${contextResult.serializedBytes} bytes)`, 'REQUEST')
    }

    const maxRetries = Math.max(0, parseInt(config.chatRetryCount, 10) || 0)
    const backoffMs = Math.max(0, parseInt(config.chatRetryBackoffMs, 10) || 0)
    const totalAttempts = maxRetries + 1

    let lastError = null
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        try {
            if (attempt === 1) {
                logger.network(`发送聊天请求`, 'REQUEST')
            }
            const response = await axios.post(url, payload, requestConfig)
            if (response.status === 200) {
                // 返回 currentAccount——调用方在消费完 stream 后据此累计 stats
                // 注意：当前实现单次尝试都用同一个 currentAccount（不轮换），
                // 如果未来 retry 切换账号，需要在切换处更新 currentAccount 引用
                return {
                    currentToken,
                    currentAccount,
                    chatId: chat_id,
                    parentId,
                    // 返回真正提交给 Qwen 的请求体。严格 Agent 回合纠正可直接复用
                    // 已外置的上下文附件，避免每次纠正都重新上传同一份长历史。
                    requestBody: payload,
                    status: true,
                    response: response.data
                }
            }
            // 非 200 但是没抛——退出循环, 走下面错误分类
            lastError = new Error(`Unexpected status ${response.status}`)
            lastError.response = { status: response.status }
            break
        } catch (error) {
            lastError = error
            if (isRetryableNetworkError(error) && attempt < totalAttempts) {
                logger.warn(
                    `聊天请求传输错误 (尝试 ${attempt}/${totalAttempts}, code=${error.code || 'unknown'}): ${error.message}`,
                    'REQUEST'
                )
                if (backoffMs > 0) {
                    await delay(backoffMs)
                }
                continue
            }
            // 不可重试 (有 HTTP 响应) 或重试已耗尽 — 退出
            break
        }
    }

    // 所有尝试失败 — 分类错误
    if (lastError && currentAccount?.email) {
        const hadHttpResponse = !!lastError.response
        if (!hadHttpResponse && isRetryableNetworkError(lastError)) {
            // 传输层失败耗尽重试——记 failure，累计可触发 cooldown（PR #112 语义）
            logger.error(
                `聊天请求传输失败 (已尝试 ${totalAttempts} 次): ${lastError.message}`,
                'REQUEST'
            )
            logger.info(
                `账户 ${currentAccount.email} 标记失败 (传输错误, 累计接近 cooldown)`,
                'ACCOUNT',
                '⏳'
            )
            accountManager.recordAccountFailure(currentAccount.email, lastError.code)
        } else {
            // HTTP 4xx/5xx (上游主动拒绝, 账户有效) — 仅刷新 warn 指示, 不影响 cooldown
            const status = lastError.response?.status
            logger.error('Failed to send chat request', 'REQUEST', '', lastError.message)
            accountManager.recordAccountError(currentAccount.email, status)
        }
    } else if (lastError) {
        logger.error('Failed to send chat request', 'REQUEST', '', lastError.message)
    }

    return {
        status: false,
        response: null
    }
}

/**
 * 生成chat_id
 * @param {string} currentToken
 * @param {string} model
 * @param {Object} [account] - 当前账户对象（用于解析账号级代理）
 * @param {string} [chatType] - 聊天类型（t2t 等）
 * @param {string} [chatMode] - 聊天模式：'local'（临时聊天）或 'normal'
 * @returns {Promise<string|null>} 返回生成的chat_id，如果失败则返回null
 */
const generateChatID = async (currentToken, model, account, chatType = 't2t', chatMode = 'normal') => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent(account)

        const requestConfig = {
            headers: {
                'sec-ch-ua-platform': '"Windows"',
                'referer': `${chatBaseUrl}/c/${chatMode === 'local' ? 'local' : 'new-chat'}`,
                'accept-language': 'zh-CN,zh;q=0.9',
                'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                'content-type': 'application/json',
                'accept': 'application/json, text/plain, */*',
                'accept-encoding': 'gzip, deflate, br, zstd',
                // WAF 客户端标识头
                'source': 'web',
                'version': '0.2.81',
                'timezone': getTimezoneHeader(),
                'x-request-id': generateUUID(),
                'connection': 'keep-alive',
                // Cookie: JWT token + SSXMOD 反爬链
                'cookie': `token=${currentToken};ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
                'host': chatBaseUrl.replace('https://', ''),
                'origin': chatBaseUrl,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
            }
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        // 对齐 chat.qwen.ai FE 0.2.81：chatId/project_id + chat_mode
        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
            chatId: '',
            models: [model],
            project_id: '',
            timestamp: Date.now(),
            chat_type: chatType || 't2t',
            chat_mode: chatMode === 'local' ? 'local' : 'normal'
        }, requestConfig)

        return response_data.data?.data?.id || null

    } catch (error) {
        logger.error('Failed to generate chat_id', 'CHAT', '', error.message)
        return null
    }
}

module.exports = {
    sendChatRequest,
    generateChatID,
    buildAgentContextLivePrompt,
    compactAgentContextFallback,
    externalizeOversizedAgentContext
}
