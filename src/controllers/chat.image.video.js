const axios = require('axios')
const { logger } = require('../utils/logger.js')
const { setResponseHeaders } = require('./chat.js')
const accountManager = require('../utils/account.js')
const { sleep } = require('../utils/tools.js')
const { generateChatID } = require('../utils/request.js')
const { uploadFileToQwenOss } = require('../utils/upload.js')
const { parserModel } = require('../utils/chat-helpers.js')
const { getDefaultModelByChatType } = require('../models/models-map.js')
const { getSsxmodItna, getSsxmodItna2 } = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')

const DATA_URI_REGEX = /^data:(.+);base64,(.*)$/i
const HTTP_URL_REGEX = /^https?:\/\//i

/**
 * 构造与当前账号一致的上游 Cookie 头
 * @param {string} token - 当前账号令牌
 * @returns {string} Cookie 头
 */
const buildUpstreamCookieHeader = (token) => {
    const cookieParts = []

    if (token) {
        cookieParts.push(`token=${token}`)
    }

    const ssxmodItna = getSsxmodItna()
    const ssxmodItna2 = getSsxmodItna2()

    if (ssxmodItna) {
        cookieParts.push(`ssxmod_itna=${ssxmodItna}`)
    }

    if (ssxmodItna2) {
        cookieParts.push(`ssxmod_itna2=${ssxmodItna2}`)
    }

    return cookieParts.join('; ')
}

/**
 * 将上游响应体格式化为便于日志输出的对象
 * @param {*} payload - 原始响应体
 * @returns {*} 可序列化的日志对象
 */
const formatPayloadForLog = (payload) => {
    if (payload === undefined) {
        return null
    }

    if (Buffer.isBuffer(payload)) {
        return payload.toString('utf-8')
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return ''
        }

        try {
            return JSON.parse(trimmedPayload)
        } catch (e) {
            return trimmedPayload.slice(0, 4000)
        }
    }

    if (typeof payload === 'object' && payload !== null) {
        if (typeof payload.on === 'function') {
            return '[stream]'
        }
        return payload
    }

    return payload
}

/**
 * 提取 Axios 错误的完整日志上下文
 * @param {Error} error - Axios 错误对象
 * @returns {object} 日志上下文
 */
const buildAxiosErrorLog = (error) => ({
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    headers: error?.response?.headers,
    data: formatPayloadForLog(error?.response?.data)
})

const parseUpstreamImageError = (data) => {
    try {
        const rawPayload = formatPayloadForLog(data)
        let payload = data

        if (Array.isArray(payload) && payload.length > 0) {
            payload = payload[0]
        }

        if (typeof payload === 'string') {
            payload = JSON.parse(payload)
        }

        // 只有明确 success=false 且带错误码时，才按上游错误包处理，避免误伤正常业务响应
        if (!payload || payload.success !== false || !payload.data?.code) {
            return null
        }

        const errorData = payload.data
        if (errorData.code === 'RateLimited') {
            const waitHours = errorData.num
            logger.error(`图片/视频生成额度已用尽，需等待约 ${waitHours || '未知'} 小时`, 'CHAT', '', {
                parsed_error: errorData,
                raw_response_body: rawPayload
            })
            return {
                error: `当前账号的该功能使用次数已达上限，${waitHours ? `请等待约 ${waitHours} 小时后再试` : '请稍后再试'}`,
                code: errorData.code,
                wait_hours: waitHours,
                status: 429
            }
        }

        logger.error('请求上游服务时出现错误', 'CHAT', '', {
            parsed_error: errorData,
            raw_response_body: rawPayload
        })
        return {
            error: errorData.details || errorData.code || 'Service error, please try again later',
            code: errorData.code,
            request_id: payload.request_id,
            status: errorData.code === 'Bad_Request' && /internal error/i.test(errorData.details || '') ? 502 : 500
        }
    } catch (e) {
        return null
    }
}

const parseUpstreamImageErrorFromText = (text) => {
    try {
        if (!text || typeof text !== 'string') {
            return null
        }

        // 图片接口在额度耗尽时可能返回普通 JSON 文本而不是 SSE，需要在流结束后补做一次识别
        return parseUpstreamImageError(JSON.parse(text))
    } catch (e) {
        return null
    }
}

/**
 * 收集对象中的所有值
 * @param {*} payload - 任意负载
 * @param {Set<object>} visited - 已访问对象集合
 * @returns {Array<*>} 所有嵌套值
 */
const collectNestedValues = (payload, visited = new Set()) => {
    if (!payload || typeof payload !== 'object') {
        return []
    }

    if (visited.has(payload)) {
        return []
    }
    visited.add(payload)

    if (Array.isArray(payload)) {
        return payload.flatMap(item => [item, ...collectNestedValues(item, visited)])
    }

    return Object.values(payload).flatMap(item => [item, ...collectNestedValues(item, visited)])
}

/**
 * 解析 SSE 缓冲区中的 `data:` 负载
 * @param {string} buffer - SSE 缓冲区
 * @param {boolean} flush - 是否强制解析剩余内容
 * @returns {{ payloads: string[], buffer: string }} 解析结果
 */
const parseSsePayloads = (buffer, flush = false) => {
    const input = flush ? `${buffer}\n\n` : buffer
    const events = input.split(/\r?\n\r?\n/)
    const payloads = []
    const remainBuffer = flush ? '' : (events.pop() || '')

    for (const event of events) {
        const dataLines = event
            .split(/\r?\n/)
            .filter(item => item.trim().startsWith('data:'))
            .map(item => item.replace(/^data:\s*/, '').trim())
            .filter(Boolean)

        if (dataLines.length === 0) {
            continue
        }

        const payload = dataLines.join('\n').trim()
        if (payload && payload !== '[DONE]') {
            payloads.push(payload)
        }
    }

    return {
        payloads,
        buffer: remainBuffer
    }
}

/**
 * 从文本中提取首个资源链接
 * @param {string} text - 文本内容
 * @returns {string|null} 资源链接
 */
const extractResourceUrlFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return null
    }

    const markdownUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1]
    if (markdownUrl) {
        return markdownUrl
    }

    const downloadUrl = text.match(/\[Download [^\]]+\]\((https?:\/\/[^\s)]+)\)/i)?.[1]
    if (downloadUrl) {
        return downloadUrl
    }

    const plainUrl = text.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0]
    return plainUrl || null
}

/**
 * 从文本中提取视频任务 ID
 * @param {string} text - 文本内容
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIDFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return null
    }

    const patterns = [
        /"task_id"\s*:\s*"([^"]+)"/i,
        /"taskId"\s*:\s*"([^"]+)"/i,
        /task_id\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
        /taskId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
        /"id"\s*:\s*"([^"]+)"[\s\S]{0,120}"task_status"/i
    ]

    for (const pattern of patterns) {
        const matchedTaskID = text.match(pattern)?.[1]
        if (matchedTaskID && matchedTaskID.trim() !== '') {
            return matchedTaskID.trim()
        }
    }

    return null
}

/**
 * 从文本中提取响应 ID
 * @param {string} text - 文本内容
 * @returns {string[]} 响应 ID 列表
 */
const extractResponseIDsFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return []
    }

    const responseIDs = []
    const patterns = [
        /"response_id"\s*:\s*"([^"]+)"/ig,
        /"responseId"\s*:\s*"([^"]+)"/ig
    ]

    for (const pattern of patterns) {
        let matched = null
        while ((matched = pattern.exec(text)) !== null) {
            const responseID = matched[1]?.trim()
            if (responseID && !responseIDs.includes(responseID)) {
                responseIDs.push(responseID)
            }
        }
    }

    return responseIDs
}

/**
 * 从上游响应中提取资源链接
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 资源链接
 */
const extractResourceUrlFromPayload = (payload) => {
    if (!payload) {
        return null
    }

    if (Array.isArray(payload)) {
        for (const item of payload) {
            const matchedUrl = extractResourceUrlFromPayload(item)
            if (matchedUrl) {
                return matchedUrl
            }
        }
        return null
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()

        if ((trimmedPayload.startsWith('{') || trimmedPayload.startsWith('['))) {
            try {
                const parsedPayload = JSON.parse(trimmedPayload)
                const matchedUrl = extractResourceUrlFromPayload(parsedPayload)
                if (matchedUrl) {
                    return matchedUrl
                }
            } catch (e) {
            }
        }

        return extractResourceUrlFromText(trimmedPayload)
    }

    if (typeof payload !== 'object') {
        return null
    }

    const directCandidates = [
        payload.content,
        payload.url,
        payload.image,
        payload.video,
        payload.video_url,
        payload.videoUrl,
        payload.download_url,
        payload.downloadUrl,
        payload.file_url,
        payload.resource_url,
        payload.resourceUrl,
        payload.output_url,
        payload.result_url,
        payload.final_url,
        payload.finalUrl,
        payload.uri
    ]

    for (const candidate of directCandidates) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    const nestedCandidates = [
        payload.data,
        payload.message,
        payload.delta,
        payload.extra,
        payload.choices,
        payload.messages,
        payload.output,
        payload.result,
        payload.results,
        payload.urls,
        payload.files,
        payload.image_list,
        payload.video_list
    ]

    for (const candidate of nestedCandidates) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    for (const candidate of collectNestedValues(payload)) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    return null
}

/**
 * 从上游响应中提取响应 ID
 * @param {*} payload - 上游响应负载
 * @returns {string[]} 响应 ID 列表
 */
const extractResponseIDsFromPayload = (payload) => {
    if (!payload) {
        return []
    }

    if (Array.isArray(payload)) {
        return payload.flatMap(item => extractResponseIDsFromPayload(item))
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return []
        }

        try {
            return extractResponseIDsFromPayload(JSON.parse(trimmedPayload))
        } catch (e) {
            return extractResponseIDsFromText(trimmedPayload)
        }
    }

    if (typeof payload !== 'object') {
        return []
    }

    const responseIDs = []
    const pushResponseID = (responseID) => {
        if ((typeof responseID === 'string' || typeof responseID === 'number') && String(responseID).trim() !== '') {
            const normalizedResponseID = String(responseID).trim()
            if (!responseIDs.includes(normalizedResponseID)) {
                responseIDs.push(normalizedResponseID)
            }
        }
    }

    pushResponseID(payload.response_id)
    pushResponseID(payload.responseId)
    pushResponseID(payload?.response?.created?.response_id)
    pushResponseID(payload?.response?.created?.responseId)

    for (const candidate of collectNestedValues(payload)) {
        for (const nestedID of extractResponseIDsFromPayload(candidate)) {
            pushResponseID(nestedID)
        }
    }

    return responseIDs
}

/**
 * 从上游响应中提取视频任务 ID
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIdentifiersFromPayload = (payload) => {
    if (!payload) {
        return []
    }

    if (Array.isArray(payload)) {
        const taskIDs = []
        for (const item of payload) {
            for (const taskID of extractVideoTaskIdentifiersFromPayload(item)) {
                if (!taskIDs.includes(taskID)) {
                    taskIDs.push(taskID)
                }
            }
        }
        return taskIDs
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return []
        }

        try {
            return extractVideoTaskIdentifiersFromPayload(JSON.parse(trimmedPayload))
        } catch (e) {
            const taskID = extractVideoTaskIDFromText(trimmedPayload)
            return taskID ? [taskID] : []
        }
    }

    if (typeof payload !== 'object') {
        return []
    }

    const taskIDs = []
    const pushTaskID = (taskID) => {
        if ((typeof taskID === 'string' || typeof taskID === 'number') && String(taskID).trim() !== '') {
            const normalizedTaskID = String(taskID).trim()
            if (!taskIDs.includes(normalizedTaskID)) {
                taskIDs.push(normalizedTaskID)
            }
        }
    }

    pushTaskID(payload.task_id)
    pushTaskID(payload.taskId)
    pushTaskID(payload?.wanx?.task_id)
    pushTaskID(payload?.output?.task_id)
    pushTaskID(payload?.result?.task_id)
    pushTaskID(payload?.results?.task_id)
    pushTaskID(payload.response_id)
    pushTaskID(payload.responseId)

    const nestedCandidates = [
        payload.wanx,
        payload.data,
        payload.message,
        payload.delta,
        payload.extra,
        payload.choices,
        payload.messages,
        payload.output,
        payload.result,
        payload.results
    ]

    for (const candidate of nestedCandidates) {
        for (const taskID of extractVideoTaskIdentifiersFromPayload(candidate)) {
            pushTaskID(taskID)
        }
    }

    const isTaskPayload = payload.task_status || payload.status === 'pending' || payload.status === 'running' || payload.type === 'task' || /task/i.test(payload.object || '')
    if (isTaskPayload && (typeof payload.id === 'string' || typeof payload.id === 'number') && String(payload.id).trim() !== '') {
        pushTaskID(payload.id)
    }

    for (const candidate of collectNestedValues(payload)) {
        for (const taskID of extractVideoTaskIdentifiersFromPayload(candidate)) {
            pushTaskID(taskID)
        }
    }

    return taskIDs
}

/**
 * 从上游响应中提取首个视频任务 ID
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIDFromPayload = (payload) => extractVideoTaskIdentifiersFromPayload(payload)[0] || null

/**
 * 判断是否属于可重试的上游生成错误
 * @param {object|null} upstreamError - 上游错误
 * @returns {boolean} 是否可重试
 */
const isRetryableUpstreamError = (upstreamError) => {
    if (!upstreamError) {
        return false
    }

    return upstreamError.code === 'Bad_Request' && /internal error/i.test(upstreamError.error || '')
}

/**
 * 向下游发送上游错误
 * @param {object} res - Express 响应对象
 * @param {object} upstreamError - 上游错误
 * @returns {*} 响应结果
 */
const sendUpstreamError = (res, upstreamError) => {
    const { status, ...payload } = upstreamError
    return res.status(status || 500).json(payload)
}

/**
 * 构造图片消息内容
 * @param {string} contentUrl - 图片链接
 * @returns {string} 图片消息内容
 */
const buildImageContent = (contentUrl) => `![image](${contentUrl})`

/**
 * 构造视频消息内容
 * @param {string} contentUrl - 视频链接
 * @returns {string} 视频消息内容
 */
const buildVideoContent = (contentUrl) => `\n<video controls="controls">\n${contentUrl}\n</video>\n\n[Download Video](${contentUrl})\n`

/**
 * 解析可能为 JSON 字符串的请求字段
 * @param {*} value - 原始值
 * @returns {*} 解析后的值
 */
const parseMaybeJSON = (value) => {
    if (typeof value !== 'string') {
        return value
    }

    const trimmedValue = value.trim()
    if (!trimmedValue) {
        return value
    }

    try {
        return JSON.parse(trimmedValue)
    } catch (e) {
        return value
    }
}

/**
 * 统一转为数组
 * @param {*} value - 原始值
 * @returns {Array<*>} 数组结果
 */
const ensureArray = (value) => {
    const parsedValue = parseMaybeJSON(value)

    if (parsedValue === undefined || parsedValue === null || parsedValue === '') {
        return []
    }

    return Array.isArray(parsedValue) ? parsedValue : [parsedValue]
}

/**
 * 规范化 OpenAI 风格尺寸参数
 * @param {string} size - 原始尺寸
 * @returns {string|undefined} 规范化后的尺寸
 */
const normalizeOpenAIImageVideoSize = (size) => {
    if (!size) {
        return undefined
    }

    const normalizedSizeMap = {
        '1024x1024': '1:1',
        '1536x1024': '4:3',
        '1024x1536': '3:4',
        '1792x1024': '16:9',
        '1024x1792': '9:16'
    }

    return normalizedSizeMap[size] || size
}

/**
 * 统一构造 OpenAI 风格错误响应
 * @param {object} res - Express 响应对象
 * @param {*} error - 错误对象
 * @returns {*} 响应结果
 */
const sendOpenAIErrorResponse = (res, error) => {
    const status = error?.status || 500
    const message = error?.error || error?.message || 'Service error, please try again later'

    return res.status(status).json({
        error: {
            message,
            type: status >= 500 ? 'server_error' : 'invalid_request_error'
        }
    })
}

/**
 * 下载资源并转换为 Base64
 * @param {string} contentUrl - 资源链接
 * @returns {Promise<string>} Base64 内容
 */
const downloadAssetAsBase64 = async (contentUrl, account) => {
    const proxyAgent = getProxyAgent(account)
    const requestConfig = {
        responseType: 'arraybuffer',
        timeout: 1000 * 60 * 2
    }

    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }

    const responseData = await axios.get(contentUrl, requestConfig)
    return Buffer.from(responseData.data).toString('base64')
}

/**
 * 构造 OpenAI 图像响应项
 * @param {string} contentUrl - 图片链接
 * @param {string} responseFormat - 输出格式
 * @returns {Promise<object>} 图像响应项
 */
const buildOpenAIImageResultItem = async (contentUrl, responseFormat) => {
    if (responseFormat === 'b64_json') {
        return {
            b64_json: await downloadAssetAsBase64(contentUrl)
        }
    }

    return {
        url: contentUrl
    }
}

/**
 * 从请求对象中提取内联媒体链接
 * @param {*} value - 原始媒体值
 * @param {string} mediaType - 媒体类型
 * @returns {string|null} 媒体链接
 */
const extractInlineMediaURL = (value, mediaType) => {
    const parsedValue = parseMaybeJSON(value)

    if (typeof parsedValue === 'string') {
        return parsedValue
    }

    if (!parsedValue || typeof parsedValue !== 'object') {
        return null
    }

    if (mediaType === 'video') {
        return parsedValue.url || parsedValue.video || parsedValue.video_url?.url || parsedValue.input_video?.url || parsedValue.input_video?.video_url || null
    }

    return parsedValue.url || parsedValue.image || parsedValue.image_url?.url || null
}

/**
 * 构造内部媒体内容项
 * @param {string} mediaType - 媒体类型
 * @param {string} mediaURL - 媒体链接
 * @returns {object} 内部媒体内容项
 */
const buildInternalMediaItem = (mediaType, mediaURL) => {
    if (mediaType === 'video') {
        return {
            type: 'video',
            video: mediaURL
        }
    }

    return {
        type: 'image',
        image: mediaURL
    }
}

/**
 * 上传 multipart 文件并构造内部媒体内容项
 * @param {object} file - multer 文件对象
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<object>} 内部媒体内容项
 */
const uploadMultipartMediaFile = async (file, mediaType) => {
    if (!file?.buffer) {
        throw new Error('上传文件内容为空')
    }

    const fallbackExtension = mediaType === 'video' ? 'mp4' : 'png'
    const originalFilename = file.originalname || `upload.${fallbackExtension}`
    const uploadAccount = accountManager.getAccount()
    const uploadResult = await uploadFileToQwenOss(file.buffer, originalFilename, uploadAccount ? uploadAccount.token : null, uploadAccount)

    if (!uploadResult || uploadResult.status !== 200) {
        throw new Error('文件上传失败')
    }

    return buildInternalMediaItem(mediaType, uploadResult.file_url)
}

/**
 * 将内联媒体参数转换为内部媒体内容项
 * @param {*} value - 原始媒体值
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<object|null>} 内部媒体内容项
 */
const normalizeInlineMediaItem = async (value, mediaType) => {
    const mediaURL = extractInlineMediaURL(value, mediaType)
    if (!mediaURL) {
        return null
    }

    if (HTTP_URL_REGEX.test(mediaURL)) {
        return buildInternalMediaItem(mediaType, mediaURL)
    }

    const matchedDataURI = mediaURL.match(DATA_URI_REGEX)
    if (!matchedDataURI) {
        return buildInternalMediaItem(mediaType, mediaURL)
    }

    const mimeType = matchedDataURI[1]
    const base64Content = matchedDataURI[2]
    const fileExtension = mimeType?.split('/')[1] || (mediaType === 'video' ? 'mp4' : 'png')
    const uploadAccount = accountManager.getAccount()
    const uploadResult = await uploadFileToQwenOss(Buffer.from(base64Content, 'base64'), `upload.${fileExtension}`, uploadAccount ? uploadAccount.token : null, uploadAccount)

    if (!uploadResult || uploadResult.status !== 200) {
        throw new Error('文件上传失败')
    }

    return buildInternalMediaItem(mediaType, uploadResult.file_url)
}

/**
 * 收集请求中的媒体内容项
 * @param {object} req - Express 请求对象
 * @param {string} fieldName - 字段名
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<Array<object>>} 媒体内容项列表
 */
const collectRequestMediaItems = async (req, fieldName, mediaType) => {
    const mediaItems = []
    const matchedFiles = (req.files || []).filter(file => file.fieldname === fieldName)

    for (const file of matchedFiles) {
        mediaItems.push(await uploadMultipartMediaFile(file, mediaType))
    }

    for (const value of ensureArray(req.body?.[fieldName])) {
        const normalizedMediaItem = await normalizeInlineMediaItem(value, mediaType)
        if (normalizedMediaItem) {
            mediaItems.push(normalizedMediaItem)
        }
    }

    return mediaItems
}

/**
 * 解析请求模型，未显式传入时按能力选择默认模型
 * @param {string} model - 请求模型
 * @param {string} chatType - 聊天类型
 * @returns {Promise<string>} 可直接发送到上游的模型 ID
 */
const resolveRequestedModel = async (model, chatType) => {
    if (model) {
        return parserModel(model)
    }

    const defaultModel = await getDefaultModelByChatType(chatType)
    return defaultModel || parserModel(model)
}

/**
 * 读取视频上游流并提取任务信息
 * @param {*} responseStream - 上游响应流
 * @returns {Promise<{ upstreamError: object|null, contentUrl: string|null, videoTaskID: string|null, videoTaskCandidates: string[], responseIDs: string[], rawPreview: string }>} 解析结果
 */
const readVideoUpstreamResult = async (responseStream) => {
    if (!responseStream || typeof responseStream.on !== 'function') {
        const videoTaskCandidates = extractVideoTaskIdentifiersFromPayload(responseStream)
        const responseIDs = extractResponseIDsFromPayload(responseStream)
        return {
            upstreamError: parseUpstreamImageError(responseStream),
            contentUrl: extractResourceUrlFromPayload(responseStream),
            videoTaskID: videoTaskCandidates[0] || null,
            videoTaskCandidates,
            responseIDs,
            rawPreview: typeof responseStream === 'string' ? responseStream.slice(0, 400) : ''
        }
    }

    const decoder = new TextDecoder('utf-8')
    let rawText = ''
    let buffer = ''
    let upstreamError = null
    let contentUrl = null
    const videoTaskCandidates = []
    const responseIDs = []
    const pushVideoTaskCandidate = (taskID) => {
        if (taskID && !videoTaskCandidates.includes(taskID)) {
            videoTaskCandidates.push(taskID)
        }
    }
    const pushResponseID = (responseID) => {
        if (responseID && !responseIDs.includes(responseID)) {
            responseIDs.push(responseID)
        }
    }

    const applyPayload = (payload) => {
        if (!upstreamError) {
            upstreamError = parseUpstreamImageError(payload)
        }

        if (!contentUrl) {
            contentUrl = extractResourceUrlFromPayload(payload)
        }

        for (const taskID of extractVideoTaskIdentifiersFromPayload(payload)) {
            pushVideoTaskCandidate(taskID)
        }

        for (const responseID of extractResponseIDsFromPayload(payload)) {
            pushResponseID(responseID)
        }
    }

    await new Promise((resolve, reject) => {
        responseStream.on('data', (chunk) => {
            const decoded = decoder.decode(chunk, { stream: true })
            rawText += decoded
            buffer += decoded

            const parsedResult = parseSsePayloads(buffer)
            buffer = parsedResult.buffer

            for (const payload of parsedResult.payloads) {
                applyPayload(payload)
            }
        })

        responseStream.on('end', resolve)
        responseStream.on('error', reject)
    })

    const flushedResult = parseSsePayloads(buffer, true)
    for (const payload of flushedResult.payloads) {
        applyPayload(payload)
    }

    const trimmedRawText = rawText.trim()
    if (!upstreamError) {
        upstreamError = parseUpstreamImageErrorFromText(trimmedRawText) || parseUpstreamImageError(trimmedRawText)
    }

    if (!contentUrl) {
        contentUrl = extractResourceUrlFromPayload(trimmedRawText)
    }

    for (const taskID of extractVideoTaskIdentifiersFromPayload(trimmedRawText)) {
        pushVideoTaskCandidate(taskID)
    }

    return {
        upstreamError,
        contentUrl,
        videoTaskID: videoTaskCandidates[0] || null,
        videoTaskCandidates,
        responseIDs,
        rawPreview: trimmedRawText.slice(0, 400)
    }
}

/**
 * 读取图片上游流并提取响应信息
 * @param {*} responseStream - 上游响应流
 * @returns {Promise<{ upstreamError: object|null, contentUrl: string|null, responseIDs: string[], rawPreview: string }>} 解析结果
 */
const readImageUpstreamResult = async (responseStream) => {
    if (!responseStream || typeof responseStream.on !== 'function') {
        return {
            upstreamError: parseUpstreamImageError(responseStream),
            contentUrl: extractResourceUrlFromPayload(responseStream),
            responseIDs: extractResponseIDsFromPayload(responseStream),
            rawPreview: typeof responseStream === 'string' ? responseStream.slice(0, 400) : ''
        }
    }

    const decoder = new TextDecoder('utf-8')
    let rawText = ''
    let buffer = ''
    let upstreamError = null
    let contentUrl = null
    const responseIDs = []
    const pushResponseID = (responseID) => {
        if (responseID && !responseIDs.includes(responseID)) {
            responseIDs.push(responseID)
        }
    }

    const applyPayload = (payload) => {
        if (!upstreamError) {
            upstreamError = parseUpstreamImageError(payload)
        }

        if (!contentUrl) {
            contentUrl = extractResourceUrlFromPayload(payload)
        }

        for (const responseID of extractResponseIDsFromPayload(payload)) {
            pushResponseID(responseID)
        }
    }

    await new Promise((resolve, reject) => {
        responseStream.on('data', (chunk) => {
            const decoded = decoder.decode(chunk, { stream: true })
            rawText += decoded
            buffer += decoded

            const parsedResult = parseSsePayloads(buffer)
            buffer = parsedResult.buffer

            for (const payload of parsedResult.payloads) {
                applyPayload(payload)
            }
        })

        responseStream.on('end', resolve)
        responseStream.on('error', reject)
    })

    const flushedResult = parseSsePayloads(buffer, true)
    for (const payload of flushedResult.payloads) {
        applyPayload(payload)
    }

    const trimmedRawText = rawText.trim()
    if (!upstreamError) {
        upstreamError = parseUpstreamImageErrorFromText(trimmedRawText) || parseUpstreamImageError(trimmedRawText)
    }

    if (!contentUrl) {
        contentUrl = extractResourceUrlFromPayload(trimmedRawText)
    }

    for (const responseID of extractResponseIDsFromPayload(trimmedRawText)) {
        pushResponseID(responseID)
    }

    return {
        upstreamError,
        contentUrl,
        responseIDs,
        rawPreview: trimmedRawText.slice(0, 400)
    }
}

/**
 * 拉取聊天详情
 * @param {string} chatID - 对话 ID
 * @param {string} token - 访问令牌
 * @returns {Promise<object|null>} 聊天详情
 */
const getChatDetail = async (chatID, token) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        // 通过 token 反查 account 解析账号级代理（找不到则回退到全局 PROXY_URL）
        const account = accountManager.getAccountByToken(token)
        const proxyAgent = getProxyAgent(account)
        const cookieHeader = buildUpstreamCookieHeader(token)

        const requestConfig = {
            headers: {
                "Authorization": `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(cookieHeader && { 'Cookie': cookieHeader })
            }
        }

        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        const responseData = await axios.get(`${chatBaseUrl}/api/v2/chats/${chatID}`, requestConfig)
        return responseData.data || null
    } catch (error) {
        logger.error(`获取聊天详情失败 (${chatID})`, 'CHAT', '', buildAxiosErrorLog(error))
        return null
    }
}

/**
 * 从聊天详情中提取资源与任务信息
 * @param {*} chatDetail - 聊天详情
 * @param {string[]} responseIDs - 响应 ID 列表
 * @returns {{ contentUrl: string|null, videoTaskCandidates: string[] }} 提取结果
 */
const extractVideoInfoFromChatDetail = (chatDetail, responseIDs = []) => {
    const responseIDSet = new Set(responseIDs.filter(Boolean))
    const allMessages = []

    const messageMap = chatDetail?.data?.chat?.history?.messages
    if (messageMap && typeof messageMap === 'object') {
        allMessages.push(...Object.values(messageMap))
    }

    const messages = chatDetail?.data?.chat?.messages
    if (Array.isArray(messages)) {
        allMessages.push(...messages)
    }

    const pushUnique = (list, value) => {
        if (value && !list.includes(value)) {
            list.push(value)
        }
    }

    let contentUrl = null
    const videoTaskCandidates = []

    const candidateMessages = allMessages.filter(message => {
        if (!message || typeof message !== 'object') {
            return false
        }

        const responseID = message.response_id || message.responseId || message.id
        if (responseIDSet.size === 0) {
            return true
        }

        return responseID && responseIDSet.has(String(responseID))
    })

    for (const message of candidateMessages) {
        if (!contentUrl) {
            contentUrl = extractResourceUrlFromPayload(message)
        }

        for (const taskID of extractVideoTaskIdentifiersFromPayload(message)) {
            pushUnique(videoTaskCandidates, taskID)
        }
    }

    return {
        contentUrl,
        videoTaskCandidates
    }
}

/**
 * 解析图片生成结果链接
 * @param {*} responseData - 上游响应
 * @param {string} chatID - 会话 ID
 * @param {string} token - 当前账号令牌
 * @returns {Promise<string>} 图片链接
 */
const resolveImageResultContentUrl = async (responseData, chatID, token) => {
    const { upstreamError, contentUrl: upstreamContentUrl, responseIDs, rawPreview } = await readImageUpstreamResult(responseData)
    if (upstreamError) {
        throw upstreamError
    }

    let contentUrl = upstreamContentUrl

    if (!contentUrl && chatID) {
        logger.info(`图片上游未直接返回链接，尝试从聊天详情补取，chat_id=${chatID} responseIDs=${JSON.stringify(responseIDs)}`, 'CHAT')

        for (let attempt = 1; attempt <= 5; attempt++) {
            const chatDetail = await getChatDetail(chatID, token)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)
            if (extractedInfo.contentUrl) {
                contentUrl = extractedInfo.contentUrl
                break
            }

            await sleep(800)
        }
    }

    if (!contentUrl) {
        logger.warn(`图片上游响应未解析出图片链接，responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回图片链接')
    }

    return contentUrl
}

/**
 * 解析视频生成结果链接
 * @param {*} responseStream - 上游响应流
 * @param {string} token - 当前账号令牌
 * @param {string} chatID - 会话 ID
 * @returns {Promise<string>} 视频链接
 */
const resolveVideoResultContentUrl = async (responseStream, token, chatID) => {
    const { upstreamError, contentUrl: upstreamContentUrl, videoTaskCandidates, responseIDs, rawPreview } = await readVideoUpstreamResult(responseStream)
    if (upstreamError) {
        throw upstreamError
    }

    if (upstreamContentUrl) {
        return upstreamContentUrl
    }

    let resolvedContentUrl = upstreamContentUrl
    let resolvedTaskCandidates = [...videoTaskCandidates]

    if (!resolvedContentUrl && resolvedTaskCandidates.length === 0 && chatID) {
        logger.info(`视频上游未直接返回任务信息，尝试从聊天详情补取，chat_id=${chatID} responseIDs=${JSON.stringify(responseIDs)}`, 'CHAT')

        for (let attempt = 1; attempt <= 5; attempt++) {
            const chatDetail = await getChatDetail(chatID, token)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)

            if (!resolvedContentUrl && extractedInfo.contentUrl) {
                resolvedContentUrl = extractedInfo.contentUrl
            }

            for (const taskID of extractedInfo.videoTaskCandidates) {
                if (!resolvedTaskCandidates.includes(taskID)) {
                    resolvedTaskCandidates.push(taskID)
                }
            }

            if (resolvedContentUrl || resolvedTaskCandidates.length > 0) {
                break
            }

            await sleep(1200)
        }
    }

    if (resolvedContentUrl) {
        return resolvedContentUrl
    }

    if (resolvedTaskCandidates.length === 0) {
        logger.warn(`视频上游响应未解析出任务信息，contentUrl=${resolvedContentUrl || '空'} candidates=${JSON.stringify(resolvedTaskCandidates)} responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回视频任务 ID 或视频链接')
    }

    logger.info(`视频任务候选ID: ${JSON.stringify(resolvedTaskCandidates)}`, 'CHAT')

    const maxAttempts = 60
    const delay = 20 * 1000

    for (const taskCandidate of resolvedTaskCandidates) {
        logger.info(`开始轮询视频任务ID: ${taskCandidate}`, 'CHAT')

        for (let i = 0; i < maxAttempts; i++) {
            const content = await getVideoTaskStatus(taskCandidate, token)
            if (content) {
                return content
            }

            await sleep(delay)
        }
    }

    logger.error(`视频任务 ${JSON.stringify(resolvedTaskCandidates)} 轮询超时`, 'CHAT')
    throw {
        status: 504,
        error: '视频生成超时，请稍后再试'
    }
}

/**
 * 统一执行图片/视频请求
 * @param {object} payload - 内部请求体
 * @returns {Promise<{ model: string, chatType: string, contentUrl: string, content: string }>} 执行结果
 */
const generateImageVideoResult = async (payload) => {
    const { model, messages, size, chat_type } = payload
    // 一次取出账户对象，确保 token 与 proxy 走同一个账号
    const account = accountManager.getAccount()
    const token = account ? account.token : null

    try {
        const reqBody = {
            "stream": false,
            "version": "2.1",
            "incremental_output": true,
            "chat_id": null,
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "",
                    "files": [],
                    "chat_type": chat_type,
                    "feature_config": {
                        "output_schema": "phase"
                    }
                }
            ]
        }

        const chatID = await generateChatID(token, model)

        if (!chatID) {
            throw new Error('生成 chat_id 失败')
        }

        reqBody.chat_id = chatID

        const userPrompt = messages?.[messages.length - 1]?.content
        if (!userPrompt) {
            throw {
                status: 400,
                error: '缺少有效的提示词'
            }
        }

        const messagesHistory = messages.filter(item => item.role === 'user' || item.role === 'assistant')
        const selectedImageList = []

        if (chat_type === 'image_edit') {
            for (const item of messagesHistory) {
                if (item.role === 'assistant') {
                    const matches = [...String(item.content || '').matchAll(/!\[image\]\((.*?)\)/g)]
                    for (const match of matches) {
                        selectedImageList.push(match[1])
                    }
                } else if (Array.isArray(item.content) && item.content.length > 0) {
                    for (const content of item.content) {
                        if (content.type === 'image') {
                            selectedImageList.push(content.image)
                        }
                    }
                }
            }
        }

        if (chat_type === 't2i' || chat_type === 't2v') {
            if (Array.isArray(userPrompt)) {
                reqBody.messages[0].content = userPrompt.map(item => item.type === 'text' ? item.text : '').join('\n\n')
            } else {
                reqBody.messages[0].content = userPrompt
            }
        } else if (chat_type === 'image_edit') {
            if (!Array.isArray(userPrompt)) {
                if (messagesHistory.length === 1) {
                    reqBody.messages[0].chat_type = 't2i'
                } else if (selectedImageList.length >= 1) {
                    reqBody.messages[0].files.push({
                        "type": "image",
                        "url": selectedImageList[selectedImageList.length - 1]
                    })
                }
                reqBody.messages[0].content += userPrompt
            } else {
                const texts = userPrompt.filter(item => item.type === 'text')
                if (texts.length === 0) {
                    throw {
                        status: 400,
                        error: '图片编辑请求缺少文本提示词'
                    }
                }

                for (const item of texts) {
                    reqBody.messages[0].content += item.text
                }

                const files = userPrompt.filter(item => item.type === 'image')
                if (files.length === 0) {
                    reqBody.messages[0].chat_type = 't2i'
                }

                for (const item of files) {
                    reqBody.messages[0].files.push({
                        "type": "image",
                        "url": item.image
                    })
                }
            }
        }

        if (chat_type === 't2i' || chat_type === 't2v') {
            if (size !== undefined && size !== null) {
                reqBody.size = size
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@4:3') !== -1) {
                reqBody.size = '4:3'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@3:4') !== -1) {
                reqBody.size = '3:4'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@16:9') !== -1) {
                reqBody.size = '16:9'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@9:16') !== -1) {
                reqBody.size = '9:16'
            }
        }

        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent(account)
        const cookieHeader = buildUpstreamCookieHeader(token)

        logger.info('发送图片视频请求', 'CHAT')
        logger.info(`选择图片: ${selectedImageList[selectedImageList.length - 1] || '未选择图片，切换生成图/视频模式'}`, 'CHAT')
        logger.info(`使用提示: ${reqBody.messages[0].content}`, 'CHAT')

        const newChatType = reqBody.messages[0].chat_type
        const upstreamStream = newChatType === 't2i' || newChatType === 'image_edit'
        reqBody.stream = upstreamStream

        logger.info(`图片视频流策略: upstream=${upstreamStream} downstream=${payload.stream === true}`, 'CHAT')

        const requestConfig = {
            headers: {
                'authorization': `Bearer ${token}`,
                'sec-ch-ua-platform': '"Windows"',
                'referer': `${chatBaseUrl}/`,
                'accept-language': 'zh-CN,zh;q=0.9',
                'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                'content-type': 'application/json',
                'bx-v': '2.5.36',
                'accept': upstreamStream ? 'application/json, text/plain, */*' : 'application/json',
                'accept-encoding': 'gzip, deflate, br, zstd',
                ...(cookieHeader && { 'cookie': cookieHeader }),
                'host': chatBaseUrl.replace('https://', ''),
                'origin': chatBaseUrl,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
            },
            responseType: newChatType === 't2v' ? 'json' : (upstreamStream ? 'stream' : 'text'),
            timeout: 1000 * 60 * 5
        }

        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        let responseData = null
        const maxUpstreamAttempts = 2

        for (let attempt = 1; attempt <= maxUpstreamAttempts; attempt++) {
            try {
                responseData = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=${chatID}`, reqBody, requestConfig)

                const inlineUpstreamError = parseUpstreamImageError(responseData.data)
                if (attempt < maxUpstreamAttempts && isRetryableUpstreamError(inlineUpstreamError)) {
                    logger.warn(`图片/视频请求上游返回业务错误包，准备第 ${attempt + 1} 次重试，请求ID: ${inlineUpstreamError.request_id || '未知'}`, 'CHAT')
                    await sleep(800)
                    continue
                }

                break
            } catch (error) {
                logger.error('图片/视频请求失败', 'CHAT', '', buildAxiosErrorLog(error))
                const upstreamError = parseUpstreamImageError(error.response?.data)
                if (attempt < maxUpstreamAttempts && isRetryableUpstreamError(upstreamError)) {
                    logger.warn(`图片/视频请求上游返回瞬时内部错误，准备第 ${attempt + 1} 次重试`, 'CHAT')
                    await sleep(800)
                    continue
                }

                throw error
            }
        }

        if (newChatType === 't2i' || newChatType === 'image_edit') {
            const contentUrl = await resolveImageResultContentUrl(responseData.data, chatID, token)
            return {
                model,
                chatType: newChatType,
                contentUrl,
                content: buildImageContent(contentUrl)
            }
        }

        if (newChatType === 't2v') {
            const contentUrl = await resolveVideoResultContentUrl(responseData.data, token, chatID)
            return {
                model,
                chatType: newChatType,
                contentUrl,
                content: buildVideoContent(contentUrl)
            }
        }

        throw new Error('不支持的图片/视频类型')
    } catch (error) {
        logger.error('图片/视频主流程异常', 'CHAT', '', buildAxiosErrorLog(error))

        if (error?.error) {
            throw error
        }

        const upstreamError = parseUpstreamImageError(error.response?.data)
        if (upstreamError) {
            throw upstreamError
        }

        throw {
            status: 500,
            error: error?.message || 'Service error, please try again later'
        }
    }
}

/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleImageVideoCompletion = async (req, res) => {
    const downstreamStream = req.body.stream === true
    let keepAliveTimer = null

    try {
        if (downstreamStream && req.body.chat_type === 't2v') {
            setResponseHeaders(res, true)
            keepAliveTimer = setInterval(() => {
                if (!res.writableEnded) {
                    res.write(`: keep-alive\n\n`)
                }
            }, 15000)
        }

        const result = await generateImageVideoResult(req.body)

        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        return returnResponse(res, result.model, result.content, downstreamStream)
    } catch (error) {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        logger.error('图片视频资源处理错误', 'CHAT', '', error)

        if (downstreamStream) {
            return returnResponse(res, req.body.model, error?.error || error?.message || 'Service error, please try again later', true)
        }

        return sendUpstreamError(res, error?.error ? error : {
            status: 500,
            error: error?.message || 'Service error, please try again later'
        })
    }
}

/**
 * 返回响应
 * @param {*} res
 * @param {string} model
 * @param {string} content
 * @param {boolean} stream
 */
const returnResponse = (res, model, content, stream) => {
    if (!res.headersSent) {
        setResponseHeaders(res, stream)
    }

    logger.info(`返回响应: ${content}`, 'CHAT')

    if (stream) {
        const responseID = `chatcmpl-${new Date().getTime()}`
        const streamBody = {
            "id": responseID,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "content": content
                    },
                    "finish_reason": null
                }
            ]
        }

        const finishBody = {
            "id": responseID,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        }

        res.write(`data: ${JSON.stringify(streamBody)}\n\n`)
        res.write(`data: ${JSON.stringify(finishBody)}\n\n`)
        res.write(`data: [DONE]\n\n`)
        res.end()
    } else {
        res.json({
            "id": `chatcmpl-${new Date().getTime()}`,
            "object": "chat.completion",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content
                    },
                    "finish_reason": "stop"
                }
            ]
        })
    }
}

/**
 * 处理 OpenAI 风格的图片生成端点
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIImagesGeneration = async (req, res) => {
    try {
        if (!req.body?.prompt) {
            return sendOpenAIErrorResponse(res, {
                status: 400,
                error: 'prompt 是必填参数'
            })
        }

        const model = await resolveRequestedModel(req.body.model, 't2i')
        const result = await generateImageVideoResult({
            model,
            messages: [
                {
                    role: 'user',
                    content: req.body.prompt
                }
            ],
            size: normalizeOpenAIImageVideoSize(req.body.size),
            chat_type: 't2i',
            stream: false
        })

        const imageData = await buildOpenAIImageResultItem(result.contentUrl, req.body.response_format)

        res.json({
            created: Math.floor(Date.now() / 1000),
            data: [imageData]
        })
    } catch (error) {
        logger.error('OpenAI 图片生成端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

/**
 * 处理 OpenAI 风格的图片编辑端点
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIImagesEdit = async (req, res) => {
    try {
        const imageItems = await collectRequestMediaItems(req, 'image', 'image')
        if (imageItems.length === 0) {
            return sendOpenAIErrorResponse(res, {
                status: 400,
                error: 'image 是必填参数'
            })
        }

        const model = await resolveRequestedModel(req.body.model, 'image_edit')
        const prompt = req.body.prompt || '请基于上传图片完成编辑'
        const result = await generateImageVideoResult({
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: prompt
                        },
                        ...imageItems
                    ]
                }
            ],
            size: normalizeOpenAIImageVideoSize(req.body.size),
            chat_type: 'image_edit',
            stream: false
        })

        const imageData = await buildOpenAIImageResultItem(result.contentUrl, req.body.response_format)

        res.json({
            created: Math.floor(Date.now() / 1000),
            data: [imageData]
        })
    } catch (error) {
        logger.error('OpenAI 图片编辑端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

/**
 * 处理 OpenAI 风格的视频生成端点
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIVideoGeneration = async (req, res) => {
    try {
        if (!req.body?.prompt) {
            return sendOpenAIErrorResponse(res, {
                status: 400,
                error: 'prompt 是必填参数'
            })
        }

        const model = await resolveRequestedModel(req.body.model, 't2v')
        const result = await generateImageVideoResult({
            model,
            messages: [
                {
                    role: 'user',
                    content: req.body.prompt
                }
            ],
            size: normalizeOpenAIImageVideoSize(req.body.size),
            chat_type: 't2v',
            stream: false
        })

        res.json({
            id: `video_${new Date().getTime()}`,
            object: 'video',
            created: Math.floor(Date.now() / 1000),
            model,
            status: 'completed',
            data: [
                {
                    url: result.contentUrl
                }
            ]
        })
    } catch (error) {
        logger.error('OpenAI 视频生成端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

const handleVideoCompletion = async (res, responseStream, token, model, downstreamStream, chatID) => {
    let keepAliveTimer = null

    try {
        if (downstreamStream) {
            setResponseHeaders(res, true)
            keepAliveTimer = setInterval(() => {
                if (!res.writableEnded) {
                    res.write(`: keep-alive\n\n`)
                }
            }, 15000)
        }

        const { upstreamError, contentUrl: upstreamContentUrl, videoTaskID, videoTaskCandidates, responseIDs, rawPreview } = await readVideoUpstreamResult(responseStream)
        if (upstreamError) {
            if (keepAliveTimer) {
                clearInterval(keepAliveTimer)
            }

            if (downstreamStream) {
                res.status(upstreamError.status || 500)
                return returnResponse(res, model, upstreamError.error || '视频生成失败', true)
            }

            return sendUpstreamError(res, upstreamError)
        }

        if (upstreamContentUrl) {
            if (keepAliveTimer) {
                clearInterval(keepAliveTimer)
            }

            return returnResponse(res, model, buildVideoContent(upstreamContentUrl), downstreamStream)
        }

        let resolvedContentUrl = upstreamContentUrl
        let resolvedTaskCandidates = [...videoTaskCandidates]

        if (!resolvedContentUrl && resolvedTaskCandidates.length === 0 && chatID) {
            logger.info(`视频上游未直接返回任务信息，尝试从聊天详情补取，chat_id=${chatID} responseIDs=${JSON.stringify(responseIDs)}`, 'CHAT')

            for (let attempt = 1; attempt <= 5; attempt++) {
                const chatDetail = await getChatDetail(chatID, token)
                const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)

                if (!resolvedContentUrl && extractedInfo.contentUrl) {
                    resolvedContentUrl = extractedInfo.contentUrl
                }

                for (const taskID of extractedInfo.videoTaskCandidates) {
                    if (!resolvedTaskCandidates.includes(taskID)) {
                        resolvedTaskCandidates.push(taskID)
                    }
                }

                if (resolvedContentUrl || resolvedTaskCandidates.length > 0) {
                    break
                }

                await sleep(1200)
            }
        }

        if (resolvedContentUrl) {
            if (keepAliveTimer) {
                clearInterval(keepAliveTimer)
            }

            return returnResponse(res, model, buildVideoContent(resolvedContentUrl), downstreamStream)
        }

        if (resolvedTaskCandidates.length === 0) {
            logger.warn(`视频上游响应未解析出任务信息，contentUrl=${resolvedContentUrl || '空'} candidates=${JSON.stringify(resolvedTaskCandidates)} responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
            throw new Error('上游未返回视频任务 ID 或视频链接')
        }

        logger.info(`视频任务候选ID: ${JSON.stringify(resolvedTaskCandidates)}`, 'CHAT')

        const maxAttempts = 60
        const delay = 20 * 1000

        for (const taskCandidate of resolvedTaskCandidates) {
            logger.info(`开始轮询视频任务ID: ${taskCandidate}`, 'CHAT')

            for (let i = 0; i < maxAttempts; i++) {
                const content = await getVideoTaskStatus(taskCandidate, token)
                if (content) {
                    if (keepAliveTimer) {
                        clearInterval(keepAliveTimer)
                    }

                    return returnResponse(res, model, buildVideoContent(content), downstreamStream)
                }

                await sleep(delay)
            }
        }

        logger.error(`视频任务 ${JSON.stringify(resolvedTaskCandidates)} 轮询超时`, 'CHAT')
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        if (downstreamStream) {
            return returnResponse(res, model, '视频生成超时，请稍后再试', true)
        }

        return res.status(504).json({ error: '视频生成超时，请稍后再试' })
    } catch (error) {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        logger.error('获取视频任务状态失败', 'CHAT', '', error)

        const errorMessage = error.response?.data?.data?.code || error.message || '可能该帐号今日生成次数已用完'

        if (downstreamStream) {
            return returnResponse(res, model, `视频生成失败: ${errorMessage}`, true)
        }

        res.status(500).json({ error: errorMessage })
    }
}

const getVideoTaskStatus = async (videoTaskID, token) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const account = accountManager.getAccountByToken(token)
        const proxyAgent = getProxyAgent(account)
        const cookieHeader = buildUpstreamCookieHeader(token)

        const requestConfig = {
            headers: {
                "Authorization": `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(cookieHeader && { 'Cookie': cookieHeader })
            }
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        const response_data = await axios.get(`${chatBaseUrl}/api/v1/tasks/status/${videoTaskID}`, requestConfig)

        if (response_data.data?.task_status == "success") {
            const contentUrl = extractResourceUrlFromPayload(response_data.data)
            logger.info('获取视频任务状态成功', 'CHAT', contentUrl || response_data.data?.content)
            return contentUrl
        }
        logger.info(`获取视频任务 ${videoTaskID} 状态: ${response_data.data?.task_status}`, 'CHAT')
        return null
    } catch (error) {
        logger.error(`查询视频任务状态失败 (${videoTaskID})`, 'CHAT', '', buildAxiosErrorLog(error))
        return null
    }
}

module.exports = {
    handleImageVideoCompletion,
    handleOpenAIImagesGeneration,
    handleOpenAIImagesEdit,
    handleOpenAIVideoGeneration
}
