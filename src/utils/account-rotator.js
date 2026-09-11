const { logger } = require('./logger')

/**
 * 账户轮询管理器
 * 负责账户的轮询选择和负载均衡
 */
class AccountRotator {
  constructor() {
    this.accounts = []
    this.currentIndex = 0
    this.lastUsedTimes = new Map() // 记录每个账户的最后使用时间
    this.failureCounts = new Map() // 记录每个账户的失败次数（仅传输层失败累积，触发 cooldown）
    this.lastErrorAt = new Map() // 最近一次错误的时间戳（用于 UI warn 指示，含 HTTP 4xx/5xx）
    this.lastErrorCode = new Map() // 最近一次错误码（HTTP status 或 transport err.code）
    this.cooldownStartedAt = new Map() // 进入 cooldown 的起始时间戳（failureCounts 达阈值时刻）
    this.quotaCooldownUntil = new Map() // 日额度耗尽的账户 -> 解禁时间戳（见 recordQuotaExhausted）
    this.challengeCooldownUntil = new Map()
    this.maxFailures = 3 // 最大失败次数
    this.cooldownPeriod = 5 * 60 * 1000 // 5分钟冷却期
    // 额度耗尽的默认静默期。上游给了 `data.num`（小时）时用那个，这是没给时的回退。
    // 1 小时是刻意保守：额度按天重置，所以更久也“正确”，但分类若误判（文本回退可能
    // 命中别的东西），一天的流放会白白扔掉一个好账户；1 小时足以掐断热循环，
    // 又能自己愈合。
    this.quotaCooldownPeriod = 60 * 60 * 1000
  }

  /**
   * 设置账户列表
   * @param {Array} accounts - 账户列表
   */
  setAccounts(accounts) {
    if (!Array.isArray(accounts)) {
      logger.error('账户列表必须是数组', 'ACCOUNT')
      throw new Error('账户列表必须是数组')
    }
    
    this.accounts = [...accounts]
    this.currentIndex = 0
    
    // 清理不存在账户的记录
    this._cleanupRecords()
  }

  /**
   * 获取下一个可用的账户对象
   * @param {string[]} excludedEmails - Accounts already attempted in this request
   * @returns {Object|null} 账户对象或 null
   */
  getNextAccount(excludedEmails = []) {
    if (this.accounts.length === 0) {
      logger.error('没有可用的账户', 'ACCOUNT')
      return null
    }

    const excluded = new Set(excludedEmails)
    const availableAccounts = this._getAvailableAccounts().filter(account => !excluded.has(account.email))
    if (availableAccounts.length === 0) {
      logger.warn('没有未排除且可用的账户，停止重试', 'ACCOUNT')
      return null
    }

    // 从可用账户中选择最少使用的
    const selectedAccount = this._selectLeastUsedAccount(availableAccounts)
    this._recordUsage(selectedAccount.email)

    return selectedAccount
  }

  /**
   * 获取下一个可用的账户令牌（向后兼容的便捷方法）
   * @returns {string|null} 账户令牌或null
   */
  getNextToken() {
    const account = this.getNextAccount()
    return account ? account.token : null
  }

  /**
   * 根据邮箱获取账户对象
   * @param {string} email - 邮箱地址
   * @returns {Object|null} 账户对象或 null
   */
  getAccountByEmail(email) {
    const account = this.accounts.find(acc => acc.email === email)
    if (!account) {
      logger.error(`未找到邮箱为 ${email} 的账户`, 'ACCOUNT')
      return null
    }

    if (!this._isAccountAvailable(account)) {
      logger.warn(`账户 ${email} 当前不可用`, 'ACCOUNT')
      return null
    }

    this._recordUsage(email)
    return account
  }

  /**
   * 获取指定邮箱的账户令牌（向后兼容的便捷方法）
   * @param {string} email - 邮箱地址
   * @returns {string|null} 账户令牌或null
   */
  getTokenByEmail(email) {
    const account = this.getAccountByEmail(email)
    return account ? account.token : null
  }

  /**
   * 记录账户传输层失败（影响 cooldown）
   * 仅在传输层错误（timeout/ECONNRESET 等）调用——HTTP 4xx/5xx 走 recordError
   * @param {string} email - 邮箱地址
   * @param {string|number} [code] - 错误码（err.code 或 HTTP status），用于 UI warn
   */
  recordFailure(email, code) {
    const currentFailures = this.failureCounts.get(email) || 0
    const nextFailures = currentFailures + 1
    this.failureCounts.set(email, nextFailures)

    // 同时填充 warn 指示状态（recordFailure 是 recordError 的超集）
    this.lastErrorAt.set(email, Date.now())
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code)
    }

    // 达到阈值的瞬间标记 cooldown 起点（独立于 lastUsedTimes，CLI-only 失败也正确）
    if (nextFailures >= this.maxFailures && !this.cooldownStartedAt.has(email)) {
      this.cooldownStartedAt.set(email, Date.now())
      logger.warn(`账户 ${email} 失败次数达到上限，将进入冷却期`, 'ACCOUNT')
    }
  }

  /**
   * 记录账户错误（仅用于 UI warn 指示，不影响 cooldown）
   * HTTP 4xx/5xx 走这里——上游主动拒绝，账户本身有效，不应进入 cooldown
   * @param {string} email - 邮箱地址
   * @param {string|number} [code] - HTTP status 或错误码
   */
  recordError(email, code) {
    this.lastErrorAt.set(email, Date.now())
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code)
    }
  }

  /**
   * 记录“日额度已耗尽”（RateLimited），把账户暂时移出轮询。
   *
   * 这是 recordError / recordFailure 之外的第三类，因为两者都不对：
   * - recordError（HTTP 4xx/5xx 走的那条）刻意不冷却——上游主动拒绝、账户本身有效。
   *   额度耗尽的账户**不是**有效的：在 Qwen 那边重置之前，它对每个请求都会再拒一次。
   * - recordFailure 是传输层故障的计数器，要攒够 maxFailures 才冷却；额度耗尽不需要
   *   证据积累，一次就是确定的。
   *
   * 不做这件事时的代价正是这次改动的理由：客户端看到 429 不再重试了，可服务端还在
   * 把同一个死账户发回轮询，每一轮再烧一次。
   * @param {string} email - 邮箱地址
   * @param {number|null} [retryAfterSeconds] - 上游给的真实等待（秒），没有则用默认静默期
   */
  recordQuotaExhausted(email, retryAfterSeconds = null) {
    if (!email) return
    const seconds = Number(retryAfterSeconds)
    const waitMs = Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : this.quotaCooldownPeriod
    this.quotaCooldownUntil.set(email, Date.now() + waitMs)
    this.lastErrorAt.set(email, Date.now())
    this.lastErrorCode.set(email, 'RateLimited')
    logger.warn(
      `账户 ${email} 额度已耗尽，暂停轮询 ${Math.round(waitMs / 60000)} 分钟`,
      'ACCOUNT'
    )
  }

  recordChallenge(email) {
    if (!email) return
    // Keep this separate from transport failures and quota cooldowns.
    this.challengeCooldownUntil.set(email, Date.now() + this.cooldownPeriod)
    this.recordError(email, 'upstream_waf_challenge')
  }

  /**
   * 重置账户失败计数（清除 cooldown）
   * 注意：不清理 lastErrorAt/lastErrorCode——它们由 endpoint 的 15 分钟窗口管理
   *
   * 也**不**清理 quotaCooldownUntil：account.js:516 在每次令牌刷新成功后对所有账户
   * 调用本方法，而刷新是定时器驱动的。若在这里解禁，额度流放只能活到下一个 tick，
   * 烧账户的循环会自己回来。额度只由时间解除（_isAccountAvailable）。
   * @param {string} email - 邮箱地址
   */
  resetFailures(email) {
    this.failureCounts.delete(email)
    this.cooldownStartedAt.delete(email)
  }

  /**
   * 获取账户统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    const total = this.accounts.length
    const available = this._getAvailableAccounts().length
    const inCooldown = total - available
    
    const usageStats = {}
    this.accounts.forEach(account => {
      const email = account.email
      const cooldownStart = this.cooldownStartedAt.get(email)
      usageStats[email] = {
        failures: this.failureCounts.get(email) || 0,
        lastUsed: this.lastUsedTimes.get(email) || null,
        available: this._isAccountAvailable(account),
        lastErrorAt: this.lastErrorAt.get(email) || null,
        lastErrorCode: this.lastErrorCode.get(email) || null,
        cooldownEndsAt: Math.max(
          cooldownStart ? cooldownStart + this.cooldownPeriod : 0,
          this.challengeCooldownUntil.get(email) || 0
        ) || null,
        quotaCooldownEndsAt: this.quotaCooldownUntil.get(email) || null
      }
    })

    return {
      total,
      available,
      inCooldown,
      currentIndex: this.currentIndex,
      usageStats
    }
  }

  /**
   * 获取可用账户列表
   * @private
   */
  _getAvailableAccounts() {
    return this.accounts.filter(account => this._isAccountAvailable(account))
  }

  /**
   * 检查账户是否可用
   * @param {Object} account - 账户对象
   * @returns {boolean} 是否可用
   * @private
   */
  _isAccountAvailable(account) {
    if (!account.token) {
      return false
    }

    // A token refresh does not resolve an upstream verification challenge.
    const challengeUntil = this.challengeCooldownUntil.get(account.email)
    if (challengeUntil) {
      if (Date.now() < challengeUntil) return false
      this.challengeCooldownUntil.delete(account.email)
    }

    // 额度流放优先于一切：这个账户对上游来说今天已经没有配额，再选它就是白烧一轮。
    const quotaUntil = this.quotaCooldownUntil.get(account.email)
    if (quotaUntil) {
      if (Date.now() < quotaUntil) {
        return false
      }
      this.quotaCooldownUntil.delete(account.email)
    }

    // 基于 cooldownStartedAt（显式标记）而非 lastUsedTimes——
    // 后者对 CLI-only 失败不更新，导致 cooldown 计算不准
    const cooldownStart = this.cooldownStartedAt.get(account.email)
    if (cooldownStart) {
      if (Date.now() - cooldownStart < this.cooldownPeriod) {
        return false // 仍在冷却期
      }
      // 冷却期结束，清理 cooldown 标记与失败计数（lastError* 不动，由 endpoint 管理 warn 窗口）
      this.cooldownStartedAt.delete(account.email)
      this.failureCounts.delete(account.email)
    }

    return true
  }

  /**
   * 选择最少使用的账户
   * @param {Array} accounts - 可用账户列表
   * @returns {Object} 选中的账户
   * @private
   */
  _selectLeastUsedAccount(accounts) {
    if (accounts.length === 1) {
      return accounts[0]
    }

    // 按最后使用时间排序，选择最久未使用的
    return accounts.reduce((least, current) => {
      const leastLastUsed = this.lastUsedTimes.get(least.email) || 0
      const currentLastUsed = this.lastUsedTimes.get(current.email) || 0
      
      return currentLastUsed < leastLastUsed ? current : least
    })
  }

  /**
   * 记录账户使用
   * @param {string} email - 邮箱地址
   * @private
   */
  _recordUsage(email) {
    this.lastUsedTimes.set(email, Date.now())
  }

  /**
   * 清理不存在账户的记录
   * @private
   */
  _cleanupRecords() {
    const currentEmails = new Set(this.accounts.map(acc => acc.email))

    const maps = [
      this.failureCounts,
      this.lastUsedTimes,
      this.lastErrorAt,
      this.lastErrorCode,
      this.cooldownStartedAt,
      this.quotaCooldownUntil,
      this.challengeCooldownUntil
    ]
    for (const map of maps) {
      for (const email of map.keys()) {
        if (!currentEmails.has(email)) {
          map.delete(email)
        }
      }
    }
  }

  /**
   * 重置所有统计数据
   */
  reset() {
    this.currentIndex = 0
    this.lastUsedTimes.clear()
    this.failureCounts.clear()
    this.lastErrorAt.clear()
    this.lastErrorCode.clear()
    this.cooldownStartedAt.clear()
    this.quotaCooldownUntil.clear()
    this.challengeCooldownUntil.clear()
  }
}

module.exports = AccountRotator
