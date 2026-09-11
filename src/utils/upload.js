const axios = require('axios')
const OSS = require('ali-oss')
const mimetypes = require('mime-types')
const { logger } = require('./logger')
const { generateUUID } = require('./tools.js')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('./proxy-helper')
const { buildRequestHeaders } = require('./header-profile')
const config = require('../config/index.js')

// 配置常量
const UPLOAD_CONFIG = {
    get stsTokenUrl() {
        return `${getChatBaseUrl()}/api/v1/files/getstsToken`
    },
    maxRetries: 3,
    timeout: 30000,
    maxFileSize: 100 * 1024 * 1024, // 100MB
    retryDelay: 1000
}

// 支持的文件类型
const SUPPORTED_TYPES = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
    video: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv'],
    audio: ['audio/mp3', 'audio/wav', 'audio/aac', 'audio/ogg'],
    document: ['application/pdf', 'text/plain', 'application/msword']
}

/**
 * 验证文件大小
 * @param {number} fileSize - 文件大小（字节）
 * @returns {boolean} 是否符合大小限制
 */
const validateFileSize = (fileSize) => {
    return fileSize > 0 && fileSize <= UPLOAD_CONFIG.maxFileSize
}



/**
 * 从完整MIME类型获取简化的文件类型
 * @param {string} mimeType - 完整的MIME类型
 * @returns {string} 简化文件类型
 */
const getSimpleFileType = (mimeType) => {
    if (!mimeType) return 'file'

    const mainType = mimeType.split('/')[0].toLowerCase()

    // 检查是否为支持的主要类型
    if (Object.keys(SUPPORTED_TYPES).includes(mainType)) {
        return mainType
    }

    return 'file'
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const createAuthorizedHeaders = (authToken, account) => {
    // Antidetect: per-account fingerprint headers replace static UA
    const base = buildRequestHeaders(account, {
        extra: {
            'Authorization': authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
        }
    })
    return base
}

const unwrapApiData = (response) => {
    const payload = response?.data
    return payload && payload.data && typeof payload.data === 'object'
        ? payload.data
        : payload
}

/**
 * 请求STS Token（带重试机制）
 * @param {string} filename - 文件名
 * @param {number} filesize - 文件大小（字节）
 * @param {string} filetypeSimple - 简化文件类型
 * @param {string} authToken - 认证Token
 * @param {number} retryCount - 重试次数
 * @param {Object} [account] - 账户对象（用于解析账号级代理）
 * @returns {Promise<Object>} STS Token响应数据
 */
const requestStsToken = async (filename, filesize, filetypeSimple, authToken, retryCount = 0, account) => {
    try {
        // 参数验证
        if (!filename || !authToken) {
            logger.error('文件名和认证Token不能为空', 'UPLOAD')
            throw new Error('文件名和认证Token不能为空')
        }

        if (!validateFileSize(filesize)) {
            logger.error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        const requestId = generateUUID()
        const bearerToken = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
        const proxyAgent = await getProxyAgent(account)

        // Antidetect: per-account fingerprint headers replace static UA
        const baseHeaders = buildRequestHeaders(account, {
            extra: {
                'Authorization': bearerToken,
                'x-request-id': requestId
            }
        })
        const headers = baseHeaders

        const payload = {
            filename,
            filesize,
            filetype: filetypeSimple
        }

        const requestConfig = {
            headers,
            timeout: UPLOAD_CONFIG.timeout
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        logger.info(`请求STS Token: ${filename} (${filesize} bytes, ${filetypeSimple})`, 'UPLOAD', '🎫')

        const response = await axios.post(UPLOAD_CONFIG.stsTokenUrl, payload, requestConfig)

        if (response.status === 200 && response.data) {
            if (response.data.success === false) {
                throw new Error(response.data?.data?.message || response.data?.message || 'STS Token 请求被上游拒绝')
            }
            // 同时兼容旧版直接字段与 FE 0.2.81 的 {success,data} 包装。
            const stsData = unwrapApiData(response)

            // 验证响应数据完整性
            const credentials = {
                access_key_id: stsData.access_key_id,
                access_key_secret: stsData.access_key_secret,
                security_token: stsData.security_token
            }

            const fileInfo = {
                url: stsData.file_url,
                path: stsData.file_path,
                bucket: stsData.bucketname,
                endpoint: stsData.region + '.aliyuncs.com',
                id: stsData.file_id
            }

            // 检查必要字段
            const requiredCredentials = ['access_key_id', 'access_key_secret', 'security_token']
            const requiredFileInfo = ['url', 'path', 'bucket', 'endpoint', 'id']

            const missingCredentials = requiredCredentials.filter(key => !credentials[key])
            const missingFileInfo = requiredFileInfo.filter(key => !fileInfo[key])

            if (missingCredentials.length > 0 || missingFileInfo.length > 0) {
                logger.error(`STS响应数据不完整: 缺少 ${[...missingCredentials, ...missingFileInfo].join(', ')}`, 'UPLOAD')
                throw new Error(`STS响应数据不完整: 缺少 ${[...missingCredentials, ...missingFileInfo].join(', ')}`)
            }

            logger.success('STS Token获取成功', 'UPLOAD')
            return { credentials, file_info: fileInfo }
        } else {
            logger.error(`获取STS Token失败，状态码: ${response.status}`, 'UPLOAD')
            throw new Error(`获取STS Token失败，状态码: ${response.status}`)
        }
    } catch (error) {
        logger.error(`请求STS Token失败 (重试: ${retryCount})`, 'UPLOAD', '', error)

        // 403错误特殊处理
        if (error.response?.status === 403) {
            logger.error('403 Forbidden错误，可能是Token权限问题', 'UPLOAD')
            logger.error('认证失败，请检查Token权限', 'UPLOAD')
            throw new Error('认证失败，请检查Token权限', { cause: error })
        }

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries &&
            (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                error.response?.status >= 500)) {

            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`等待 ${delayMs}ms 后重试...`, 'UPLOAD', '⏳')
            await delay(delayMs)

            return requestStsToken(filename, filesize, filetypeSimple, authToken, retryCount + 1, account)
        }

        throw error
    }
}

/**
 * 使用STS凭证将文件Buffer上传到阿里云OSS（带重试机制）
 * @param {Buffer} fileBuffer - 文件内容的Buffer
 * @param {Object} stsCredentials - STS凭证
 * @param {Object} ossInfo - OSS信息
 * @param {string} fileContentTypeFull - 文件的完整MIME类型
 * @param {number} retryCount - 重试次数
 * @returns {Promise<Object>} 上传结果
 */
const uploadToOssWithSts = async (fileBuffer, stsCredentials, ossInfo, fileContentTypeFull, retryCount = 0) => {
    try {
        // 参数验证
        if (!fileBuffer || !stsCredentials || !ossInfo) {
            logger.error('缺少必要的上传参数', 'UPLOAD')
            throw new Error('缺少必要的上传参数')
        }

        const client = new OSS({
            accessKeyId: stsCredentials.access_key_id,
            accessKeySecret: stsCredentials.access_key_secret,
            stsToken: stsCredentials.security_token,
            bucket: ossInfo.bucket,
            endpoint: ossInfo.endpoint,
            secure: true,
            timeout: UPLOAD_CONFIG.timeout
        })

        logger.info(`上传文件到OSS: ${ossInfo.path} (${fileBuffer.length} bytes)`, 'UPLOAD', '📤')

        const result = await client.put(ossInfo.path, fileBuffer, {
            headers: {
                'Content-Type': fileContentTypeFull || 'application/octet-stream'
            }
        })

        if (result.res && result.res.status === 200) {
            logger.success('文件上传到OSS成功', 'UPLOAD')
            return { success: true, result }
        } else {
            logger.error(`OSS上传失败，状态码: ${result.res?.status || 'unknown'}`, 'UPLOAD')
            throw new Error(`OSS上传失败，状态码: ${result.res?.status || 'unknown'}`)
        }
    } catch (error) {
        logger.error(`OSS上传失败 (重试: ${retryCount})`, 'UPLOAD', '', error)

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries) {
            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`等待 ${delayMs}ms 后重试OSS上传...`, 'UPLOAD', '⏳')
            await delay(delayMs)

            return uploadToOssWithSts(fileBuffer, stsCredentials, ossInfo, fileContentTypeFull, retryCount + 1)
        }

        throw error
    }
}

/**
 * 完整的文件上传流程：获取STS Token -> 上传到OSS。
 * @param {Buffer} fileBuffer - 图片文件的Buffer。
 * @param {string} originalFilename - 原始文件名 (例如 "image.png")。
 * @param {string} authToken - 通义千问认证Token (纯token，不含Bearer)。
 * @param {Object} [account] - 账户对象（用于解析账号级代理）
 * @returns {Promise<{file_url: string, file_id: string, message: string}>} 包含上传后的URL、文件ID和成功消息。
 * @throws {Error} 如果任何步骤失败。
 */
const uploadFileToQwenOss = async (fileBuffer, originalFilename, authToken, account) => {
    try {
        // 参数验证
        if (!fileBuffer || !originalFilename || !authToken) {
            logger.error('缺少必要的上传参数', 'UPLOAD')
            throw new Error('缺少必要的上传参数')
        }

        const filesize = fileBuffer.length
        const mimeType = mimetypes.lookup(originalFilename) || 'application/octet-stream'
        const filetypeSimple = getSimpleFileType(mimeType)

        // 文件大小验证
        if (!validateFileSize(filesize)) {
            logger.error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        logger.info(`开始上传文件: ${originalFilename} (${filesize} bytes, ${mimeType})`, 'UPLOAD', '📤')

        // 第一步：获取STS Token
        const { credentials, file_info } = await requestStsToken(
            originalFilename,
            filesize,
            filetypeSimple,
            authToken,
            0,
            account
        )

        // 第二步：上传到OSS
        await uploadToOssWithSts(fileBuffer, credentials, file_info, mimeType)

        logger.success('文件上传流程完成', 'UPLOAD')

        return {
            status: 200,
            file_url: file_info.url,
            file_id: file_info.id,
            message: '文件上传成功'
        }
    } catch (error) {
        logger.error('文件上传流程失败', 'UPLOAD', '', error)
        throw error
    }
}

/**
 * 通知 Qwen 网页端解析已上传的文本文档，并等待解析完成。
 * Agent 长上下文必须通过这个步骤才能作为真正的文档上下文被模型读取。
 * @param {string} fileId
 * @param {string} authToken
 * @param {Object} [account]
 * @param {Object} [options]
 */
/**
 * 解析服务整体故障的信号。Qwen 挂掉时仍回 HTTP 200，但 body 是
 * `{"success":false,"data":{"code":"Internal_Server_Error"}}`（status 接口）或
 * `{"success":true,"data":{"code":"Internal_Server_Error"}}`（parse 接口），没有任何
 * 按文件的 status。下面的轮询把它当成「还没好」：30 次 × 500 ms = 15 s，然后报一个
 * 并非超时的「解析超时」。实测 2026-09-09 21:25 起 22/22 次都是这个形状。
 * @param {import('axios').AxiosResponse} response
 * @returns {string|null} 故障码；正常或未知时为 null
 */
/**
 * Segunda forma, medida en vivo 2026-09-10 04:29-04:54 con un probe desde el VPS:
 * getstsToken y OSS van bien, pero POST /api/v2/files/parse contesta HTTP 200 con la
 * pagina `aliyun_waf_captcha` (16 KiB de HTML, `<meta name="aliyun_waf_captcha">`).
 * axios entrega el HTML como string; para el parser JSON de arriba era "sin codigo",
 * asi que se hacian 30 sondeos y luego un "解析超时" que tampoco era timeout.
 */
const WAF_CAPTCHA_CODE = 'WAF_CAPTCHA'
const WAF_BODY_RE = /aliyun_waf|AliyunCaptcha|<!doctype html|<html[\s>]/i

const parseServiceFailureCode = (response) => {
    const body = response?.data
    const contentType = String(response?.headers?.['content-type'] || '')
    if (typeof body === 'string') {
        if (/text\/html/i.test(contentType) || WAF_BODY_RE.test(body.slice(0, 4096))) return WAF_CAPTCHA_CODE
        return 'non_json_body'
    }
    if (!body || typeof body !== 'object') return null
    const code = body.data && typeof body.data === 'object' ? body.data.code : undefined
    if (body.success === false) return String(code || body.code || body.message || 'unknown')
    if (typeof code === 'string' && /error|fail/i.test(code)) return code
    return null
}

const throwIfParseServiceFailed = (response, fileId) => {
    const code = parseServiceFailureCode(response)
    if (code === null) return
    const error = new Error(`Qwen 文档解析服务失败: ${code} (${fileId})`)
    error.code = code === WAF_CAPTCHA_CODE ? 'qwen_parse_waf_challenge' : 'qwen_parse_unavailable'
    error.parseCode = code
    throw error
}

const parseUploadedTextFile = async (fileId, authToken, account, options = {}) => {
    if (!fileId || !authToken) throw new Error('解析文档缺少 fileId 或认证 Token')

    const baseUrl = getChatBaseUrl()
    const requestConfig = await applyProxyToAxiosConfig({
        headers: createAuthorizedHeaders(authToken, account),
        timeout: Math.max(1000, Number(options.timeoutMs) || 30000)
    }, account)

    const parseResponse = await axios.post(`${baseUrl}/api/v2/files/parse`, { file_id: fileId }, requestConfig)
    throwIfParseServiceFailed(parseResponse, fileId)

    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 30)
    const intervalMs = Math.max(50, Number(options.intervalMs) || 500)
    let lastStatus = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await axios.post(
            `${baseUrl}/api/v2/files/parse/status`,
            { file_id_list: [fileId] },
            requestConfig
        )
        throwIfParseServiceFailed(response, fileId)
        const payload = unwrapApiData(response)
        const records = Array.isArray(payload) ? payload : (payload?.list || payload?.items || [])
        const record = records.find(item => item?.file_id === fileId) || records[0]
        const status = String(record?.status || payload?.status || '').toLowerCase()

        if (status === 'success' || status === 'completed' || status === 'done') return true
        if (status === 'failed' || status === 'error') {
            throw new Error(record?.error_msg || record?.message || 'Qwen 文档解析失败')
        }
        if (status) lastStatus = status
        if (attempt < maxAttempts) await delay(intervalMs)
    }

    throw new Error(`Qwen 文档解析超时: ${fileId} (last status="${lastStatus || 'none'}")`)
}

/**
 * 构造 Qwen Web 0.2.81 使用的 message.files 文档描述符。
 */
const buildChatFileDescriptor = ({ fileId, fileUrl, filename, size }) => {
    const timestamp = Date.now()
    return {
        type: 'file',
        file: {
            created_at: timestamp,
            data: {},
            filename,
            hash: null,
            id: fileId,
            meta: {
                name: filename,
                size,
                content_type: 'text/plain',
                parse_meta: { parse_status: 'success' }
            },
            update_at: timestamp,
            name: filename,
            size,
            type: 'text/plain'
        },
        id: fileId,
        url: fileUrl,
        name: filename,
        collection_name: '',
        status: 'uploaded',
        progress: 100,
        greenNet: 'success',
        size,
        error: '',
        itemId: fileId,
        file_type: 'text/plain',
        showType: 'file',
        file_class: 'document',
        context: 'full'
    }
}

/**
 * 上传并解析 Agent 长上下文，返回可直接放入 message.files 的描述符。
 */
/**
 * Cortacircuitos del parse. Con el WAF desafiando /files/parse cada intento cuesta un
 * upload a OSS + un parse (~2-3 s) y otra pagina captcha contra la cuenta, y el cliente
 * agentico vuelve cada Retry-After: 20 turnos en 5 min el 2026-09-10 04:32-04:37 (prod y
 * qwen-next, identico), 0 respuestas utiles. Tras PARSE_BREAKER_STRIKES desafios seguidos
 * se deja de subir durante `agentParseBreakerSeconds`; el 529 sale al instante con ese
 * tiempo en Retry-After y el primer parse bueno lo cierra. No es evasion del WAF: es
 * dejar de golpearlo.
 */
// Reloj inyectable: breaker y limitador comparten la fuente de tiempo para que los
// tests avancen la ventana sin dormir.
let parseClock = () => Date.now()
const nowMs = () => parseClock()
const setParseClockForTests = (fn) => { parseClock = typeof fn === 'function' ? fn : () => Date.now() }

const PARSE_BREAKER_STRIKES = 3
const parseBreaker = { strikes: 0, openUntil: 0 }

const parseBreakerRemainingSeconds = () => Math.max(0, Math.ceil((parseBreaker.openUntil - nowMs()) / 1000))

const resetParseBreaker = () => {
    parseBreaker.strikes = 0
    parseBreaker.openUntil = 0
}

/** @param {Error|null} error - null cuando el parse termino bien */
const noteParseOutcome = (error) => {
    if (!error) {
        resetParseBreaker()
        return
    }
    if (error.code !== 'qwen_parse_waf_challenge') return
    parseBreaker.strikes += 1
    const cooldownSeconds = Math.max(0, Number(config.agentParseBreakerSeconds) || 0)
    if (cooldownSeconds > 0 && parseBreaker.strikes >= PARSE_BREAKER_STRIKES) {
        parseBreaker.openUntil = nowMs() + cooldownSeconds * 1000
        error.retryAfterSeconds = cooldownSeconds
        logger.warn(`Agent 上下文解析被 WAF 连续拦截 ${parseBreaker.strikes} 次，${cooldownSeconds}s 内不再上传`, 'UPLOAD')
    }
}

const assertParseBreakerClosed = () => {
    const remaining = parseBreakerRemainingSeconds()
    if (remaining <= 0) return
    const error = new Error(`Qwen 文档解析服务失败: ${WAF_CAPTCHA_CODE} (breaker open, ${remaining}s left, upload skipped)`)
    error.code = 'qwen_parse_waf_challenge'
    error.parseCode = WAF_CAPTCHA_CODE
    error.retryAfterSeconds = remaining
    error.breakerOpen = true
    throw error
}

/**
 * Limitador de ritmo del parse. El WAF de Aliyun cuenta POST /files/parse por IP de
 * origen: el 2026-09-10 12:28-12:31 diez upload+parse en 150 s (un turno de Claude Code
 * cada ~15 s, 120-195 KB cada uno) bastaron para que empezara a desafiar; ~1/hora nunca
 * lo hace. El breaker solo reacciona DESPUES del desafio y luego bloquea 300 s. Aqui se
 * reserva un hueco ANTES de tocar STS/OSS/parse: sin hueco, 529 inmediato con Retry-After
 * corto (5-20 s) y el cliente agentico se autorregula. Los intentos limitados no llegan
 * al WAF, asi que no cuentan como strike. `agentParseMaxPerWindow` = 0 lo desactiva.
 */
const PARSE_RATE_LIMITED_CODE = 'PARSE_RATE_LIMITED'
const PARSE_RATE_RETRY_MIN_SECONDS = 5
const PARSE_RATE_RETRY_MAX_SECONDS = 20
const parseWindow = []

const resetParseRateLimiter = () => { parseWindow.length = 0 }

const takeParseSlot = () => {
    const max = Math.max(0, parseInt(config.agentParseMaxPerWindow, 10) || 0)
    if (max <= 0) return
    const windowSeconds = Math.max(1, parseInt(config.agentParseWindowSeconds, 10) || 120)
    const windowMs = windowSeconds * 1000
    const now = nowMs()
    while (parseWindow.length > 0 && parseWindow[0] <= now - windowMs) parseWindow.shift()
    if (parseWindow.length < max) {
        parseWindow.push(now)
        return
    }
    const untilFree = Math.ceil((parseWindow[0] + windowMs - now) / 1000)
    const retryAfter = Math.min(PARSE_RATE_RETRY_MAX_SECONDS, Math.max(PARSE_RATE_RETRY_MIN_SECONDS, untilFree))
    logger.warn(`Agent 上下文解析已达速率上限 (${max}/${windowSeconds}s)，${retryAfter}s 后重试`, 'UPLOAD')
    const error = new Error(`Qwen 文档解析服务失败: ${PARSE_RATE_LIMITED_CODE} (${max}/${windowSeconds}s reached, upload skipped)`)
    error.code = 'qwen_parse_rate_limited'
    error.parseCode = PARSE_RATE_LIMITED_CODE
    error.retryAfterSeconds = retryAfter
    error.breakerOpen = false
    throw error
}

const uploadAgentContextFile = async (text, authToken, account, options = {}) => {
    const content = Buffer.from(String(text || ''), 'utf8')
    if (content.length === 0) throw new Error('Agent 上下文为空')
    assertParseBreakerClosed()
    takeParseSlot()
    const filename = options.filename || `QWEN2API_AGENT_CONTEXT_${Date.now()}.txt`
    const uploaded = await uploadFileToQwenOss(content, filename, authToken, account)
    try {
        await parseUploadedTextFile(uploaded.file_id, authToken, account, options)
    } catch (error) {
        noteParseOutcome(error)
        throw error
    }
    noteParseOutcome(null)
    return buildChatFileDescriptor({
        fileId: uploaded.file_id,
        fileUrl: uploaded.file_url,
        filename,
        size: content.length
    })
}



module.exports = {
    uploadFileToQwenOss,
    parseUploadedTextFile,
    buildChatFileDescriptor,
    uploadAgentContextFile,
    resetParseBreaker,
    noteParseOutcome,
    assertParseBreakerClosed,
    takeParseSlot,
    resetParseRateLimiter,
    setParseClockForTests
}
