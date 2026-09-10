const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getSsxmodForAccount } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl } = require('./proxy-helper')
const { generateUUID, jitter } = require('./tools.js')
const { uploadAgentContextFile } = require('./upload.js')
const { buildRequestHeaders } = require('./header-profile')
const { TOOL_CALL_OPEN, LEDGER_HEADER, LEDGER_CAPTION, truncateToolHistoryLedger } = require('./agent-turn.js')

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
// Techo del ledger dentro del presupuesto inline. Ver buildBudgetedAgentPrompt.
const LEDGER_POOL_SHARE = 0.25

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

// El ledger de llamadas ya ejecutadas (buildToolHistoryLedger) viaja pegado al FINAL del
// prefijo: lo montan asi controllers/anthropic.js#buildInternalRequest y
// middlewares/chat-middleware.js#processRequestBody, en ese orden fijo.
//
// Se separa del prefijo aqui, y no es cosmetico. El prefijo se recorta por CABEZA Y COLA
// (headRatio 0.55) y el bloque va del mas NUEVO al mas VIEJO, asi que dentro del prefijo
// la rebanada de cola conserva sus entradas mas viejas y el hueco compactado se lleva las
// mas nuevas — justo la llamada que el modelo esta a punto de repetir, que es la unica
// razon por la que el bloque existe. Con el tope en 6000 B el bloque cabia entero en esa
// cola por casualidad aritmetica; a 12000 ya no. El tope volvio a 6000 (ver el porque en
// agent-turn.js#buildToolHistoryLedger), pero la seccion propia SE QUEDA: la casualidad
// aritmetica no es una garantia, y lo que arregla es el ORDEN de lo que sobrevive — las
// entradas MAS NUEVAS, que es la unica propiedad que el bloque no puede perder. Medido
// sobre 48 sobres externalizados
// (94-384 KB, 8-60 herramientas, 30-120 llamadas): dentro del prefijo sobrevivian 23-24
// entradas de las 30-37 del bloque y en 44 de los 48 la MAS NUEVA no llegaba; en seccion
// propia llegan los 48 de 48 enteros. tests/tool-repetition.test.js lo clava.
//
// Se reconocen las DOS primeras lineas del bloque, no solo la cabecera, y a principio de
// linea. La cabecera sola es una frase corriente: un system prompt del cliente que
// empezara una linea con ella se llevaba el trato del ledger y, si no cabia en su cuota,
// desaparecia entero — 11,8 KB de reglas borradas del prompt inline, medido. La leyenda
// es una frase fija y larga, y un renglon del propio bloque no puede forjar ninguna de
// las dos: van colapsados a una linea y prefijados con `#n `. Se toma la ULTIMA aparicion
// porque el bloque es la ultima parte del prefijo.
const LEDGER_BLOCK_START = `${LEDGER_HEADER}\n${LEDGER_CAPTION}`

// Tercer requisito, ademas de las dos lineas: el renglon siguiente tiene que ser una
// ENTRADA (`#<n> `), que es lo que buildToolHistoryLedger emite siempre — devuelve ''
// antes que un bloque sin ninguna. Sin esta comprobacion, un texto del cliente que
// reprodujera cabecera + leyenda —copiar el prompt del proxy en las propias reglas no es
// raro— se llevaba el trato del ledger, y como no tiene ningun renglon `#n ` el recorte
// por renglones lo dejaba en ''. Medido: 11,9 KB de reglas del cliente BORRADAS del
// prompt inline. Con las tres condiciones forjarlo pide la leyenda literal de 137 bytes y
// ademas una linea con forma de entrada, y aun asi solo se auto-recorta.
const startsLedgerBlock = (candidate) => (
    candidate.startsWith(LEDGER_BLOCK_START) &&
    /^#\d+ /.test(candidate.slice(LEDGER_BLOCK_START.length + 1).split('\n', 1)[0])
)

const splitAgentLedger = (prefix) => {
    const text = String(prefix || '')
    // Se toma la ULTIMA aparicion porque el bloque es la ultima parte del prefijo; si el
    // cliente tuviera una copia mas arriba, la de verdad sigue ganando.
    let at = -1
    if (text.startsWith(LEDGER_BLOCK_START)) at = 0
    else {
        const found = text.lastIndexOf(`\n${LEDGER_BLOCK_START}`)
        if (found >= 0) at = found + 1
    }
    if (at < 0) return { prefix: text, ledger: '' }
    const candidate = text.slice(at).trim()
    if (!startsLedgerBlock(candidate)) return { prefix: text, ledger: '' }
    return { prefix: text.slice(0, at).trim(), ledger: candidate }
}

const parseAgentEnvelope = (value) => {
    const text = String(value || '')
    const historyIndex = text.indexOf(HISTORY_MARKER)
    const currentIndex = text.lastIndexOf(CURRENT_MESSAGE_MARKER)
    if (historyIndex < 0) {
        if (currentIndex >= 0) {
            return {
                ...splitAgentLedger(text.slice(0, currentIndex).trim()),
                history: '',
                current: text.slice(currentIndex).trim(),
                entries: []
            }
        }
        return { ...splitAgentLedger(text), history: '', current: '', entries: [] }
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
        ...splitAgentLedger(text.slice(0, historyIndex).trim()),
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
        // 和 foldToolMessages 的结果分隔符锁步：[TOOL RESULT: …] 是当前写法，
        // <tool_response …> 是旧写法 —— 换分隔符时半路上的历史里两种都在，都要认。
        !/^\s*\[tool[_ ]result\b/i.test(entry.content) &&
        !/^\s*\[end tool result\]/i.test(entry.content) &&
        !/^\s*<tool_response\b/i.test(entry.content)
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

    // 从最新往回**填满**预算，而不是固定留 5 条。
    //
    // 旧写法写死 `slice(length - 4, -1)` + 最后一条 = 恒定 5 条，预算给多少都一样。
    // 于是上面那套按权重分配的预算对这一段毫无作用：49152 字节的上限只用掉个位数百分比，
    // 而模型丢掉的是它继续任务所需要的历史。整条保留，不做半截截断 —— JSONL 的一行被
    // 拦腰砍断既不可解析，也比没有更容易误导。
    const chosen = []
    let used = 0
    for (let i = entries.length - 1; i >= 0; i--) {
        const raw = entries[i].raw
        const cost = byteLength(raw) + (chosen.length > 0 ? 1 : 0)
        if (used + cost > limit) break
        chosen.unshift(raw)
        used += cost
    }
    // 连最新的一条都放不下时退回旧行为：把它头尾截断塞进整个预算，绝不返回空。
    if (chosen.length === 0) return truncateUtf8HeadTail(latest, limit, 0.4, compactionSeparator)
    // 有内容被丢掉时留个记号，模型才知道自己看到的不是全部。
    const dropped = entries.length - chosen.length
    return dropped > 0
        ? `${compactionSeparator.trim()}\n${chosen.join('\n')}`
        : chosen.join('\n')
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
        // Peso 0: no entra en el reparto por pesos, se reserva antes (ver abajo).
        { header: '', value: envelope.ledger, weight: 0, headRatio: 1, kind: 'ledger' },
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

    const pool = max - fixedBytes
    const compactionSeparator = attachmentAvailable
        ? '\n...[inline context compacted; complete copy is in the attachment]...\n'
        : '\n...[older inline context compacted after attachment recovery failed]...\n'

    // 两趟分配。
    //
    // 旧写法是一趟：`remainingBytes -= budget` 减掉的是**配额**而不是实际用量，所以一个
    // 内容很小的 section 会把自己没用完的额度一并吞掉；而剩下的字节最后落在**最后一个**
    // section（current，不可伸缩、通常很短）上，直接死掉。真正能无限吸收历史的 recent
    // 排在第三位，永远吃不到这些剩余。实测：49152 字节的上限只用掉 19.8%。
    //
    // 第一趟：每个 section 拿「按权重的配额」和「它实际需要的量」里更小的那个。
    // 第二趟：把剩余按**弹性顺序**发出去 —— recent 先拿，它能把更多历史留在行内。
    const naturalBytes = sections.map(section => byteLength(section.value))

    // El ledger se sirve ANTES del reparto por pesos, y por una razon distinta a las demas
    // secciones: es pequeno, esta acotado en origen (6000 B) y ya sabe degradar solo, con
    // renglones enteros y su nota de omision. Darle un peso lo dejaria a merced del reparto
    // — con el pool tipico, un 8% son 3872 B y el bloque saldria recortado siempre — y
    // meterlo en el prefijo es lo que rompio la version anterior de esto.
    //
    // El tope de un cuarto del pool no es para produccion: con los 48 KiB por defecto el
    // pool son ~48400 B y el bloque entero (<=6000) cabe con holgura. Existe para que un
    // AGENT_CONTEXT_LIVE_PROMPT_BYTES pequeno no deje al resto sin sitio; ahi el bloque se
    // recorta por renglones, conservando los MAS NUEVOS, que es lo que se pedia.
    const ledgerIndex = sections.findIndex(section => section.kind === 'ledger')
    const ledgerBudget = ledgerIndex >= 0
        ? Math.min(naturalBytes[ledgerIndex], Math.floor(pool * LEDGER_POOL_SHARE))
        : 0
    const weightedPool = pool - ledgerBudget

    // `|| 1` solo para el caso degenerado en que el ledger sea la unica seccion viva: sin
    // el, `x / 0` meteria un NaN en un presupuesto.
    const totalWeight = sections.reduce((sum, section) => sum + section.weight, 0) || 1
    const budgets = sections.map((section, index) => (
        section.kind === 'ledger'
            ? ledgerBudget
            : Math.min(
                Math.floor(weightedPool * section.weight / totalWeight),
                naturalBytes[index]
            )
    ))
    let surplus = pool - budgets.reduce((sum, value) => sum + value, 0)
    const byElasticity = sections
        .map((section, index) => index)
        .sort((a, b) => (sections[b].kind === 'recent' ? 1 : 0) - (sections[a].kind === 'recent' ? 1 : 0))
    for (const index of byElasticity) {
        if (surplus <= 0) break
        const want = naturalBytes[index] - budgets[index]
        if (want <= 0) continue
        const give = Math.min(want, surplus)
        budgets[index] += give
        surplus -= give
    }

    const rendered = sections.map((section, index) => {
        const budget = budgets[index]
        if (section.kind === 'ledger') return truncateToolHistoryLedger(section.value, budget)
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

    return [notice, ...rendered].filter(Boolean).join(joinSeparator)
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
        `When an available tool is needed, emit the real \`${TOOL_CALL_OPEN}\` block immediately. Do not replace it with prose such as “I will run...” or “done”.`
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
        logger.error('Agent 长上下文附件上传/解析失败，回退到最近上下文', 'REQUEST', '', error)
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

    // Antidetect: per-account fingerprint headers replace static block
    const ssxmod = getSsxmodForAccount(currentAccount)
    const headers = buildRequestHeaders(currentAccount, {
        chatBaseUrl,
        token: currentToken,
        ssxmodItna: ssxmod.ssxmod_itna,
        ssxmodItna2: ssxmod.ssxmod_itna2,
        accept: 'application/json',
        extra: {
            'x-request-id': generateUUID(),
            'x-accel-buffering': 'no'
        }
    })

    // 构建请求配置（与通义千问 React Web 客户端完全一致，对齐 FE 0.2.81）
    const requestConfig = {
        headers,
        responseType: 'stream', // Always use streaming (upstream doesn't support stream=false)
        timeout: 10 * 60 * 1000, // Max/thinking models may exceed 60s before answer
    }

    // 添加代理配置
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false // 禁用axios默认代理，使用httpsAgent
    }

    const chatType = body.chat_type || body.messages?.[0]?.chat_type || 't2t'
    const chat_id = options.chatId || await generateChatID(currentToken, body.model, currentAccount, chatType)
    if (!chat_id) {
        return {
            status: false,
            response: null,
            message: '无法创建或续接 Qwen 会话'
        }
    }
    // 浏览器 referer 为 /c/<chat_id>（在 chat_id 生成后动态设置）
    requestConfig.headers.referer = `${chatBaseUrl}/c/${chat_id}`
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
        logger.info(`Agent 上下文已外置为 Qwen 文档（原请求 ${contextResult.serializedBytes} bytes）`, 'REQUEST', '📎')
    } else if (contextResult.compacted) {
        logger.warn(`Agent 上下文附件失败，已保留最近上下文（原请求 ${contextResult.serializedBytes} bytes）`, 'REQUEST')
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
                    // 上下文被静默削减时，调用方必须能告诉客户端。附件失败的回退把
                    // ~1MB 的上下文压成几十 KB 却照样返回 200：没有这两个字段，
                    // 客户端拿到的是一个「成功」的回答，而模型其实只看到了一小片。
                    contextCompacted: contextResult.compacted === true,
                    contextExternalized: contextResult.externalized === true,
                    contextSerializedBytes: contextResult.serializedBytes,
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
                    await delay(jitter(backoffMs))
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
            logger.error('发送聊天请求失败', 'REQUEST', '', lastError.message)
            accountManager.recordAccountError(currentAccount.email, status)
        }
    } else if (lastError) {
        logger.error('发送聊天请求失败', 'REQUEST', '', lastError.message)
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
 * @returns {Promise<string|null>} 返回生成的chat_id，如果失败则返回null
 */
const generateChatID = async (currentToken, model, account, chatType = 't2t') => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent(account)

        // Antidetect: per-account fingerprint headers replace static block
        const ssxmod = getSsxmodForAccount(account)
        const headers = buildRequestHeaders(account, {
            chatBaseUrl,
            token: currentToken,
            ssxmodItna: ssxmod.ssxmod_itna,
            ssxmodItna2: ssxmod.ssxmod_itna2,
            accept: 'application/json, text/plain, */*',
            refererPath: '/c/new-chat',
            extra: {
                'x-request-id': generateUUID()
            }
        })

        const requestConfig = {
            headers
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        // 对齐 chat.qwen.ai FE 0.2.81：chatId/project_id + normal 模式
        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
            chatId: '',
            models: [model],
            project_id: '',
            timestamp: Date.now(),
            chat_type: chatType || 't2t',
            chat_mode: 'normal'
        }, requestConfig)

        return response_data.data?.data?.id || null

    } catch (error) {
        logger.error('生成chat_id失败', 'CHAT', '', error.message)
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
