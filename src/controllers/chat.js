const { isJson, generateUUID } = require('../utils/tools.js')
const { createUsageObject } = require('../utils/precise-tokenizer.js')
const { sendChatRequest } = require('../utils/request.js')
const { createToolCallStreamParser, parseToolCallsFromText } = require('../utils/tool-prompt.js')
const accountManager = require('../utils/account.js')
const config = require('../config/index.js')
const axios = require('axios')
const { logger } = require('../utils/logger')

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
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
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
        return `You did not call any tool in your previous reply. You MUST now call the tool \`${toolChoice.function.name}\` using the <tool_call>...</tool_call> format and nothing else.`
    }
    return 'You did not call any tool in your previous reply. You MUST now call exactly one tool using the <tool_call>...</tool_call> format and nothing else.'
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

const handleStreamResponse = async (res, response, enable_thinking, enable_web_search, requestBody = null, options = {}) => {
    try {
        const message_id = generateUUID()
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        let emittedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const toolChoice = options.tool_choice
        const toolParser = hasTools ? createToolCallStreamParser() : null

        // Token消耗量统计
        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
        let completionContent = '' // 收集完整的回复内容用于token估算

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
         * 写一个工具调用增量，按 OpenAI 规范分片：
         *   1) 头块：包含 index/id/type 与 function.name + 空 arguments
         *   2) 多个参数块：function.arguments 切片
         * @param {Array<Object>} calls - 已完成的工具调用列表
         */
        const writeToolCallsDelta = (calls) => {
            if (!calls || calls.length === 0) return
            const ARG_CHUNK_SIZE = 32

            for (const call of calls) {
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
                                        "index": call.index,
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
                                            "index": call.index,
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
            if (decodeJson === null || !decodeJson.choices || decodeJson.choices.length === 0) {
                return
            }

            if (decodeJson.usage) {
                totalTokens = {
                    prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                    completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                    total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                }
            }

            const delta = decodeJson.choices[0].delta

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

            if (!delta || !delta.content ||
                (delta.phase !== 'think' && delta.phase !== 'answer')) {
                return
            }

            let content = delta.content
            completionContent += content

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
        }

        /**
         * 把一个上游响应流接入解析与转发管线，等其结束
         * @param {object} upstreamResponse - axios stream 响应
         * @returns {Promise<void>} 流处理完成的 Promise
         */
        const pipeUpstream = (upstreamResponse) => new Promise((resolve, reject) => {
            const decoder = new TextDecoder('utf-8')
            let buffer = ''

            upstreamResponse.on('data', async (chunk) => {
                const decodeText = decoder.decode(chunk, { stream: true })
                buffer += decodeText

                const chunks = []
                let startIndex = 0

                while (true) {
                    const dataStart = buffer.indexOf('data: ', startIndex)
                    if (dataStart === -1) break
                    const dataEnd = buffer.indexOf('\n\n', dataStart)
                    if (dataEnd === -1) break
                    const dataChunk = buffer.substring(dataStart, dataEnd).trim()
                    chunks.push(dataChunk)
                    startIndex = dataEnd + 2
                }

                if (startIndex > 0) {
                    buffer = buffer.substring(startIndex)
                }

                for (const item of chunks) {
                    try {
                        await processSSEPayload(item.replace("data: ", ''))
                    } catch (error) {
                        logger.error('流式数据处理错误', 'CHAT', '', error)
                    }
                }
            })

            upstreamResponse.on('end', () => resolve())
            upstreamResponse.on('error', (err) => reject(err))
        })

        await pipeUpstream(response)

        // tool_choice="required" 强校验：未触发任何工具调用则追加更强提示重试一次
        if (hasTools && toolParser && !toolParser.hasEmittedAnyCall() && requiresToolCall(toolChoice)) {
            const retryHint = buildRequiredRetryHint(toolChoice)
            const retryBody = {
                ...requestBody,
                messages: [
                    ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
                    { role: 'system', content: retryHint }
                ]
            }
            logger.warning?.('tool_choice=required 首次未触发工具调用，进行一次重试', 'CHAT')
            try {
                const retryResp = await sendChatRequest(retryBody)
                if (retryResp.status && retryResp.response) {
                    await pipeUpstream(retryResp.response)
                }
            } catch (e) {
                logger.error('required 模式重试失败', 'CHAT', '', e)
            }
        }

        // flush 工具调用解析器中的残留内容
        if (toolParser) {
            const tail = toolParser.flush()
            if (tail.textDelta) writeContentDelta(tail.textDelta)
            if (tail.completedCalls.length > 0) writeToolCallsDelta(tail.completedCalls)
        }

        // 处理最终的搜索信息
        if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
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

        const finishReason = (toolParser && toolParser.hasEmittedAnyCall()) ? 'tool_calls' : 'stop'
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
        try { res.status(500).json({ error: "Service error" }) } catch (_) { /* response already started */ }
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
    try {
        let fullContent = ''
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        let appendedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const toolChoice = options.tool_choice

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
        const accumulateUpstream = (upstreamResponse) => new Promise((resolve, reject) => {
            const decoder = new TextDecoder('utf-8')
            let buffer = ''

            upstreamResponse.on('data', async (chunk) => {
                const decodeText = decoder.decode(chunk, { stream: true })
                buffer += decodeText

                const chunks = []
                let startIndex = 0

                while (true) {
                    const dataStart = buffer.indexOf('data: ', startIndex)
                    if (dataStart === -1) break
                    const dataEnd = buffer.indexOf('\n\n', dataStart)
                    if (dataEnd === -1) break
                    const dataChunk = buffer.substring(dataStart, dataEnd).trim()
                    chunks.push(dataChunk)
                    startIndex = dataEnd + 2
                }

                if (startIndex > 0) {
                    buffer = buffer.substring(startIndex)
                }

                for (const item of chunks) {
                    try {
                        const dataContent = item.replace("data: ", '')
                        const decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
                        if (decodeJson === null || !decodeJson.choices || decodeJson.choices.length === 0) {
                            continue
                        }

                        if (decodeJson.usage) {
                            totalTokens = {
                                prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                                completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                                total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                            }
                        }

                        const delta = decodeJson.choices[0].delta

                        if (delta && delta.name === 'web_search') {
                            web_search_info = delta.extra.web_search_info
                        }

                        const imageMarkdownList = getImageMarkdownListFromDelta(delta)
                        if (imageMarkdownList.length > 0) {
                            const newImageMarkdownList = imageMarkdownList.filter(it => !appendedImageMarkdownSet.has(it))

                            if (thinking_start && !thinking_end) {
                                for (const imageMarkdown of newImageMarkdownList) {
                                    if (!pendingImageMarkdownList.includes(imageMarkdown)) {
                                        pendingImageMarkdownList.push(imageMarkdown)
                                    }
                                }
                            } else if (newImageMarkdownList.length > 0) {
                                fullContent += `${newImageMarkdownList.join('\n\n')}\n\n`
                                newImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                            }
                        }

                        if (!delta || !delta.content ||
                            (delta.phase !== 'think' && delta.phase !== 'answer')) {
                            continue
                        }

                        let content = delta.content

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
                    } catch (error) {
                        logger.error('非流式数据处理错误', 'CHAT', '', error)
                    }
                }
            })

            upstreamResponse.on('end', () => resolve())
            upstreamResponse.on('error', (err) => {
                logger.error('非流式响应流读取错误', 'CHAT', '', err)
                reject(err)
            })
        })

        await accumulateUpstream(response)

        // 工具调用解析：从 fullContent 抽取 <tool_call> 块
        let assistantContent = fullContent
        let toolCalls = []
        if (hasTools) {
            const parsed = parseToolCallsFromText(fullContent)
            assistantContent = parsed.cleanedText
            toolCalls = parsed.toolCalls
        }

        // tool_choice="required" 强校验：未触发则重试一次
        if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)) {
            const retryHint = buildRequiredRetryHint(toolChoice)
            const retryBody = {
                ...requestBody,
                messages: [
                    ...(Array.isArray(requestBody?.messages) ? requestBody.messages : []),
                    { role: 'system', content: retryHint }
                ]
            }
            logger.warning?.('tool_choice=required 首次未触发工具调用，进行一次重试', 'CHAT')
            try {
                const retryResp = await sendChatRequest(retryBody)
                if (retryResp.status && retryResp.response) {
                    const before = fullContent
                    await accumulateUpstream(retryResp.response)
                    const retriedText = fullContent.slice(before.length)
                    const parsedRetry = parseToolCallsFromText(retriedText)
                    if (parsedRetry.toolCalls.length > 0) {
                        toolCalls = parsedRetry.toolCalls
                        assistantContent = (parseToolCallsFromText(fullContent).cleanedText)
                    }
                }
            } catch (e) {
                logger.error('required 模式重试失败', 'CHAT', '', e)
            }
        }

        // 处理最终的搜索信息
        if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            assistantContent += `\n\n---\n${webSearchTable}`
        }

        // 计算最终的token使用量
        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || promptText, fullContent, null)
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
                    "finish_reason": toolCalls.length > 0 ? "tool_calls" : "stop"
                }
            ],
            "usage": totalTokens
        }
        res.json(bodyTemplate)
    } catch (error) {
        logger.error('非流式聊天处理错误', 'CHAT', '', error)
        res.status(500)
            .json({
                error: "Service error"
            })
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
                    error: "Request failed"
                })
            return
        }

        if (stream) {
            setResponseHeaders(res, true)
            await handleStreamResponse(res, response_data.response, enable_thinking, enable_web_search, req.body, { has_tools: req.has_tools, tool_choice: req.tool_choice, currentAccount: response_data.currentAccount })
        } else {
            setResponseHeaders(res, false)
            await handleNonStreamResponse(res, response_data.response, enable_thinking, enable_web_search, model, req.body, { has_tools: req.has_tools, tool_choice: req.tool_choice, currentAccount: response_data.currentAccount })
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
    setResponseHeaders
}
