const config = require('../config/index.js')
const DataPersistence = require('./data-persistence')
const TokenManager = require('./token-manager')
const AccountRotator = require('./account-rotator')
const { logger } = require('./logger')

/**
 * 默认 daily stats 结构。返回新对象，调用方安全修改
 * @returns {Object} default stats
 */
const createDefaultStats = () => ({
    chat: { input: 0, output: 0 },
    cli: { calls: 0, input: 0, output: 0 }
})

/**
 * 保证账户具备 stats 和 statsHistory 字段（兼容老 data.json/Redis 数据）
 * @param {Object} account - 账户对象
 */
const ensureStats = (account) => {
    if (!account) return
    if (!account.stats || typeof account.stats !== 'object') {
        account.stats = createDefaultStats()
    } else {
        if (!account.stats.chat || typeof account.stats.chat !== 'object') {
            account.stats.chat = { input: 0, output: 0 }
        } else {
            account.stats.chat.input = Number(account.stats.chat.input) || 0
            account.stats.chat.output = Number(account.stats.chat.output) || 0
        }
        if (!account.stats.cli || typeof account.stats.cli !== 'object') {
            account.stats.cli = { calls: 0, input: 0, output: 0 }
        } else {
            account.stats.cli.calls = Number(account.stats.cli.calls) || 0
            account.stats.cli.input = Number(account.stats.cli.input) || 0
            account.stats.cli.output = Number(account.stats.cli.output) || 0
        }
    }
    // statsHistory: { 'YYYY-MM-DD': { chat:{input,output}, cli:{calls,input,output} } }
    // Backward-compat: legacy records without the field — initialize to {}
    if (!account.statsHistory || typeof account.statsHistory !== 'object') {
        account.statsHistory = {}
    }
}

/**
 * YYYY-MM-DD date key for (now + offsetDays) in Node process local TZ
 * @param {number} offsetDays - day offset (negative = past)
 * @returns {string}
 */
const _formatDateKey = (offsetDays) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const _getTodayKey = () => _formatDateKey(0)
const _getYesterdayKey = () => _formatDateKey(-1)
const _dateKeyDaysAgo = (n) => _formatDateKey(-n)

const _hasNonZeroStats = (stats) => {
    if (!stats || typeof stats !== 'object') return false
    const c = stats.chat || {}
    const l = stats.cli || {}
    return (Number(c.input) || 0) > 0
        || (Number(c.output) || 0) > 0
        || (Number(l.calls) || 0) > 0
        || (Number(l.input) || 0) > 0
        || (Number(l.output) || 0) > 0
}

const STATS_HISTORY_RETENTION_DAYS = 90
/**
 * 账户管理器
 * 统一管理账户、令牌、模型等功能
 */
class Account {
    constructor() {
        // 初始化各个管理器
        this.dataPersistence = new DataPersistence()
        this.tokenManager = new TokenManager()
        this.accountRotator = new AccountRotator()

        // 账户数据
        this.accountTokens = []
        this.isInitialized = false

        // 配置信息
        this.defaultHeaders = config.defaultHeaders || {}

        // cli请求次数定时刷新器
        this.cliRequestNumberInterval = null
        this.cliDailyResetInterval = null

        // Keep the init promise so debug methods can await readiness
        this._initPromise = this._initialize()
    }

    /**
     * 异步初始化
     * @private
     */
    async _initialize() {
        try {
            // 加载账户信息
            await this.loadAccountTokens()

            // 设置定期刷新令牌
            if (config.autoRefresh) {
                this.refreshInterval = setInterval(
                    () => this.autoRefreshTokens(),
                    (config.autoRefreshInterval || 21600) * 1000 // 默认6小时
                )
            }

            this.isInitialized = true
            logger.success(`账户管理器初始化完成，共加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')
        } catch (error) {
            this.isInitialized = false
            logger.error('账户管理器初始化失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * 加载账户令牌数据
     * @returns {Promise<void>}
     */
    async loadAccountTokens() {
        try {
            this.accountTokens = await this.dataPersistence.loadAccounts()

            // 兼容历史数据：旧 data.json/Redis 没有 stats 字段
            this.accountTokens.forEach(ensureStats)

            // 如果是环境变量模式，需要进行登录获取令牌
            if (config.dataSaveMode === 'none' && this.accountTokens.length > 0) {
                await this._loginEnvironmentAccounts()
            }

            // 验证和清理无效令牌
            await this._validateAndCleanTokens()

            // 更新账户轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 初始化 CLI 账户（后台执行，不阻塞 chat-flow init）
            // 为所有账户启动 CLI 初始化，确保没有 CLI 额度的账号被正确标记为 unsupported
            if (this.accountTokens.length > 0) {
                logger.info(`后台初始化所有 ${this.accountTokens.length} 个账户的 CLI`, 'ACCOUNT')
                Promise.allSettled(
                    this.accountTokens.map(account => this._initializeCliAccount(account))
                ).then(() => {
                    const cliReady = this.accountTokens.filter(a => a.cli_info).length
                    const cliUnsupported = this.accountTokens.filter(a => a.cli_unavailable_reason === 'unsupported').length
                    logger.success(`CLI 初始化完成: ${cliReady} 个可用, ${cliUnsupported} 个不支持`, 'CLI')
                })
            }

            // 设置cli定时器 每天00:00:00刷新请求次数
            this._setupDailyResetTimer()

            logger.success(`成功加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')
        } catch (error) {
            logger.error('加载账户令牌失败', 'ACCOUNT', '', error)
            this.accountTokens = []
            this.accountRotator.setAccounts(this.accountTokens)
            throw error
        }
    }

    /**
     * 为环境变量模式的账户进行登录
     * @private
     */
    async _loginEnvironmentAccounts() {
        const loginPromises = this.accountTokens.map(async (account) => {
            if (!account.token && account.email && account.password) {
                const token = await this.tokenManager.login(account.email, account.password, account)
                if (token) {
                    const decoded = this.tokenManager.validateToken(token)
                    if (decoded) {
                        account.token = token
                        account.expires = decoded.exp
                    }
                }
            }
            return account
        })

        this.accountTokens = await Promise.all(loginPromises)
    }

    /**
     * 初始化CLI账户
     * @param {Object} account - 账户对象
     * @private
     */
    async _initializeCliAccount(account) {
        try {
            const cliManager = require('./cli.manager')
            const cliAccount = await cliManager.initCliAccount(account.token, account)

            if (cliAccount.access_token && cliAccount.refresh_token && cliAccount.expiry_date) {
                account.cli_unavailable_reason = null
                account.cli_info = {
                    access_token: cliAccount.access_token,
                    refresh_token: cliAccount.refresh_token,
                    expiry_date: cliAccount.expiry_date,
                    refresh_token_interval: setInterval(async () => {
                        try {
                            const refreshToken = await cliManager.refreshAccessToken({
                                access_token: account.cli_info.access_token,
                                refresh_token: account.cli_info.refresh_token,
                                expiry_date: account.cli_info.expiry_date
                            }, account)
                            if (refreshToken.access_token && refreshToken.refresh_token && refreshToken.expiry_date) {
                                account.cli_info.access_token = refreshToken.access_token
                                account.cli_info.refresh_token = refreshToken.refresh_token
                                account.cli_info.expiry_date = refreshToken.expiry_date
                                logger.info(`CLI账户 ${account.email} 令牌刷新成功`, 'CLI')
                            }
                        } catch (error) {
                            logger.error(`CLI账户 ${account.email} 令牌刷新失败`, 'CLI', '', error)
                        }
                        // 每2小时刷新一次
                    }, 1000 * 60 * 60 * 2),
                    request_number: 0
                }
                logger.success(`CLI账户 ${account.email} 初始化成功`, 'CLI')
            } else {
                account.cli_info = null
                account.cli_unavailable_reason = 'unsupported'
                logger.error(`CLI账户 ${account.email} 初始化失败：无效的响应数据`, 'CLI', '', cliAccount)
            }
        } catch (error) {
            account.cli_info = null
            account.cli_unavailable_reason = 'unsupported'
            logger.error(`CLI账户 ${account.email} 初始化失败`, 'CLI', '', error)
        }
    }

    /**
     * 设置每日重置定时器
     * @private
     */
    _setupDailyResetTimer() {
        logger.info('设置每日 00:00 重置定时器（CLI 请求次数 + daily stats）', 'CLI')

        // 计算到下一天00:00:00的毫秒数
        const now = new Date()
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)
        const timeDiff = tomorrow.getTime() - now.getTime()

        logger.info(`距离下次重置还有 ${Math.round(timeDiff / 1000 / 60)} 分钟`, 'CLI')

        // 首次执行使用setTimeout
        this.cliRequestNumberInterval = setTimeout(() => {
            this._resetDailyCounters()

            // 设置每24小时执行一次的定时器
            this.cliDailyResetInterval = setInterval(() => {
                this._resetDailyCounters()
            }, 24 * 60 * 60 * 1000)
        }, timeDiff)
    }

    /**
     * Daily 00:00 reset: CLI request counters + chat/cli daily stats.
     * Before zeroing, snapshot yesterday into account.statsHistory and prune
     * entries older than STATS_HISTORY_RETENTION_DAYS days, then a single
     * saveAllAccounts batch (instead of 30 individual saves).
     *
     * Caveats:
     * - PM2_INSTANCES > 1: each worker archives its own partial copy of stats;
     *   the daily total would be under-reported proportionally to the worker
     *   count. With instances=1 (ecosystem.config.js default) this is not
     *   triggered.
     * - DATA_SAVE_MODE=none: saveAllAccounts returns false and history is not
     *   persisted. Set DATA_SAVE_MODE=file or redis to enable the feature.
     * @private
     */
    async _resetDailyCounters() {
        // CLI 请求计数（旧逻辑）
        const cliAccounts = this.accountTokens.filter(account => account.cli_info)
        cliAccounts.forEach(account => {
            account.cli_info.request_number = 0
        })

        const yesterday = _getYesterdayKey()
        const cutoff = _dateKeyDaysAgo(STATS_HISTORY_RETENTION_DAYS)
        let archivedCount = 0

        // For every account (including inactive ones) prune old history;
        // for accounts with any non-zero counters, snapshot yesterday.
        this.accountTokens.forEach(account => {
            ensureStats(account)

            // Date-based pruning (string compare is valid for YYYY-MM-DD).
            for (const key of Object.keys(account.statsHistory)) {
                if (key < cutoff) {
                    delete account.statsHistory[key]
                }
            }

            // Snapshot only if there was at least one non-zero counter.
            if (_hasNonZeroStats(account.stats)) {
                account.statsHistory[yesterday] = {
                    chat: { ...account.stats.chat },
                    cli: { ...account.stats.cli }
                }
                archivedCount++
            }

            // Reset today.
            account.stats.chat.input = 0
            account.stats.chat.output = 0
            account.stats.cli.calls = 0
            account.stats.cli.input = 0
            account.stats.cli.output = 0
        })

        logger.info(
            `已重置 ${cliAccounts.length} 个CLI账户请求次数 + ${this.accountTokens.length} 个账户 daily stats，归档 ${archivedCount} 条 statsHistory[${yesterday}]`,
            'CLI'
        )

        // Single batch save. In file mode — one data.json rewrite; in redis
        // mode — sequential HSETs (the saveAccountStats debounce is not used).
        try {
            await this.dataPersistence.saveAllAccounts(this.accountTokens)
        } catch (error) {
            logger.error('每日重置后 persist 失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * Public helper: today's YYYY-MM-DD key in Node process local TZ.
     * Paired with the _getYesterdayKey used inside _resetDailyCounters.
     * The /statsHistory route must use this rather than new Date() in the
     * browser — otherwise differing browser/container TZs can shift month
     * boundaries.
     * @returns {string}
     */
    getTodayKey() {
        return _getTodayKey()
    }

    /**
     * Debug: manual trigger for archive/reset (used by the dev endpoint).
     * The readiness guard prevents wiping data.accounts = [] before init finishes.
     * @returns {Promise<void>}
     */
    async archiveYesterdayForTest() {
        if (this._initPromise) {
            await this._initPromise
        }
        if (!this.isInitialized || !Array.isArray(this.accountTokens) || this.accountTokens.length === 0) {
            throw new Error('account manager not initialized — refusing to archive (would wipe data)')
        }
        return this._resetDailyCounters()
    }

    /**
     * 重置CLI请求次数（向后兼容别名）
     * @private
     */
    _resetCliRequestNumbers() {
        return this._resetDailyCounters()
    }

    /**
     * 验证和清理无效令牌
     * @private
     */
    async _validateAndCleanTokens() {
        const validAccounts = []

        for (const account of this.accountTokens) {
            if (account.token && this.tokenManager.validateToken(account.token)) {
                validAccounts.push(account)
            } else if (account.email && account.password) {
                // 尝试重新登录
                logger.info(`令牌无效，尝试重新登录: ${account.email}`, 'TOKEN', '🔄')
                const newToken = await this.tokenManager.login(account.email, account.password, account)
                if (newToken) {
                    const decoded = this.tokenManager.validateToken(newToken)
                    if (decoded) {
                        account.token = newToken
                        account.expires = decoded.exp
                        validAccounts.push(account)
                    }
                }
            }
        }

        this.accountTokens = validAccounts
    }


    /**
     * 自动刷新即将过期的令牌
     * @param {number} thresholdHours - 过期阈值（小时）
     * @returns {Promise<number>} 成功刷新的令牌数量
     */
    async autoRefreshTokens(thresholdHours = 24) {
        if (!this.isInitialized) {
            logger.warn('账户管理器尚未初始化，跳过自动刷新', 'TOKEN')
            return 0
        }

        logger.info('开始自动刷新令牌...', 'TOKEN', '🔄')

        // 获取需要刷新的账户
        const needsRefresh = this.accountTokens.filter(account =>
            this.tokenManager.isTokenExpiringSoon(account.token, thresholdHours)
        )

        if (needsRefresh.length === 0) {
            logger.info('没有需要刷新的令牌', 'TOKEN')
            return 0
        }

        logger.info(`发现 ${needsRefresh.length} 个令牌需要刷新`, 'TOKEN')

        let successCount = 0
        let failedCount = 0

        // 逐个刷新账户，每次成功后立即保存
        for (const account of needsRefresh) {
            try {
                const updatedAccount = await this.tokenManager.refreshToken(account)
                if (updatedAccount) {
                    // 立即更新内存中的账户数据
                    const index = this.accountTokens.findIndex(acc => acc.email === account.email)
                    if (index !== -1) {
                        this.accountTokens[index] = updatedAccount
                    }

                    // 立即保存到持久化存储
                    await this.dataPersistence.saveAccount(account.email, {
                        password: updatedAccount.password,
                        token: updatedAccount.token,
                        expires: updatedAccount.expires,
                        proxy: updatedAccount.proxy ?? account.proxy ?? null
                    })

                    // 重置失败计数
                    this.accountRotator.resetFailures(account.email)
                    successCount++

                    logger.info(`账户 ${account.email} 令牌刷新并保存成功 (${successCount}/${needsRefresh.length})`, 'TOKEN', '✅')
                } else {
                    // 记录失败的账户
                    this.accountRotator.recordFailure(account.email)
                    failedCount++
                    logger.error(`账户 ${account.email} 令牌刷新失败 (${failedCount} 个失败)`, 'TOKEN', '❌')
                }
            } catch (error) {
                this.accountRotator.recordFailure(account.email)
                failedCount++
                logger.error(`账户 ${account.email} 刷新过程中出错`, 'TOKEN', '', error)
            }

            // 添加延迟避免请求过于频繁
            await this._delay(1000)
        }

        // 更新轮询器
        this.accountRotator.setAccounts(this.accountTokens)

        logger.success(`令牌刷新完成: 成功 ${successCount} 个，失败 ${failedCount} 个`, 'TOKEN')
        return successCount
    }

    /**
     * 获取下一个可用的账户对象（包含 proxy 等完整字段）
     * @returns {Object|null} 账户对象或 null
     */
    getAccount() {
        if (!this.isInitialized) {
            logger.warn('账户管理器尚未初始化完成', 'ACCOUNT')
            return null
        }

        if (this.accountTokens.length === 0) {
            logger.error('没有可用的账户令牌', 'ACCOUNT')
            return null
        }

        const account = this.accountRotator.getNextAccount()
        if (!account) {
            logger.error('所有账户令牌都不可用', 'ACCOUNT')
        }

        return account
    }

    /**
     * 获取可用的账户令牌（向后兼容的便捷方法）
     * @returns {string|null} 账户令牌或null
     */
    getAccountToken() {
        const account = this.getAccount()
        return account ? account.token : null
    }

    /**
     * 根据邮箱获取特定账户对象
     * @param {string} email - 邮箱地址
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByEmail(email) {
        return this.accountRotator.getAccountByEmail(email)
    }

    /**
     * 根据令牌反查账户对象（用于只持有 token 的下游调用解析账号级代理）
     * @param {string} token - 访问令牌
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByToken(token) {
        if (!token) return null
        return this.accountTokens.find(acc => acc.token === token) || null
    }

    /**
     * 根据邮箱获取特定账户的令牌（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {string|null} 账户令牌或null
     */
    getTokenByEmail(email) {
        return this.accountRotator.getTokenByEmail(email)
    }

    /**
     * 保存更新后的账户数据
     * @param {Array} updatedAccounts - 更新后的账户列表
     * @private
     */
    async _saveUpdatedAccounts(updatedAccounts) {
        try {
            for (const account of updatedAccounts) {
                await this.dataPersistence.saveAccount(account.email, {
                    password: account.password,
                    token: account.token,
                    expires: account.expires,
                    proxy: account.proxy ?? null
                })
            }
        } catch (error) {
            logger.error('保存更新后的账户数据失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * 手动刷新指定账户的令牌
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 刷新是否成功
     */
    async refreshAccountToken(email) {
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) {
            logger.error(`未找到邮箱为 ${email} 的账户`, 'ACCOUNT')
            return false
        }

        const updatedAccount = await this.tokenManager.refreshToken(account)
        if (updatedAccount) {
            // 更新内存中的数据
            const index = this.accountTokens.findIndex(acc => acc.email === email)
            if (index !== -1) {
                this.accountTokens[index] = updatedAccount
            }

            // 保存到持久化存储
            await this.dataPersistence.saveAccount(email, {
                password: updatedAccount.password,
                token: updatedAccount.token,
                expires: updatedAccount.expires,
                proxy: updatedAccount.proxy ?? account.proxy ?? null
            })

            // 重置失败计数
            this.accountRotator.resetFailures(email)

            return true
        }

        return false
    }

    // 更新销毁方法，清除定时器
    destroy() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval)
        }
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
        }
    }



    /**
     * 生成 Markdown 表格
     * @param {Array} websites - 网站信息数组
     * @param {string} mode - 模式 ('table' 或 'text')
     * @returns {Promise<string>} Markdown 字符串
     */
    async generateMarkdownTable(websites, mode) {
        // 输入校验
        if (!Array.isArray(websites) || websites.length === 0) {
            return ''
        }

        let markdown = ''
        if (mode === 'table') {
            markdown += '| **序号** | **网站URL** | **来源** |\n'
            markdown += '|:---|:---|:---|\n'
        }

        // 默认值
        const DEFAULT_TITLE = '未知标题'
        const DEFAULT_URL = 'https://www.baidu.com'
        const DEFAULT_HOSTNAME = '未知来源'

        // 表格内容
        websites.forEach((site, index) => {
            const { title, url, hostname } = site
            // 处理字段值，若为空则使用默认值
            const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`
            const hostnameCell = hostname || DEFAULT_HOSTNAME
            if (mode === 'table') {
                markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`
            } else {
                markdown += `[${index + 1}] ${urlCell} | 来源: ${hostnameCell}\n`
            }
        })

        return markdown
    }



    /**
     * 获取所有账户信息
     * @returns {Array} 账户列表
     */
    getAllAccountKeys() {
        return this.accountTokens
    }

    /**
     * 用户登录（委托给 TokenManager）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @returns {Promise<string|null>} 令牌或null
     */
    async login(email, password, proxy) {
        const accountLike = proxy ? { proxy } : undefined
        return await this.tokenManager.login(email, password, accountLike)
    }

    /**
     * 获取账户健康状态统计
     * @returns {Object} 健康状态统计
     */
    getHealthStats() {
        const tokenStats = this.tokenManager.getTokenHealthStats(this.accountTokens)
        const rotatorStats = this.accountRotator.getStats()

        return {
            accounts: tokenStats,
            rotation: rotatorStats,
            initialized: this.isInitialized
        }
    }

    /**
     * 记录账户传输层失败（影响 cooldown）
     * 仅在 timeout/ECONNRESET 等传输层错误调用——HTTP 4xx/5xx 走 recordAccountError
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - 错误码（err.code 或 HTTP status）
     */
    recordAccountFailure(email, code) {
        this.accountRotator.recordFailure(email, code)
    }

    /**
     * 记录账户错误（仅用于 UI warn 指示，不影响 cooldown）
     * HTTP 4xx/5xx 走这里——上游主动拒绝，账户本身有效
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - HTTP status 或错误码
     */
    recordAccountError(email, code) {
        this.accountRotator.recordError(email, code)
    }

    /**
     * 累计 daily stats（per-account）
     * 调用方：chat.js / anthropic.js / cli.chat.js 在成功消费完上游 usage 后
     * 注意：PM2_INSTANCES>1 时各 worker 各持一份 in-memory 副本（已记于 epic notes）
     * @param {string} email - 邮箱地址
     * @param {'chat'|'cli'} kind - 统计类别
     * @param {Object} delta - 增量
     * @param {number} [delta.input] - 输入 tokens
     * @param {number} [delta.output] - 输出 tokens
     * @param {number} [delta.calls] - 调用次数（仅 cli 使用）
     */
    accumulateStats(email, kind, delta) {
        if (!email || !delta) return
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) return

        ensureStats(account)

        const input = Number(delta.input) || 0
        const output = Number(delta.output) || 0
        const calls = Number(delta.calls) || 0

        if (kind === 'chat') {
            account.stats.chat.input += input
            account.stats.chat.output += output
        } else if (kind === 'cli') {
            account.stats.cli.calls += calls
            account.stats.cli.input += input
            account.stats.cli.output += output
        } else {
            return
        }

        // 异步 debounced persist——失败不影响调用方
        try {
            this.dataPersistence.saveAccountStats(email, account.stats)
        } catch (error) {
            logger.error(`accumulateStats persist 调度失败 (${email})`, 'STATS', '', error)
        }
    }

    /**
     * 重置账户失败计数
     * @param {string} email - 邮箱地址
     */
    resetAccountFailures(email) {
        this.accountRotator.resetFailures(email)
    }

    /**
     * 添加新账户
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {string|null} [proxy] - 账号专属代理 URL（HTTP/HTTPS/SOCKS5）
     * @returns {Promise<boolean>} 添加是否成功
     */
    async addAccount(email, password, proxy = null) {
        try {
            // 检查账户是否已存在
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`账户 ${email} 已存在`, 'ACCOUNT')
                return false
            }

            // 尝试登录获取令牌
            const token = await this.tokenManager.login(email, password, proxy ? { proxy } : undefined)
            if (!token) {
                logger.error(`账户 ${email} 登录失败，无法添加`, 'ACCOUNT')
                return false
            }

            const decoded = this.tokenManager.validateToken(token)
            if (!decoded) {
                logger.error(`账户 ${email} 令牌无效，无法添加`, 'ACCOUNT')
                return false
            }

            const newAccount = {
                email,
                password,
                token,
                expires: decoded.exp,
                proxy: (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null,
                stats: createDefaultStats()
            }

            // 添加到内存
            this.accountTokens.push(newAccount)
            const insertedIndex = this.accountTokens.length - 1

            // 保存到持久化存储
            const saved = await this.dataPersistence.saveAccount(email, newAccount)
            if (!saved) {
                this.accountTokens.splice(insertedIndex, 1)
                this.accountRotator.setAccounts(this.accountTokens)
                logger.error(`账户 ${email} 持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 后台初始化 CLI
            this._initializeCliAccount(newAccount).catch(err => {
                logger.error(`新账户 CLI 初始化失败: ${email}`, 'ACCOUNT', '', err)
            })

            logger.success(`成功添加账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`添加账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 直接添加账户（已有token，无需登录）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {string} token - 已获取的令牌
     * @param {number} expires - 过期时间戳
     * @param {string|null} [proxy] - 账号专属代理 URL
     * @returns {Promise<boolean>} 添加是否成功
     */
    async addAccountWithToken(email, password, token, expires, proxy = null) {
        try {
            // 检查账户是否已存在
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`账户 ${email} 已存在`, 'ACCOUNT')
                return false
            }

            const newAccount = {
                email,
                password,
                token,
                expires,
                proxy: (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null,
                stats: createDefaultStats()
            }

            // 添加到内存
            this.accountTokens.push(newAccount)
            const insertedIndex = this.accountTokens.length - 1

            // 保存到持久化存储
            const saved = await this.dataPersistence.saveAccount(email, newAccount)
            if (!saved) {
                this.accountTokens.splice(insertedIndex, 1)
                this.accountRotator.setAccounts(this.accountTokens)
                logger.error(`账户 ${email} 持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 后台初始化 CLI
            this._initializeCliAccount(newAccount).catch(err => {
                logger.error(`新账户 CLI 初始化失败: ${email}`, 'ACCOUNT', '', err)
            })

            logger.success(`成功添加账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`添加账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 更新账户的代理 URL
     * 同时使旧 URL 对应的 agent 失效（释放底层 socket）
     * @param {string} email - 邮箱
     * @param {string|null} proxy - 新代理 URL，空字符串/null 表示清除
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateAccountProxy(email, proxy) {
        try {
            const account = this.accountTokens.find(acc => acc.email === email)
            if (!account) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            const oldProxy = account.proxy || null
            const newProxy = (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null

            if (oldProxy === newProxy) {
                logger.info(`账户 ${email} 代理未变化，无需更新`, 'ACCOUNT')
                return true
            }

            // 先更新内存，再持久化；持久化失败时回滚
            account.proxy = newProxy
            const saved = await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                proxy: newProxy
            })
            if (!saved) {
                account.proxy = oldProxy
                logger.error(`账户 ${email} 代理持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 旧代理 URL 不再被该账户引用，主动失效缓存
            // 注意：其他账户可能仍在使用同一 URL，但 invalidate 仅按 URL 操作；
            // 多账户共享代理的场景下后续请求会重新创建 agent，安全
            if (oldProxy && oldProxy !== newProxy) {
                const { invalidateProxyAgent } = require('./proxy-helper')
                invalidateProxyAgent(oldProxy)
            }

            logger.success(`账户 ${email} 代理更新成功 (${oldProxy || '无'} → ${newProxy || '无'})`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`更新账户 ${email} 代理失败`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 移除账户
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 移除是否成功
     */
    async removeAccount(email) {
        try {
            const index = this.accountTokens.findIndex(acc => acc.email === email)
            if (index === -1) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            // 从内存中移除
            this.accountTokens.splice(index, 1)

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            logger.success(`成功移除账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`移除账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 删除账户（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {boolean} 删除是否成功
     */
    deleteAccount(email) {
        const index = this.accountTokens.findIndex(t => t.email === email)
        if (index !== -1) {
            this.accountTokens.splice(index, 1)
            this.accountRotator.setAccounts(this.accountTokens)
            return true
        }
        return false
    }

    /**
     * 为指定账户初始化CLI信息（公共方法）
     * @param {Object} account - 账户对象
     * @returns {Promise<boolean>} 初始化是否成功
     */
    async initializeCliForAccount(account) {
        if (!account) {
            logger.error('账户对象不能为空', 'CLI')
            return false
        }

        try {
            await this._initializeCliAccount(account)
            return true
        } catch (error) {
            logger.error(`为账户 ${account.email} 初始化CLI失败`, 'CLI', '', error)
            return false
        }
    }

    /**
     * 延迟函数
     * @param {number} ms - 延迟毫秒数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * 清理资源
     */
    destroy() {
        // 清理自动刷新定时器
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
            this.refreshInterval = null
        }

        // 清理CLI请求次数重置定时器
        if (this.cliRequestNumberInterval) {
            clearTimeout(this.cliRequestNumberInterval)
            this.cliRequestNumberInterval = null
        }

        if (this.cliDailyResetInterval) {
            clearInterval(this.cliDailyResetInterval)
            this.cliDailyResetInterval = null
        }

        // 清理所有CLI账户的刷新定时器
        this.accountTokens.forEach(account => {
            if (account.cli_info && account.cli_info.refresh_token_interval) {
                clearInterval(account.cli_info.refresh_token_interval)
                account.cli_info.refresh_token_interval = null
            }
        })

        this.accountRotator.reset()
        logger.info('账户管理器已清理资源', 'ACCOUNT', '🧹')
    }

}

if (!(process.env.API_KEY || config.apiKey)) {
    logger.error('请务必设置 API_KEY 环境变量', 'CONFIG', '⚙️')
    process.exit(1)
}

const accountManager = new Account()

// 添加进程退出时的清理
process.on('exit', () => {
    if (accountManager) {
        accountManager.destroy()
    }
})

// 处理意外退出
process.on('SIGINT', () => {
    if (accountManager) {
        accountManager.destroy()
    }
    process.exit(0)
})


module.exports = accountManager
