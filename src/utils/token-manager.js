const axios = require('axios')
const { sha256Encrypt, JwtDecode } = require('./tools')
const { logger } = require('./logger')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('./proxy-helper')

/**
 * 令牌管理器
 * 负责令牌的获取、验证、刷新等操作
 */
class TokenManager {
    constructor() {
        this.defaultHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
        }
    }

    /**
     * 获取登录端点
     * @returns {string} 登录端点URL
     */
    get loginEndpoint() {
        return `${getChatBaseUrl()}/api/v1/auths/signin`
    }

    /**
     * 用户登录获取令牌
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {Object} [account] - 账户对象（用于解析账号级代理；为空时回退到全局 PROXY_URL）
     * @returns {Promise<string|null>} 令牌或null
     */
    async login(email, password, account) {
        try {
            const proxyAgent = getProxyAgent(account)
            const requestConfig = {
                headers: this.defaultHeaders,
                timeout: 10000 // 10秒超时
            }

            // 添加代理配置
            if (proxyAgent) {
                requestConfig.httpsAgent = proxyAgent
                requestConfig.proxy = false
            }

            const requestBody = {
                email: email,
                password: sha256Encrypt(password)
            }

            console.log('登录请求:', {
                url: this.loginEndpoint,
                headers: requestConfig.headers,
                body: { email: email, password: '***已加密***' },
                proxy: requestConfig.proxy,
                hasHttpsAgent: !!requestConfig.httpsAgent
            })

            const response = await axios.post(this.loginEndpoint, requestBody, requestConfig)

            console.log('登录响应:', {
                status: response.status,
                headers: response.headers,
                data: response.data,
                hasToken: !!response.data?.token
            })

            if (response.data && response.data.token) {
                logger.success(`${email} 登录成功：${response.data.token}`, 'AUTH')
                return response.data.token
            } else {
                logger.error(`${email} 登录响应缺少令牌`, 'AUTH')
                return null
            }
        } catch (error) {
            if (error.response) {
                logger.error(`${email} 登录失败 (${error.response.status})`, 'AUTH', '', error)
            } else if (error.request) {
                logger.error(`${email} 登录失败: 网络请求超时或无响应`, 'AUTH')
            } else {
                logger.error(`${email} 登录失败`, 'AUTH', '', error)
            }
            return null
        }
    }

    /**
     * 验证令牌是否有效
     * @param {string} token - JWT令牌
     * @returns {Object|null} 解码后的令牌信息或null
     */
    validateToken(token) {
        try {
            if (!token) return null

            const decoded = JwtDecode(token)
            if (!decoded || !decoded.exp) {
                return null
            }

            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) {
                return null // 令牌已过期
            }

            return decoded
        } catch (error) {
            logger.error('令牌验证失败', 'TOKEN', '', error)
            return null
        }
    }

    /**
     * 检查令牌是否即将过期
     * @param {string} token - JWT令牌
     * @param {number} thresholdHours - 过期阈值（小时）
     * @returns {boolean} 是否即将过期
     */
    isTokenExpiringSoon(token, thresholdHours = 6) {
        const decoded = this.validateToken(token)
        if (!decoded) return true // 无效令牌视为即将过期

        const now = Math.floor(Date.now() / 1000)
        const thresholdSeconds = thresholdHours * 60 * 60
        return decoded.exp - now < thresholdSeconds
    }

    /**
     * 获取令牌剩余有效时间（小时）
     * @param {string} token - JWT令牌
     * @returns {number} 剩余小时数，-1表示无效令牌
     */
    getTokenRemainingHours(token) {
        const decoded = this.validateToken(token)
        if (!decoded) return -1

        const now = Math.floor(Date.now() / 1000)
        const remainingSeconds = decoded.exp - now
        return Math.max(0, Math.round(remainingSeconds / 3600))
    }

    /**
     * 刷新单个账户的令牌
     * @param {Object} account - 账户对象 {email, password, token, expires}
     * @returns {Promise<Object|null>} 更新后的账户对象或null
     */
    async refreshToken(account) {
        try {
            const newToken = await this.login(account.email, account.password, account)
            if (!newToken) {
                return null
            }

            const decoded = this.validateToken(newToken)
            if (!decoded) {
                logger.error(`刷新后的令牌无效: ${account.email}`, 'TOKEN')
                return null
            }

            const updatedAccount = {
                ...account,
                token: newToken,
                expires: decoded.exp
            }

            const remainingHours = this.getTokenRemainingHours(newToken)
            logger.success(`令牌刷新成功: ${account.email} (有效期: ${remainingHours}小时)`, 'TOKEN')

            return updatedAccount
        } catch (error) {
            logger.error(`刷新令牌失败 (${account.email})`, 'TOKEN', '', error)
            return null
        }
    }

    /**
     * 批量刷新即将过期的令牌
     * @param {Array} accounts - 账户列表
     * @param {number} thresholdHours - 过期阈值（小时）
     * @param {Function} onEachRefresh - 每次刷新成功后的回调函数 (updatedAccount, index, total) => void
     * @returns {Promise<Object>} 刷新结果 {refreshed: Array, failed: Array}
     */
    async batchRefreshTokens(accounts, thresholdHours = 24, onEachRefresh = null) {
        const needsRefresh = accounts.filter(account =>
            this.isTokenExpiringSoon(account.token, thresholdHours)
        )

        if (needsRefresh.length === 0) {
            logger.info('没有需要刷新的令牌', 'TOKEN')
            return { refreshed: [], failed: [] }
        }

        logger.info(`发现 ${needsRefresh.length} 个令牌需要刷新`, 'TOKEN')

        const refreshed = []
        const failed = []

        for (let i = 0; i < needsRefresh.length; i++) {
            const account = needsRefresh[i]
            const updatedAccount = await this.refreshToken(account)

            if (updatedAccount) {
                refreshed.push(updatedAccount)

                // 如果提供了回调函数，立即调用
                if (onEachRefresh && typeof onEachRefresh === 'function') {
                    try {
                        await onEachRefresh(updatedAccount, i + 1, needsRefresh.length)
                    } catch (error) {
                        logger.error(`刷新回调函数执行失败 (${account.email})`, 'TOKEN', '', error)
                    }
                }
            } else {
                failed.push(account)
            }

            // 添加延迟避免请求过于频繁
            await this._delay(1000)
        }

        logger.success(`令牌刷新完成: 成功 ${refreshed.length} 个，失败 ${failed.length} 个`, 'TOKEN')
        return { refreshed, failed }
    }

    /**
     * 获取健康的令牌统计信息
     * @param {Array} accounts - 账户列表
     * @returns {Object} 统计信息
     */
    getTokenHealthStats(accounts) {
        const stats = {
            total: accounts.length,
            valid: 0,
            expired: 0,
            expiringSoon: 0,
            invalid: 0
        }

        accounts.forEach(account => {
            if (!account.token) {
                stats.invalid++
                return
            }

            const decoded = this.validateToken(account.token)
            if (!decoded) {
                stats.invalid++
                return
            }

            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) {
                stats.expired++
            } else if (this.isTokenExpiringSoon(account.token, 6)) {
                stats.expiringSoon++
            } else {
                stats.valid++
            }
        })

        return stats
    }

    /**
     * 延迟函数
     * @param {number} ms - 延迟毫秒数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

module.exports = TokenManager
