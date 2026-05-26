const crypto = require('crypto')
const { logger } = require('./logger')
const { getProxyAgent, getChatBaseUrl, applyProxyToFetchOptions } = require('./proxy-helper')

/**
 * 为 PKCE 生成随机代码验证器
 * @returns {string} 43-128个字符的随机字符串
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url')
}

/**
 * 使用 SHA-256 从代码验证器生成代码挑战
 * @param {string} codeVerifier - 代码验证器字符串
 * @returns {string} 代码挑战字符串
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256')
    hash.update(codeVerifier)
    return hash.digest('base64url')
}

/**
 * 生成 PKCE 代码验证器和挑战对
 * @returns {Object} 包含 code_verifier 和 code_challenge 的对象
 */
function generatePKCEPair() {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    return {
        code_verifier: codeVerifier,
        code_challenge: codeChallenge
    }
}

class CliAuthManager {
    /**
     * 读取响应体
     * @param {Response} response - Fetch 响应对象
     * @returns {Promise<*>} 响应体
     */
    async readResponseBody(response) {
        const contentType = response.headers.get('content-type') || ''
        const rawText = await response.text()

        if (!rawText) {
            return ''
        }

        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(rawText)
            } catch (error) {
                return rawText
            }
        }

        return rawText
    }

    /**
     * 启动 OAuth 设备授权流程
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 包含设备代码、验证URL和代码验证器的对象
     */
    async initiateDeviceFlow(account) {
        // 生成 PKCE 代码验证器和挑战
        const { code_verifier, code_challenge } = generatePKCEPair()

        const bodyData = new URLSearchParams({
            client_id: "f0304373b74a44d2b584a3fb70ca9e56",
            scope: "openid profile email model.completion",
            code_challenge: code_challenge,
            code_challenge_method: 'S256',
        })

        const chatBaseUrl = getChatBaseUrl()

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: bodyData,
        }

        applyProxyToFetchOptions(fetchOptions, account)

        try {
            const response = await fetch(`${chatBaseUrl}/api/v1/oauth2/device/code`, fetchOptions)

            if (response.ok) {
                const result = await response.json()
                return {
                    status: true,
                    ...result,
                    code_verifier: code_verifier
                }
            } else {
                const responseBody = await this.readResponseBody(response)
                logger.error('CLI设备授权初始化失败', 'CLI', '', {
                    status: response.status,
                    statusText: response.statusText,
                    body: responseBody
                })
                throw new Error('device_flow_failed')
            }
        } catch (error) {
            logger.error('CLI设备授权流程异常', 'CLI', '', {
                url: `${chatBaseUrl}/api/v1/oauth2/device/code`,
                message: error.message
            })
            return {
                status: false,
                device_code: null,
                user_code: null,
                verification_uri: null,
                verification_uri_complete: null,
                expires_in: null,
                code_verifier: null
            }
        }
    }

    /**
     * 授权登录
     * @param {string} user_code - 用户代码
     * @param {string} access_token - 访问令牌
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<boolean>} 是否授权成功
     */
    async authorizeLogin(user_code, access_token, account) {
        try {
            const chatBaseUrl = getChatBaseUrl()

            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    "authorization": `Bearer ${access_token}`,
                },
                body: JSON.stringify({
                    "approved": true,
                    "user_code": user_code
                })
            }

            applyProxyToFetchOptions(fetchOptions, account)

            const response = await fetch(`${chatBaseUrl}/api/v2/oauth2/authorize`, fetchOptions)

            if (response.ok) {
                return true
            } else {
                const responseBody = await this.readResponseBody(response)
                logger.error('CLI设备授权确认失败', 'CLI', '', {
                    status: response.status,
                    statusText: response.statusText,
                    body: responseBody
                })
                throw new Error('authorize_failed')
            }
        } catch (error) {
            logger.error('CLI设备授权确认异常', 'CLI', '', {
                url: `${chatBaseUrl}/api/v2/oauth2/authorize`,
                message: error.message
            })
            return false
        }
    }

    /**
     * 轮询获取访问令牌
     * @param {string} device_code - 设备代码
     * @param {string} code_verifier - 代码验证器
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 访问令牌信息
     */
    async pollForToken(device_code, code_verifier, account) {
        let pollInterval = 5000
        const maxAttempts = 3
        const chatBaseUrl = getChatBaseUrl()

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const bodyData = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: "f0304373b74a44d2b584a3fb70ca9e56",
                device_code: device_code,
                code_verifier: code_verifier,
            })

            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: bodyData,
            }

            applyProxyToFetchOptions(fetchOptions, account)

            try {
                const response = await fetch(`${chatBaseUrl}/api/v1/oauth2/token`, fetchOptions)

                if (response.ok) {
                    const tokenData = await response.json()

                    // 转换为凭据格式
                    const credentials = {
                        access_token: tokenData.access_token,
                        refresh_token: tokenData.refresh_token || undefined,
                        expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
                    }

                    if (!credentials.access_token || !credentials.refresh_token || !credentials.expiry_date) {
                        logger.error('CLI轮询令牌成功但返回数据不完整', 'CLI', '', tokenData)
                    }

                    return credentials
                }

                const responseBody = await this.readResponseBody(response)
                logger.warn(`CLI轮询令牌未完成 (${attempt + 1}/${maxAttempts})`, 'CLI', '', {
                    status: response.status,
                    statusText: response.statusText,
                    body: responseBody
                })

                // 等待5秒, 然后继续轮询
                await new Promise(resolve => setTimeout(resolve, pollInterval))
            } catch (error) {
                // 等待5秒, 然后继续轮询
                await new Promise(resolve => setTimeout(resolve, pollInterval))
                logger.error(`CLI轮询令牌异常 (${attempt + 1}/${maxAttempts})`, 'CLI', '', {
                    url: `${chatBaseUrl}/api/v1/oauth2/token`,
                    message: error.message
                })
                continue
            }
        }

        return {
            status: false,
            access_token: null,
            refresh_token: null,
            expiry_date: null
        }
    }

    /**
     * 初始化 CLI 账户
     * @param {string} access_token - 访问令牌
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 账户信息
     */
    async initCliAccount(access_token, account) {
        const deviceFlow = await this.initiateDeviceFlow(account)
        if (!deviceFlow.status) {
            logger.error('CLI账户初始化失败：设备授权流程未成功启动', 'CLI')
            return {
                status: false,
                access_token: null,
                refresh_token: null,
                expiry_date: null
            }
        }

        if (!await this.authorizeLogin(deviceFlow.user_code, access_token, account)) {
            logger.error('CLI账户初始化失败：设备授权确认未通过', 'CLI', '', {
                user_code: deviceFlow.user_code
            })
            return {
                status: false,
                access_token: null,
                refresh_token: null,
                expiry_date: null
            }
        }

        const cliToken = await this.pollForToken(deviceFlow.device_code, deviceFlow.code_verifier, account)
        if (!cliToken.access_token || !cliToken.refresh_token || !cliToken.expiry_date) {
            logger.error('CLI账户初始化失败：轮询令牌返回数据不完整', 'CLI', '', cliToken)
        }
        return cliToken
    }

    /**
     * 刷新访问令牌
     * @param {Object} CliAccount - 账户信息
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 账户信息
     */
    async refreshAccessToken(CliAccount, account) {
        try {

            if (!CliAccount || !CliAccount.refresh_token) {
                throw new Error()
            }

            const chatBaseUrl = getChatBaseUrl()

            const bodyData = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: CliAccount.refresh_token,
                client_id: "f0304373b74a44d2b584a3fb70ca9e56",
            })

            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: bodyData
            }

            applyProxyToFetchOptions(fetchOptions, account)

            const response = await fetch(`${chatBaseUrl}/api/v1/oauth2/token`, fetchOptions)

            if (response.ok) {
                const tokenData = await response.json()

                return {
                    access_token: tokenData.access_token,
                    refresh_token: tokenData.refresh_token || CliAccount.refresh_token,
                    expiry_date: Date.now() + tokenData.expires_in * 1000,
                }
            }
        } catch (error) {
            return {
                status: false,
                access_token: null,
                refresh_token: null,
                expiry_date: null
            }
        }
    }

}

module.exports = new CliAuthManager()
