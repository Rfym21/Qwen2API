const axios = require('axios')
const OSS = require('ali-oss')
const mimetypes = require('mime-types')
const { logger } = require('./logger')
const { generateUUID } = require('./tools.js')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('./proxy-helper')

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

const createAuthorizedHeaders = (authToken) => ({
    'Authorization': authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
})

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
            logger.error('Filename and auth token cannot be empty', 'UPLOAD')
            throw new Error('Filename and auth token cannot be empty')
        }

        if (!validateFileSize(filesize)) {
            logger.error(`File size exceeds limit, max allowed ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`File size exceeds limit, max allowed ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        const requestId = generateUUID()
        const bearerToken = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
        const proxyAgent = getProxyAgent(account)

        const headers = {
            'Authorization': bearerToken,
            'Content-Type': 'application/json',
            'x-request-id': requestId,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }

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

        logger.info(`Requesting STS Token: ${filename} (${filesize} bytes, ${filetypeSimple})`, 'UPLOAD', '🎫')

        const response = await axios.post(UPLOAD_CONFIG.stsTokenUrl, payload, requestConfig)

        if (response.status === 200 && response.data) {
            if (response.data.success === false) {
                throw new Error(response.data?.data?.message || response.data?.message || 'STS Token request rejected by upstream')
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
                logger.error(`STS response incomplete: missing ${[...missingCredentials, ...missingFileInfo].join(', ')}`, 'UPLOAD')
                throw new Error(`STS response incomplete: missing ${[...missingCredentials, ...missingFileInfo].join(', ')}`)
            }

            logger.success('STS Token obtained successfully', 'UPLOAD')
            return { credentials, file_info: fileInfo }
        } else {
            logger.error(`Failed to get STS Token, status code: ${response.status}`, 'UPLOAD')
            throw new Error(`Failed to get STS Token, status code: ${response.status}`)
        }
    } catch (error) {
        logger.error(`Failed to request STS Token (retry: ${retryCount})`, 'UPLOAD', '', error)

        // 403错误特殊处理
        if (error.response?.status === 403) {
            logger.error('403 Forbidden, possible token permission issue', 'UPLOAD')
            logger.error('Auth failed, please check token permissions', 'UPLOAD')
            throw new Error('Auth failed, please check token permissions')
        }

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries &&
            (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                error.response?.status >= 500)) {

            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`Retrying in ${delayMs}ms...`, 'UPLOAD', '⏳')
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
            logger.error('Missing required upload parameters', 'UPLOAD')
            throw new Error('Missing required upload parameters')
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

        logger.info(`Uploading file to OSS: ${ossInfo.path} (${fileBuffer.length} bytes)`, 'UPLOAD', '📤')

        const result = await client.put(ossInfo.path, fileBuffer, {
            headers: {
                'Content-Type': fileContentTypeFull || 'application/octet-stream'
            }
        })

        if (result.res && result.res.status === 200) {
            logger.success('File uploaded to OSS successfully', 'UPLOAD')
            return { success: true, result }
        } else {
            logger.error(`OSS upload failed, status code: ${result.res?.status || 'unknown'}`, 'UPLOAD')
            throw new Error(`OSS upload failed, status code: ${result.res?.status || 'unknown'}`)
        }
    } catch (error) {
        logger.error(`OSS upload failed (retry: ${retryCount})`, 'UPLOAD', '', error)

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries) {
            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`Retrying in ${delayMs}ms... (OSS retry)`, 'UPLOAD', '⏳')
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
            logger.error('Missing required upload parameters', 'UPLOAD')
            throw new Error('Missing required upload parameters')
        }

        const filesize = fileBuffer.length
        const mimeType = mimetypes.lookup(originalFilename) || 'application/octet-stream'
        const filetypeSimple = getSimpleFileType(mimeType)

        // 文件大小验证
        if (!validateFileSize(filesize)) {
            logger.error(`File size exceeds limit, max allowed ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`File size exceeds limit, max allowed ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        logger.info(`Starting file upload: ${originalFilename} (${filesize} bytes, ${mimeType})`, 'UPLOAD', '📤')

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

        logger.success('File upload process complete', 'UPLOAD')

        return {
            status: 200,
            file_url: file_info.url,
            file_id: file_info.id,
            message: '文件上传成功'
        }
    } catch (error) {
        logger.error('File upload process failed', 'UPLOAD', '', error)
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
const parseUploadedTextFile = async (fileId, authToken, account, options = {}) => {
    if (!fileId || !authToken) throw new Error('Parsed document missing fileId or auth token')

    const baseUrl = getChatBaseUrl()
    const requestConfig = applyProxyToAxiosConfig({
        headers: createAuthorizedHeaders(authToken),
        timeout: Math.max(1000, Number(options.timeoutMs) || 30000)
    }, account)

    await axios.post(`${baseUrl}/api/v2/files/parse`, { file_id: fileId }, requestConfig)

    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 30)
    const intervalMs = Math.max(50, Number(options.intervalMs) || 500)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await axios.post(
            `${baseUrl}/api/v2/files/parse/status`,
            { file_id_list: [fileId] },
            requestConfig
        )
        const payload = unwrapApiData(response)
        const records = Array.isArray(payload) ? payload : (payload?.list || payload?.items || [])
        const record = records.find(item => item?.file_id === fileId) || records[0]
        const status = String(record?.status || payload?.status || '').toLowerCase()

        if (status === 'success' || status === 'completed' || status === 'done') return true
        if (status === 'failed' || status === 'error') {
            throw new Error(record?.error_msg || record?.message || 'Qwen document parsing failed')
        }
        if (attempt < maxAttempts) await delay(intervalMs)
    }

    throw new Error(`Qwen document parsing timeout: ${fileId}`)
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
const uploadAgentContextFile = async (text, authToken, account, options = {}) => {
    const content = Buffer.from(String(text || ''), 'utf8')
    if (content.length === 0) throw new Error('Agent context is empty')
    const filename = options.filename || `QWEN2API_AGENT_CONTEXT_${Date.now()}.txt`
    const uploaded = await uploadFileToQwenOss(content, filename, authToken, account)
    await parseUploadedTextFile(uploaded.file_id, authToken, account, options)
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
    uploadAgentContextFile
}
