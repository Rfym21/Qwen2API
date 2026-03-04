const axios = require('axios')
const { logger } = require('../utils/logger')
const { getProxyAgent, getCliBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')

const MODEL_REDIRECT = {
    'qwen3.5-plus': 'coder-model',
}

function preprocessCliRequestBody(rawBody) {
    const body = rawBody && typeof rawBody === 'object' ? JSON.parse(JSON.stringify(rawBody)) : {}

    if (body.model && MODEL_REDIRECT[body.model]) {
        body.model = MODEL_REDIRECT[body.model]
    }
    const isStream = body.stream === true

    if (isStream) {
        const hasToolsArray = Array.isArray(body.tools)
        if (!hasToolsArray || body.tools.length === 0) {
            body.tools = [{
                type: 'function',
                function: {
                    name: 'do_not_call_me',
                    description: 'Do not call this tool.',
                    parameters: {
                        type: 'object',
                        properties: {
                            operation: { type: 'number', description: 'placeholder' }
                        },
                        required: ['operation']
                    }
                }
            }]
        }

        if (!body.stream_options || typeof body.stream_options !== 'object') {
            body.stream_options = {}
        }
        body.stream_options.include_usage = true
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
        const proxyAgent = getProxyAgent()

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
            logger.error(`CLI请求使用账号[${req.account.email}]转发失败 - 状态码: ${response.status} - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '❌')
            return res.status(response.status).json({
                error: {
                    message: `api_error`,
                    type: 'api_error',
                    code: response.status,
                    details: response.data
                }
            })
        }

        // 处理流式响应
        if (isStream) {
            // 逐行转发，确保始终输出标准 SSE 片段
            response.data.on('data', (chunk) => {
                const text = chunk.toString('utf8')
                const lines = text.split('\n')
                for (const line of lines) {
                    if (!line || !line.startsWith('data:')) continue
                    res.write(`${line}\n\n`)
                }
            })

            // 处理流错误
            response.data.on('error', (streamError) => {
                logger.error(`CLI请求使用账号[${req.account.email}]流式传输失败 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '❌')
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
                res.end()
            })
        } else {
            // 处理JSON响应
            res.json(formatCliJsonResponse(response.data, body.model))
            logger.success(`CLI请求使用账号[${req.account.email}]转发成功 (JSON) - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI')
        }
    } catch (error) {
        logger.error(`CLI请求使用账号[${req.account.email}]处理异常 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '💥', error.message)

        // 如果是axios错误，提供更详细的错误信息
        if (error.response) {
            return res.status(error.response.status).json({
                error: {
                    message: "api_error",
                    type: 'api_error',
                    code: error.response.status,
                    details: error.response.data
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
