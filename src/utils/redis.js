const Redis = require('ioredis')
const config = require('../config/index.js')
const { logger } = require('./logger')

/**
 * Redis 连接管理器
 * 实现按需连接机制，仅在读写操作时建立连接
 */

// 连接配置
const REDIS_CONFIG = {
  maxRetries: 3,
  connectTimeout: 10000,
  commandTimeout: 15000,
  retryDelayOnFailover: 200,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  enableReadyCheck: false,
  lazyConnect: true,
  keepAlive: 30000,
  connectionName: 'qwen2api_on_demand'
}

// 连接状态
let redis = null
let isConnecting = false
let connectionPromise = null
let lastActivity = 0
let idleTimer = null

// 空闲超时时间 (5分钟)
const IDLE_TIMEOUT = 5 * 60 * 1000
// 长时间空闲后在下一次使用前主动重建连接，避免复用已被服务端回收的空闲连接
const STALE_CONNECTION_THRESHOLD = 45 * 1000
const REDIS_VERIFY_RETRIES = 3
const REDIS_VERIFY_RETRY_DELAY = 500

/**
 * 判断是否需要TLS
 */
const isTLS = config.redisURL && (config.redisURL.startsWith('rediss://') || config.redisURL.includes('--tls'))

/**
 * 创建Redis连接配置
 */
const createRedisConfig = () => ({
  ...REDIS_CONFIG,
  // TLS配置
  ...(isTLS ? {
    tls: {
      rejectUnauthorized: true
    }
  } : {}),

  // 重试策略
  retryStrategy(times) {
    if (times > REDIS_CONFIG.maxRetries) {
      logger.error(`Redis connection retry count exceeded: ${times}`, 'REDIS')
      return null
    }

    const delay = Math.min(100 * Math.pow(2, times), 3000)
    logger.info(`Redis retrying connection: ${times}, delay: ${delay}ms`, 'REDIS', '🔄')
    return delay
  },

  // 错误重连策略
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']
    return targetErrors.some(e => err.message.includes(e))
  }
})

/**
 * 验证 Redis 命令通道是否可用
 * @param {object} client - Redis 客户端实例
 * @returns {Promise<void>} 验证结果
 */
const verifyRedisCommandChannel = async (client) => {
  let lastError = null

  for (let attempt = 1; attempt <= REDIS_VERIFY_RETRIES; attempt++) {
    try {
      const pong = await client.ping()
      if (pong !== 'PONG') {
        throw new Error(`PING returned anomaly: ${pong}`)
      }

      if (attempt > 1) {
        logger.info(`Redis command channel recovered on attempt ${attempt}`, 'REDIS', '✅')
      }

      return
    } catch (error) {
      lastError = error

      if (attempt >= REDIS_VERIFY_RETRIES) {
        break
      }

      logger.warn(`Redis command channel check failed, retrying after ${attempt} attempt(s): ${error.message}`, 'REDIS')
      await new Promise(resolve => setTimeout(resolve, REDIS_VERIFY_RETRY_DELAY))
    }
  }

  throw new Error(`Redis command channel unavailable: ${lastError ? lastError.message : 'unknown error'}`)
}

/**
 * 清理空闲定时器
 */
const clearIdleTimer = () => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/**
 * 等待现有 Redis 客户端恢复为可用状态
 * @param {object} client - Redis 客户端实例
 * @returns {Promise<object>} 可用的 Redis 客户端
 */
const waitForRedisReady = (client) => new Promise((resolve, reject) => {
  if (!client) {
    reject(new Error('Redis客户端不存在'))
    return
  }

  if (client.status === 'ready') {
    resolve(client)
    return
  }

  const timeout = setTimeout(() => {
    cleanup()
    reject(new Error('等待Redis连接恢复超时'))
  }, REDIS_CONFIG.connectTimeout + REDIS_CONFIG.commandTimeout)

  const cleanup = () => {
    clearTimeout(timeout)
    client.off('ready', handleReady)
    client.off('close', handleClose)
    client.off('end', handleEnd)
  }

  const handleReady = () => {
    cleanup()
    resolve(client)
  }

  const handleClose = () => {
    cleanup()
    reject(new Error('Redis连接已关闭'))
  }

  const handleEnd = () => {
    cleanup()
    reject(new Error('Redis连接已结束'))
  }

  client.once('ready', handleReady)
  client.once('close', handleClose)
  client.once('end', handleEnd)
})

/**
 * 更新活动时间并重置空闲定时器
 */
const updateActivity = () => {
  lastActivity = Date.now()

  clearIdleTimer()

  // 设置新的空闲定时器
  idleTimer = setTimeout(() => {
    if (redis && Date.now() - lastActivity > IDLE_TIMEOUT) {
      logger.info('Redis connection idle timeout, closing connection', 'REDIS', '🔌')
      disconnectRedis()
    }
  }, IDLE_TIMEOUT)
}

/**
 * 绑定 Redis 事件
 * @param {object} client - Redis 客户端实例
 */
const bindRedisEvents = (client) => {
  client.on('connect', () => {
    logger.success('Redis connection established', 'REDIS')
  })

  client.on('ready', () => {
    logger.success('Redis is ready', 'REDIS')
    if (redis === client) {
      updateActivity()
    }
  })

  client.on('error', (err) => {
    logger.error('Redis connection error', 'REDIS', '', err)
  })

  client.on('close', () => {
    logger.info('Redis connection closed', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('end', () => {
    logger.info('Redis connection ended', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('reconnecting', (delay) => {
    logger.info(`Redis reconnecting... delay: ${delay}ms`, 'REDIS', '🔄')
  })
}

/**
 * 建立Redis连接
 */
const connectRedis = async () => {
  if (redis && redis.status === 'ready') {
    updateActivity()
    return redis
  }

  if (redis && ['connect', 'connecting', 'reconnecting'].includes(redis.status)) {
    if (!connectionPromise) {
      isConnecting = true
      connectionPromise = waitForRedisReady(redis)
        .then(client => {
          updateActivity()
          return client
        })
        .finally(() => {
          isConnecting = false
          connectionPromise = null
        })
    }

    return connectionPromise
  }

  if (connectionPromise) {
    return connectionPromise
  }

  isConnecting = true
  connectionPromise = (async () => {
    let newRedis = null

    try {
      logger.info('Establishing Redis connection...', 'REDIS', '🔌')

      newRedis = new Redis(config.redisURL, createRedisConfig())
      redis = newRedis
      bindRedisEvents(newRedis)

      await newRedis.connect()
      await verifyRedisCommandChannel(newRedis)
      updateActivity()
      return newRedis
    } catch (error) {
      if (redis === newRedis) {
        redis = null
      }

      if (newRedis) {
        try {
          newRedis.disconnect()
        } catch (disconnectError) {
        }
      }

      logger.error('Redis connection failed', 'REDIS', '', error)
      throw error
    } finally {
      isConnecting = false
      connectionPromise = null
    }
  })()

  return connectionPromise
}

/**
 * 断开Redis连接
 */
const disconnectRedis = async () => {
  clearIdleTimer()

  if (redis) {
    const currentRedis = redis

    try {
      currentRedis.disconnect()
      logger.info('Redis disconnected', 'REDIS', '🔌')
    } catch (error) {
      logger.error('Error disconnecting Redis', 'REDIS', '', error)
    } finally {
      if (redis === currentRedis) {
        redis = null
      }

      isConnecting = false
      connectionPromise = null
    }
  }
}

/**
 * 确保Redis连接可用
 */
const ensureConnection = async () => {
  if (config.dataSaveMode !== 'redis') {
    logger.error('Current data save mode is not Redis', 'REDIS')
    throw new Error('Current data save mode is not Redis')
  }

  if (!redis || redis.status !== 'ready') {
    return await connectRedis()
  }

  if (Date.now() - lastActivity > STALE_CONNECTION_THRESHOLD) {
    logger.info('Redis connection idle time too long, proactively rebuilding connection', 'REDIS', '🔄')
    await disconnectRedis()
    return await connectRedis()
  }

  updateActivity()
  return redis
}

/**
 * 获取所有账户
 * @returns {Promise<Array>} 所有账户信息数组
 */
const getAllAccounts = async () => {
  try {
    const client = await ensureConnection()

    // 使用SCAN命令替代KEYS命令，避免阻塞Redis服务器
    const keys = []
    let cursor = '0'

    do {
      const result = await client.scan(cursor, 'MATCH', 'user:*', 'COUNT', 100)
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')

    if (!keys.length) {
      logger.info('No accounts found', 'REDIS', '✅')
      return []
    }

    // 使用pipeline一次性获取所有账户数据
    const pipeline = client.pipeline()
    keys.forEach(key => {
      pipeline.hgetall(key)
    })

    const results = await pipeline.exec()
    if (!results) {
      logger.error('Failed to get account data', 'REDIS')
      return []
    }

    const accounts = results.map((result, index) => {
      // result格式为[err, value]
      const [err, accountData] = result
      if (err) {
        logger.error(`Failed to get data for account ${keys[index]}`, 'REDIS', '', err)
        return null
      }
      if (!accountData || Object.keys(accountData).length === 0) {
        logger.error(`Account ${keys[index]} data is empty`, 'REDIS')
        return null
      }
      // stats 以 JSON 字符串存储于 HSET——malformed/missing 返回 undefined，由上层 ensureStats 补默认
      let stats
      if (accountData.stats) {
        try {
          stats = JSON.parse(accountData.stats)
        } catch (parseError) {
          logger.warn(`Account ${keys[index]} stats JSON parsing failed, using default: ${parseError.message}`, 'REDIS')
          stats = undefined
        }
      }
      // statsHistory is stored as a JSON string in HSET; malformed/missing → undefined, ensureStats fills {} upstream
      let statsHistory
      if (accountData.statsHistory) {
        try {
          statsHistory = JSON.parse(accountData.statsHistory)
        } catch (parseError) {
          logger.warn(`Account ${keys[index]} statsHistory JSON parsing failed, using default: ${parseError.message}`, 'REDIS')
          statsHistory = undefined
        }
      }
      return {
        email: keys[index].replace('user:', ''),
        password: accountData.password || '',
        token: accountData.token || '',
        expires: accountData.expires || '',
        proxy: accountData.proxy || null,
        stats,
        statsHistory
      }
    }).filter(Boolean) // 过滤掉null值

    logger.success(`Successfully fetched all accounts, total ${accounts.length} accounts`, 'REDIS')
    return accounts
  } catch (err) {
    logger.error('Error getting accounts', 'REDIS', '', err)
    throw err
  }
}

/**
 * 设置账户
 * @param {string} key - 键名（邮箱）
 * @param {Object} value - 账户信息
 * @returns {Promise<boolean>} 设置是否成功
 */
const setAccount = async (key, value) => {
  try {
    const client = await ensureConnection()

    const { password, token, expires, proxy, stats, statsHistory } = value

    // 仅写入显式传入的字段——HSET 不影响其他字段，保留 MERGE 语义
    // 这样 partial save（token refresh / proxy update）不会清零 daily stats
    const payload = {}
    if (password !== undefined) payload.password = password || ''
    if (token !== undefined) payload.token = token || ''
    if (expires !== undefined) payload.expires = expires || ''
    if (proxy !== undefined) payload.proxy = proxy || ''
    if (stats !== undefined) payload.stats = JSON.stringify(stats)
    if (statsHistory !== undefined) payload.statsHistory = JSON.stringify(statsHistory)

    if (Object.keys(payload).length === 0) {
      logger.warn(`Account ${key} setAccount received empty payload, skipping write`, 'REDIS')
      return true
    }

    await client.hset(`user:${key}`, payload)

    logger.success(`Account ${key} set successfully`, 'REDIS')
    return true
  } catch (err) {
    logger.error(`Failed to set account ${key}`, 'REDIS', '', err)
    return false
  }
}

/**
 * 删除账户
 * @param {string} key - 键名（邮箱）
 * @returns {Promise<boolean>} 删除是否成功
 */
const deleteAccount = async (key) => {
  try {
    const client = await ensureConnection()

    const result = await client.del(`user:${key}`)
    if (result > 0) {
      logger.success(`Account ${key} deleted successfully`, 'REDIS')
      return true
    } else {
      logger.warn(`Account ${key} does not exist`, 'REDIS')
      return false
    }
  } catch (err) {
    logger.error(`Failed to delete account ${key}`, 'REDIS', '', err)
    return false
  }
}

const SETTINGS_KEY = 'qwen2api:settings'

/**
 * 获取运行时设置
 * @returns {Promise<Object>} 设置对象 (字段类型为 string，调用方需自行 parseInt)
 */
const getSettings = async () => {
  try {
    const client = await ensureConnection()
    const data = await client.hgetall(SETTINGS_KEY)
    return JSON.parse(data.json)
  } catch (err) {
    logger.error('Failed to get runtime settings', 'REDIS', '', err)
    return {}
  }
}

/**
 * 保存运行时设置（通过 hset 部分合并）
 * @param {Object} partial - 字段
 * @returns {Promise<boolean>} 设置是否成功
 */
const setSettings = async (partial) => {
  try {
    const client = await ensureConnection()
    const stringified = {
      json: JSON.stringify(partial)
    }
    await client.hset(SETTINGS_KEY, stringified)
    return true
  } catch (err) {
    logger.error('Failed to save runtime settings', 'REDIS', '', err)
    return false
  }
}

/**
 * 检查键是否存在
 * @param {string} key - 键名
 * @returns {Promise<boolean>} 键是否存在
 */
const checkKeyExists = async (key = 'headers') => {
  try {
    const client = await ensureConnection()

    const exists = await client.exists(key)
    const result = exists === 1

    logger.info(`Key "${key}" ${result ? 'exists' : 'does not exist'}`, 'REDIS', result ? '✅' : '❌')
    return result
  } catch (err) {
    logger.error(`Error checking key "${key}"`, 'REDIS', '', err)
    return false
  }
}

/**
 * 获取连接状态
 * @returns {Object} 连接状态信息
 */
const getConnectionStatus = () => {
  return {
    connected: redis && redis.status === 'ready',
    status: redis ? redis.status : 'disconnected',
    lastActivity: lastActivity,
    idleTimeout: IDLE_TIMEOUT,
    config: REDIS_CONFIG
  }
}

/**
 * 手动断开连接（用于应用关闭时清理）
 */
const cleanup = async () => {
  logger.info('Cleaning up Redis connection...', 'REDIS', '🧹')
  await disconnectRedis()
}

// 创建兼容的Redis客户端对象
const redisClient = {
  getAllAccounts,
  setAccount,
  deleteAccount,
  checkKeyExists,
  getSettings,
  setSettings,
  getConnectionStatus,
  cleanup,

  // 直接Redis命令的代理方法（按需连接）
  async hset(key, ...args) {
    const client = await ensureConnection()
    return client.hset(key, ...args)
  },

  async hget(key, field) {
    const client = await ensureConnection()
    return client.hget(key, field)
  },

  async hgetall(key) {
    const client = await ensureConnection()
    return client.hgetall(key)
  },

  async exists(key) {
    const client = await ensureConnection()
    return client.exists(key)
  },

  async keys(pattern) {
    const client = await ensureConnection()
    // 使用SCAN命令替代KEYS命令，避免阻塞Redis服务器
    const keys = []
    let cursor = '0'

    do {
      const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')

    return keys
  },

  async del(key) {
    const client = await ensureConnection()
    return client.del(key)
  }
}

// 进程退出时清理连接
process.on('exit', cleanup)
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// 根据配置决定是否导出Redis客户端
module.exports = config.dataSaveMode === 'redis' ? redisClient : null
