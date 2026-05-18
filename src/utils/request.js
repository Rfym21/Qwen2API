const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('./proxy-helper')

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

/**
 * 发送聊天请求
 * @param {Object} body - 请求体
 * @returns {Promise<Object>} 响应结果
 */
const sendChatRequest = async (body) => {
    // 获取可用的账户（包含 proxy 等完整字段）
    const currentAccount = accountManager.getAccount()
    const currentToken = currentAccount ? currentAccount.token : null

    if (!currentToken) {
        logger.error('无法获取有效的访问令牌', 'TOKEN')
        return {
            status: false,
            response: null
        }
    }

    const chatBaseUrl = getChatBaseUrl()
    const proxyAgent = getProxyAgent(currentAccount)

    // 构建请求配置
    const requestConfig = {
        headers: {
            'Authorization': `Bearer ${currentToken}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
            "Connection": "keep-alive",
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Content-Type": "application/json",
            "Timezone": "Mon Dec 08 2025 17:28:55 GMT+0800",
            "sec-ch-ua": "\"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
            "source": "web",
            "Version": "0.1.13",
            "bx-v": "2.5.31",
            "Origin": chatBaseUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            "Referer": `${chatBaseUrl}/c/guest`,
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "Cookie": `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
        },
        responseType: 'stream', // Always use streaming (upstream doesn't support stream=false)
        timeout: 60 * 1000,
    }

    // 添加代理配置
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false // 禁用axios默认代理，使用httpsAgent
    }

    const chat_id = await generateChatID(currentToken, body.model, currentAccount)
    const url = `${chatBaseUrl}/api/v2/chat/completions?chat_id=` + chat_id
    const payload = { ...body, stream: true, chat_id }

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
const generateChatID = async (currentToken, model, account) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const proxyAgent = getProxyAgent(account)

        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${currentToken}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                "Connection": "keep-alive",
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Content-Type": "application/json",
                "Timezone": "Mon Dec 08 2025 17:28:55 GMT+0800",
                "sec-ch-ua": "\"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                "source": "web",
                "Version": "0.1.13",
                "bx-v": "2.5.31",
                "Origin": chatBaseUrl,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                "Referer": `${chatBaseUrl}/c/guest`,
                "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cookie": `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
            }
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
            "title": "New Chat",
            "models": [
                model
            ],
            "chat_mode": "local",
            "chat_type": "t2i",
            "timestamp": new Date().getTime()
        }, requestConfig)

        // console.log(response_data.data)

        return response_data.data?.data?.id || null

    } catch (error) {
        logger.error('生成chat_id失败', 'CHAT', '', error.message)
        return null
    }
}

module.exports = {
    sendChatRequest,
    generateChatID
}