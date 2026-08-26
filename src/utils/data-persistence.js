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
// 备份（data.json.bak）最小刷新间隔——不必每次落盘都多写一份
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000
// rename 重试间隔：Windows / 网络盘上目标文件被占用时可能短暂 EPERM / EBUSY
const RENAME_RETRY_DELAYS_MS = [20, 50, 100]

// 进程内串行化：所有对 data.json 的 read-modify-write 排队执行。
// 队列必须是模块级的——进程里存在多个 DataPersistence 实例
// （utils/account.js 一个、routes/settings.js 一个），实例级的锁挡不住并发。
// 注：PM2 cluster（PM2_INSTANCES > 1）下跨进程仍可能「后写覆盖先写」丢一次统计，
// 但原子 rename 保证任何时刻文件都是完整 JSON，不会再出现半截内容。
let fileWriteQueue = Promise.resolve()
let tmpFileCounter = 0
let lastBackupAt = 0

/**
 * 把一次文件读写排入串行队列
 * @param {Function} task - 返回 Promise 的任务
 * @returns {Promise<*>} 任务结果
 */
const enqueueFileTask = (task) => {
  const result = fileWriteQueue.then(task, task)
  // 队列本身不能因为单次失败而中断
  fileWriteQueue = result.then(() => { }, () => { })
  return result
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

class DataPersistence {
  constructor() {
    this.dataFilePath = path.join(__dirname, '../../data/data.json')
    // 最近一次「解析成功」的快照，用于文件损坏时自愈
    this.backupFilePath = `${this.dataFilePath}.bak`
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
          logger.error(`Unsupported data save mode: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('Failed to load account data', 'DATA', '', error)
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
          logger.warn('Environment variable mode does not support saving account data', 'DATA')
          return false
        default:
          logger.error(`Unsupported data save mode: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error(`Failed to save account data (${email})`, 'DATA', '', error)
      return false
    }
  }

  /**
   * 加载运行时设置（chat retry config 等）
   * 在 'none' 模式下返回 {}, 因为没有可写存储
   * @returns {Promise<Object>} 设置对象 (空对象表示尚未存储任何值)
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
          logger.error(`Unsupported data save mode: ${config.dataSaveMode}`, 'DATA')
          return {}
      }
    } catch (error) {
      logger.error('Failed to load runtime settings', 'DATA', '', error)
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
          logger.warn('Environment variable mode does not support saving runtime settings', 'DATA')
          return false
        default:
          logger.error(`Unsupported data save mode: ${config.dataSaveMode}`, 'DATA')
          return false
      }
    } catch (error) {
      logger.error('Failed to save runtime settings', 'DATA', '', error)
      return false
    }
  }

  async _loadSettingsFromFile() {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      return (data.settings && typeof data.settings === 'object') ? data.settings : {}
    })
  }

  async _saveSettingsToFile(partial) {
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      data.settings = { ...(data.settings || {}), ...partial }
      await this._writeDataFile(data)
      return true
    })
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
          logger.warn('Environment variable mode does not support saving account data', 'DATA')
          return false
        default:
          logger.error(`Unsupported data save mode: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`Unsupported data save mode: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('Failed to batch save account data', 'DATA', '', error)
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
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()
      return data.accounts || []
    })
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
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()

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

      await this._writeDataFile(data)
      return true
    })
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
    return enqueueFileTask(async () => {
      const data = await this._readDataFile()

      data.accounts = accounts.map(account => ({
        email: account.email,
        password: account.password,
        token: account.token,
        expires: account.expires,
        proxy: account.proxy ?? null,
        stats: account.stats ?? undefined,
        statsHistory: account.statsHistory ?? undefined
      }))

      await this._writeDataFile(data)
      return true
    })
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
        logger.error(`stats persistence failed (${email})`, 'STATS', '', error)
      }
    }, STATS_PERSIST_DEBOUNCE_MS)

    this._statsPersistTimers.set(email, timer)
    return true
  }

  /**
   * 读取并解析 data.json；解析失败时尝试用备份自愈
   * 仅在 enqueueFileTask 内部调用——保证 read-modify-write 不交错
   * @returns {Promise<Object>} 解析后的数据对象
   * @private
   */
  async _readDataFile() {
    await this._ensureDataFileExists()

    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    let data
    try {
      data = JSON.parse(fileContent)
    } catch (parseError) {
      return await this._recoverFromBackup(parseError, fileContent.length)
    }

    // 解析成功即为「已知良好」，按最小间隔刷新备份
    await this._refreshBackup(fileContent, data)
    return data
  }

  /**
   * data.json 损坏时的恢复：优先用备份，没有备份就大声报错并中止
   * 绝不能静默返回空账户列表——那会让服务带着 0 个账户启动，
   * 之后所有请求都以「无可用令牌」失败，并且下一次写入会把损坏文件覆盖掉
   * @param {Error} parseError - JSON.parse 抛出的错误
   * @param {number} brokenSize - 损坏文件的字符数（便于排查）
   * @returns {Promise<Object>} 从备份恢复的数据对象
   * @private
   */
  async _recoverFromBackup(parseError, brokenSize) {
    logger.error(
      `数据文件损坏: ${this.dataFilePath} (${brokenSize} 字符) — ${parseError.message}`,
      'DATA'
    )

    let backupContent = null
    let backupData = null
    try {
      backupContent = await fs.readFile(this.backupFilePath, 'utf-8')
      backupData = JSON.parse(backupContent)
    } catch (backupError) {
      backupData = null
    }

    if (!backupData || typeof backupData !== 'object') {
      logger.error(
        `备份不可用 (${this.backupFilePath})，账户数据无法自动恢复；` +
        '损坏文件已原样保留，请人工修复后重启服务',
        'DATA'
      )
      throw new Error(`Data file ${this.dataFilePath} is corrupted and no backup available: ${parseError.message}`)
    }

    // 先给损坏文件留证（copy 而非 rename——避免中途崩溃导致 data.json 缺失），再用备份覆盖
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantinePath = `${this.dataFilePath}.corrupt-${stamp}`
    try {
      await fs.copyFile(this.dataFilePath, quarantinePath)
    } catch (copyError) {
      logger.warn(`Failed to quarantine corrupted file: ${quarantinePath}`, 'DATA', '', copyError)
    }

    await this._writeFileAtomic(this.dataFilePath, backupContent)
    logger.warn(
      `已用备份恢复数据文件（${(backupData.accounts || []).length} accounts）；` +
      `损坏副本: ${quarantinePath}`,
      'DATA'
    )
    return backupData
  }

  /**
   * 写入 data.json 并刷新备份
   * @param {Object} data - 完整数据对象
   * @private
   */
  async _writeDataFile(data) {
    const content = JSON.stringify(data, null, 2)
    await this._writeFileAtomic(this.dataFilePath, content)
    await this._refreshBackup(content, data)
  }

  /**
   * 原子写入：先写同目录临时文件 + fsync，再 rename 覆盖目标
   * rename 在同一文件系统内是原子的——读取方永远看到完整文件；
   * 中途崩溃也只会留下临时文件，目标文件保持上一版完整内容
   * @param {string} targetPath - 目标文件路径
   * @param {string} content - 文件内容
   * @private
   */
  async _writeFileAtomic(targetPath, content) {
    const tmpPath = `${targetPath}.${process.pid}.${++tmpFileCounter}.tmp`
    let handle = null
    try {
      handle = await fs.open(tmpPath, 'w')
      await handle.writeFile(content, 'utf-8')
      // fsync：保证 rename 之后内容确实落盘（掉电 / 容器被杀时才不会拿到空文件）
      await handle.sync()
      await handle.close()
      handle = null

      await this._renameWithRetry(tmpPath, targetPath)
    } catch (error) {
      if (handle) {
        try { await handle.close() } catch (closeError) { /* 已经失败，忽略 */ }
      }
      try { await fs.unlink(tmpPath) } catch (unlinkError) { /* 临时文件可能不存在 */ }
      throw error
    }
  }

  /**
   * rename 重试：目标文件被杀毒软件 / 另一进程短暂占用时不至于直接失败
   * @param {string} fromPath - 临时文件路径
   * @param {string} toPath - 目标文件路径
   * @private
   */
  async _renameWithRetry(fromPath, toPath) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(fromPath, toPath)
        return
      } catch (error) {
        const retriable = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY'
        if (!retriable || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error
        }
        await sleep(RENAME_RETRY_DELAYS_MS[attempt])
      }
    }
  }

  /**
   * 刷新备份文件（限流；失败不影响主流程）
   * @param {string} content - 已确认可解析的内容
   * @param {Object} data - 与 content 对应的数据对象
   * @private
   */
  async _refreshBackup(content, data) {
    // 空账户列表不值得做备份，更不能拿它覆盖已有备份：
    // data.json 被误删时会先生成空的默认文件，备份必须留住上一份真实数据
    if (!data || !Array.isArray(data.accounts) || data.accounts.length === 0) {
      return
    }

    const now = Date.now()
    if (now - lastBackupAt < BACKUP_MIN_INTERVAL_MS) {
      return
    }
    lastBackupAt = now

    try {
      await this._writeFileAtomic(this.backupFilePath, content)
    } catch (error) {
      logger.warn('Backup file write failed (does not affect main data file)', 'DATA', '', error)
    }
  }

  /**
   * 确保数据文件存在
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath)
    } catch (error) {
      logger.info('Data file does not exist, creating default file...', 'FILE', '📁')

      // 确保目录存在
      const dirPath = path.dirname(this.dataFilePath)
      await fs.mkdir(dirPath, { recursive: true })

      // 创建默认数据结构
      const defaultData = {
        defaultHeaders: null,
        defaultCookie: null,
        accounts: []
      }

      await this._writeFileAtomic(this.dataFilePath, JSON.stringify(defaultData, null, 2))
      logger.success('Default data file created successfully', 'FILE')
    }
  }
}

module.exports = DataPersistence
