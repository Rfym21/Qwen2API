const fs = require('fs').promises
const path = require('path')
const config = require('../config/index.js')
const redisClient = require('./redis')
const { logger } = require('./logger')

/**
 * 数据持久化管理器
 * 统一处理账户数据的存储和读取
 */
// Debounce 窗口（per-email）写入 stats——避免每次 token 累计都触发文件 I/O
const STATS_PERSIST_DEBOUNCE_MS = 5000

class DataPersistence {
  constructor() {
    this.dataFilePath = path.join(__dirname, '../../data/data.json')
    // 每个 email 的待持久化 stats 与定时器（debounce）
    this._statsPersistTimers = new Map()
    this._statsPendingPayload = new Map()
  }

  /**
   * 加载所有账户数据
   * @returns {Promise<Array>} 账户列表
   */
  async loadAccounts() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._loadFromRedis()
        case 'file':
          return await this._loadFromFile()
        case 'none':
          return await this._loadFromEnv()
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('加载账户数据失败', 'DATA', '', error)
      throw error
    }
  }

  /**
   * 保存单个账户数据
   * @param {string} email - 邮箱
   * @param {Object} accountData - 账户数据
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAccount(email, accountData) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._saveToRedis(email, accountData)
        case 'file':
          return await this._saveToFile(email, accountData)
        case 'none':
          logger.warn('环境变量模式不支持保存账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error(`保存账户数据失败 (${email})`, 'DATA', '', error)
      return false
    }
  }

  /**
   * 加载运行时设置（chat retry config 等）
   * 在 'none' 模式下返回 {}, 因为没有可写存储
   * @returns {Promise<Object>} 设置对象 (空对象表示无сохранённых значений)
   */
  async loadSettings() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return (await redisClient.getSettings()) || {}
        case 'file':
          return await this._loadSettingsFromFile()
        case 'none':
          return {}
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return {}
      }
    } catch (error) {
      logger.error('加载运行时设置失败', 'DATA', '', error)
      return {}
    }
  }

  /**
   * 保存运行时设置（部分合并）
   * @param {Object} partial - 要写入的字段
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveSettings(partial) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await redisClient.setSettings(partial)
        case 'file':
          return await this._saveSettingsToFile(partial)
        case 'none':
          logger.warn('环境变量模式不支持保存运行时设置', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return false
      }
    } catch (error) {
      logger.error('保存运行时设置失败', 'DATA', '', error)
      return false
    }
  }

  async _loadSettingsFromFile() {
    await this._ensureDataFileExists()
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    return (data.settings && typeof data.settings === 'object') ? data.settings : {}
  }

  async _saveSettingsToFile(partial) {
    await this._ensureDataFileExists()
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    data.settings = { ...(data.settings || {}), ...partial }
    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /**
   * 批量保存账户数据
   * @param {Array} accounts - 账户列表
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAllAccounts(accounts) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._saveAllToRedis(accounts)
        case 'file':
          return await this._saveAllToFile(accounts)
        case 'none':
          logger.warn('环境变量模式不支持保存账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('批量保存账户数据失败', 'DATA', '', error)
      return false
    }
  }

  /**
   * 从 Redis 加载账户数据
   * @private
   */
  async _loadFromRedis() {
    const accounts = await redisClient.getAllAccounts()
    return accounts.length > 0 ? accounts : []
  }

  /**
   * 从文件加载账户数据
   * @private
   */
  async _loadFromFile() {
    // 确保文件存在
    await this._ensureDataFileExists()
    
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    
    return data.accounts || []
  }

  /**
   * 从环境变量加载账户数据
   * @private
   */
  async _loadFromEnv() {
    if (!process.env.ACCOUNTS) {
      return []
    }

    const { parseAccountLine } = require('./account-parser')
    const accountTokens = process.env.ACCOUNTS.split(',')
    const accounts = []

    // 解析委托给共用 parser，与后台批量添加保持一致；
    // 注意：这里仅加载凭据，token 在 Account 类中按需登录获取
    for (const item of accountTokens) {
      const parsed = parseAccountLine(item)
      if (parsed) {
        accounts.push({ ...parsed, token: null, expires: null })
      }
    }

    return accounts
  }

  /**
   * 保存到 Redis
   * @private
   */
  async _saveToRedis(email, accountData) {
    return await redisClient.setAccount(email, accountData)
  }

  /**
   * 保存到文件（MERGE 语义）
   * partial save（仅 token、proxy、stats）不应覆盖未传字段——保留 existing 值
   * @private
   */
  async _saveToFile(email, accountData) {
    await this._ensureDataFileExists()

    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)

    if (!data.accounts) {
      data.accounts = []
    }

    const existingIndex = data.accounts.findIndex(account => account.email === email)
    const existing = existingIndex !== -1 ? data.accounts[existingIndex] : {}

    // 仅写入显式传入的字段；未传字段保留 existing 值。stats 同理——
    // 避免 token refresh / proxy update 的 partial save 把累计 stats 清零
    const merged = { ...existing, email }
    if (accountData.password !== undefined) merged.password = accountData.password
    if (accountData.token !== undefined) merged.token = accountData.token
    if (accountData.expires !== undefined) merged.expires = accountData.expires
    if (accountData.proxy !== undefined) merged.proxy = accountData.proxy ?? null
    if (accountData.stats !== undefined) merged.stats = accountData.stats
    if (accountData.statsHistory !== undefined) merged.statsHistory = accountData.statsHistory

    if (existingIndex !== -1) {
      data.accounts[existingIndex] = merged
    } else {
      data.accounts.push(merged)
    }

    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /**
   * 批量保存到 Redis
   * @private
   */
  async _saveAllToRedis(accounts) {
    let successCount = 0
    for (const account of accounts) {
      const success = await this._saveToRedis(account.email, account)
      if (success) successCount++
    }
    return successCount === accounts.length
  }

  /**
   * 批量保存到文件
   * @private
   */
  async _saveAllToFile(accounts) {
    await this._ensureDataFileExists()
    
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    
    data.accounts = accounts.map(account => ({
      email: account.email,
      password: account.password,
      token: account.token,
      expires: account.expires,
      proxy: account.proxy ?? null,
      stats: account.stats ?? undefined,
      statsHistory: account.statsHistory ?? undefined
    }))

    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /**
   * 调度 per-account daily stats 持久化（debounce 5 秒）
   * 高频 accumulateStats 调用合并为单次 I/O——重复调用替换上一个 timer
   * dataSaveMode='none' 时不写盘，返回 false
   * @param {string} email - 邮箱
   * @param {Object} stats - 完整 stats 对象 { chat: {input,output}, cli: {calls,input,output} }
   * @returns {boolean} 是否调度成功
   */
  saveAccountStats(email, stats) {
    if (config.dataSaveMode === 'none') {
      return false
    }
    if (!email || !stats) {
      return false
    }

    // 替换 pending payload 与 timer
    this._statsPendingPayload.set(email, stats)
    const prev = this._statsPersistTimers.get(email)
    if (prev) clearTimeout(prev)

    const timer = setTimeout(async () => {
      this._statsPersistTimers.delete(email)
      const payload = this._statsPendingPayload.get(email)
      this._statsPendingPayload.delete(email)
      if (!payload) return
      try {
        await this.saveAccount(email, { stats: payload })
      } catch (error) {
        logger.error(`stats 持久化失败 (${email})`, 'STATS', '', error)
      }
    }, STATS_PERSIST_DEBOUNCE_MS)

    this._statsPersistTimers.set(email, timer)
    return true
  }

  /**
   * 确保数据文件存在
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath)
    } catch (error) {
      logger.info('数据文件不存在，正在创建默认文件...', 'FILE', '📁')

      // 确保目录存在
      const dirPath = path.dirname(this.dataFilePath)
      await fs.mkdir(dirPath, { recursive: true })

      // 创建默认数据结构
      const defaultData = {
        defaultHeaders: null,
        defaultCookie: null,
        accounts: []
      }

      await fs.writeFile(this.dataFilePath, JSON.stringify(defaultData, null, 2), 'utf-8')
      logger.success('默认数据文件创建成功', 'FILE')
    }
  }
}

module.exports = DataPersistence
