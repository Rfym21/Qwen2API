const axios = require('axios')
const { logger } = require('../utils/logger')
const accountManager = require('../utils/account')
const { getProxyAgent, getCliBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')

/**
 * 静默累计 CLI daily stats——异常不影响响应
 * @param {string} email - 账户邮箱
 * @param {Object} usage - upstream usage { prompt_tokens, completion_tokens }
 */
const attributeCliUsage = (email, usage) => {
    if (!email) return
    try {
        accountManager.accumulateStats(email, 'cli', {
            calls: 1,
            input: Number(usage?.prompt_tokens) || 0,
            output: Number(usage?.completion_tokens) || 0
        })
    } catch (e) {
        // 静默
    }
}

const MODEL_REDIRECT = {
    'qwen3.5-plus': 'coder-model',
}

const CLI_UNSUPPORTED_FIELDS = new Set([
    'frequency_penalty',
    'presence_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'n',
    'seed',
    'service_tier',
    'user'
])
const CLI_DEFAULT_SYSTEM_PART = {
    type: 'text',
    text: '',
    cache_control: {
        type: 'ephemeral'
    }
}

function pruneCliPayload(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => pruneCliPayload(item))
            .filter(item => item !== undefined)
    }

    if (value && typeof value === 'object') {
        const nextObject = {}

        for (const [key, item] of Object.entries(value)) {
            if (CLI_UNSUPPORTED_FIELDS.has(key)) {
                continue
            }

            const nextValue = pruneCliPayload(item)
            if (nextValue === undefined) {
                continue
            }

            if (Array.isArray(nextValue) && nextValue.length === 0 && key !== 'messages') {
                continue
            }

            if (
                nextValue &&
                typeof nextValue === 'object' &&
                !Array.isArray(nextValue) &&
                Object.keys(nextValue).length === 0
            ) {
                continue
            }

            nextObject[key] = nextValue
        }

        return nextObject
    }

    if (value === null || value === undefined) {
        return undefined
    }

    return value
}

function isInjectedSystemPart(part) {
    return Boolean(
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        part.cache_control &&
        part.cache_control.type === 'ephemeral' &&
        typeof part.text === 'string'
    )
}

function makeCliTextPart(text) {
    return {
        type: 'text',
        text: typeof text === 'string' ? text : String(text ?? '')
    }
}

function appendCliSystemContent(systemParts, content) {
    if (content === undefined || content === null) {
        return
    }

    if (Array.isArray(content)) {
        for (const item of content) {
            appendCliSystemContent(systemParts, item)
        }
        return
    }

    if (typeof content === 'string') {
        systemParts.push(makeCliTextPart(content))
        return
    }

    if (typeof content === 'object') {
        if (isInjectedSystemPart(content)) {
            return
        }

        if (typeof content.text === 'string' && content.type === 'text') {
            systemParts.push(content)
            return
        }

        systemParts.push(content)
        return
    }

    systemParts.push(makeCliTextPart(content))
}

function ensureCliSystemMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages
    }

    const systemParts = [JSON.parse(JSON.stringify(CLI_DEFAULT_SYSTEM_PART))]
    const nonSystemMessages = []

    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue
        }

        const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
        if (role === 'system') {
            appendCliSystemContent(systemParts, message.content)
            continue
        }

        nonSystemMessages.push(message)
    }

    return [
        {
            role: 'system',
            content: systemParts
        },
        ...nonSystemMessages
    ]
}

/**
 * 读取流响应体为文本
 * @param {*} stream - 响应流
 * @returns {Promise<string>} 文本结果
 */
function readStreamBody(stream) {
    return new Promise((resolve, reject) => {
        if (!stream || typeof stream.on !== 'function') {
            resolve('')
            return
        }

        const chunks = []
        stream.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        })
        stream.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'))
        })
        stream.on('error', reject)
    })
}

/**
 * 尝试解析 CLI 错误详情
 * @param {*} data - 原始响应体
 * @returns {Promise<*>} 可序列化的详情
 */
async function normalizeCliErrorDetails(data) {
    if (data && typeof data.on === 'function') {
        const rawText = await readStreamBody(data)
        if (!rawText) {
            return ''
        }

        try {
            return JSON.parse(rawText)
        } catch (error) {
            return rawText
        }
    }

    if (Buffer.isBuffer(data)) {
        const rawText = data.toString('utf8')
        try {
            return JSON.parse(rawText)
        } catch (error) {
            return rawText
        }
    }

    return data
}

/**
 * 构造 CLI 错误日志上下文
 * @param {Error} error - 错误对象
 * @returns {Promise<object>} 日志上下文
 */
async function buildCliAxiosErrorLog(error) {
    return {
        message: error?.message,
        code: error?.code,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        details: await normalizeCliErrorDetails(error?.response?.data)
    }
}

function preprocessCliRequestBody(rawBody) {
    const clonedBody = rawBody && typeof rawBody === 'object' ? JSON.parse(JSON.stringify(rawBody)) : {}
    const body = pruneCliPayload(clonedBody) || {}

    if (body.model && MODEL_REDIRECT[body.model]) {
        body.model = MODEL_REDIRECT[body.model]
    }
    if (Array.isArray(body.messages) && body.messages.length > 0) {
        body.messages = ensureCliSystemMessage(body.messages)
    }
    if (body.stream_options && typeof body.stream_options === 'object' && Object.keys(body.stream_options).length === 0) {
        delete body.stream_options
    }

    return body
}

function formatCliJsonResponse(data, fallbackModel) {
    if (!data || typeof data !== 'object') {
        return data
    }
    if (!data.object) {
        data.object = 'chat.completion'
    }
    if (!data.model && fallbackModel) {
        data.model = fallbackModel
    }
    if (!Array.isArray(data.choices)) {
        data.choices = []
    }
    return data
}

/**
 * 处理CLI聊天完成请求（支持OpenAI格式的流式和JSON响应）
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 */
const handleCliChatCompletion = async (req, res) => {
    try {
        const access_token = req.account.cli_info.access_token
        const body = preprocessCliRequestBody(req.body)
        const isStream = body.stream === true

        // 打印当前使用的账号邮箱
        logger.info(`CLI请求使用账号[${req.account.email}]开始处理`, 'CLI', '🚀')

        // 无论成功失败都增加请求计数
        req.account.cli_info.request_number++

        const cliBaseUrl = getCliBaseUrl()
        const proxyAgent = getProxyAgent(req.account)

        // 设置请求配置
        const axiosConfig = {
            method: 'POST',
            url: `${cliBaseUrl}/v1/chat/completions`,
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json',
                'Accept': isStream ? 'text/event-stream' : 'application/json',
                'User-Agent': 'QwenCode/0.10.3 (darwin; arm64)',
                'X-Dashscope-Useragent': 'QwenCode/0.10.3 (darwin; arm64)',
                'X-Stainless-Runtime-Version': 'v22.17.0',
                'Sec-Fetch-Mode': 'cors',
                'X-Stainless-Lang': 'js',
                'X-Stainless-Arch': 'arm64',
                'X-Stainless-Package-Version': '5.11.0',
                'X-Dashscope-Cachecontrol': 'enable',
                'X-Stainless-Retry-Count': '0',
                'X-Stainless-Os': 'MacOS',
                'X-Dashscope-Authtype': 'qwen-oauth',
                'X-Stainless-Runtime': 'node'
            },
            data: body,
            timeout: 5 * 60 * 1000,
            validateStatus: function () {
                return true
            }
        }

        // 添加代理配置
        if (proxyAgent) {
            axiosConfig.httpsAgent = proxyAgent
            axiosConfig.proxy = false
        }

        // 如果是流式请求，设置响应类型为流
        if (isStream) {
            axiosConfig.responseType = 'stream'

            // 设置响应头为流式
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Headers', '*')
        }

        const response = await axios(axiosConfig)

        // 检查响应状态
        if (response.status !== 200) {
            const errorDetails = await normalizeCliErrorDetails(response.data)
            logger.error(`CLI请求使用账号[${req.account.email}]转发失败 - 状态码: ${response.status} - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '❌', {
                status: response.status,
                statusText: response.statusText,
                requestBody: body,
                details: errorDetails
            })
            // HTTP 4xx/5xx——仅刷新 warn 指示, 不影响 cooldown（账户本身有效, 是上游主动拒绝）
            accountManager.recordAccountError(req.account.email, response.status)
            return res.status(response.status).json({
                error: {
                    message: `api_error`,
                    type: 'api_error',
                    code: response.status,
                    details: errorDetails
                }
            })
        }

        // 处理流式响应
        if (isStream) {
            // 缓冲 SSE 解析——usage 帧可能跨 TCP 块（仅 split('\n\n') 会丢失），
            // 沿用 chat.js/anthropic.js 的 buffer + while indexOf('\n\n') 模式
            let sseBuffer = ''
            let cliUsage = null

            response.data.on('data', (chunk) => {
                const text = chunk.toString('utf8')
                // 透传客户端: 逐行回写，保持原有行为
                const lines = text.split('\n')
                for (const line of lines) {
                    if (!line || !line.startsWith('data:')) continue
                    res.write(`${line}\n\n`)
                }

                // 解析 usage 帧（带缓冲——帧可能被分块切开）
                sseBuffer += text
                let idx
                while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                    const frame = sseBuffer.slice(0, idx)
                    sseBuffer = sseBuffer.slice(idx + 2)
                    if (!frame.startsWith('data:')) continue
                    const payload = frame.slice(frame.indexOf(':') + 1).trim()
                    if (!payload || payload === '[DONE]') continue
                    try {
                        const parsed = JSON.parse(payload)
                        if (parsed?.usage) cliUsage = parsed.usage
                    } catch (e) {
                        // 部分/非法 JSON——继续累计
                    }
                }
            })

            // 处理流错误
            response.data.on('error', (streamError) => {
                logger.error(`CLI请求使用账号[${req.account.email}]流式传输失败 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '❌')
                // 传输错误——记 failure（影响 cooldown）
                accountManager.recordAccountFailure(req.account.email, streamError?.code)
                if (!res.headersSent) {
                    res.status(500).json({
                        error: {
                            message: 'stream_error',
                            type: 'stream_error',
                            code: 500
                        }
                    })
                }
            })

            // 处理流结束
            response.data.on('end', () => {
                logger.success(`CLI请求使用账号[${req.account.email}]转发成功 (流式) - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI')
                attributeCliUsage(req.account.email, cliUsage)
                res.end()
            })
        } else {
            // 处理JSON响应
            const cliUsage = response.data?.usage
            res.json(formatCliJsonResponse(response.data, body.model))
            logger.success(`CLI请求使用账号[${req.account.email}]转发成功 (JSON) - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI')
            attributeCliUsage(req.account.email, cliUsage)
        }
    } catch (error) {
        logger.error(`CLI请求使用账号[${req.account.email}]处理异常 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '💥', {
            requestBody: body,
            ...(await buildCliAxiosErrorLog(error))
        })
        // catch 路径——区分传输错误（cooldown）与 HTTP 错误（warn-only）
        if (error?.response) {
            accountManager.recordAccountError(req.account.email, error.response.status)
        } else {
            accountManager.recordAccountFailure(req.account.email, error?.code)
        }

        // 如果是axios错误，提供更详细的错误信息
        if (error.response) {
            const errorDetails = await normalizeCliErrorDetails(error.response.data)
            return res.status(error.response.status).json({
                error: {
                    message: "api_error",
                    type: 'api_error',
                    code: error.response.status,
                    details: errorDetails
                }
            })
        } else if (error.request) {
            return res.status(503).json({
                error: {
                    message: 'connection_error',
                    type: 'connection_error',
                    code: 503
                }
            })
        } else {
            return res.status(500).json({
                error: {
                    message: 'internal_error',
                    type: 'internal_error',
                    code: 500
                }
            })
        }
    }
}

module.exports = {
    handleCliChatCompletion
}
