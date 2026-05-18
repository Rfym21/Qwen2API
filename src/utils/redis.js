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
      logger.error(`Redis连接重试次数超限: ${times}`, 'REDIS')
      return null
    }

    const delay = Math.min(100 * Math.pow(2, times), 3000)
    logger.info(`Redis重试连接: ${times}, 延迟: ${delay}ms`, 'REDIS', '🔄')
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
        throw new Error(`PING 返回异常: ${pong}`)
      }

      if (attempt > 1) {
        logger.info(`Redis命令通道在第 ${attempt} 次校验时恢复正常`, 'REDIS', '✅')
      }

      return
    } catch (error) {
      lastError = error

      if (attempt >= REDIS_VERIFY_RETRIES) {
        break
      }

      logger.warn(`Redis命令通道校验失败，第 ${attempt} 次后准备重试: ${error.message}`, 'REDIS')
      await new Promise(resolve => setTimeout(resolve, REDIS_VERIFY_RETRY_DELAY))
    }
  }

  throw new Error(`Redis命令通道不可用: ${lastError ? lastError.message : '未知错误'}`)
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
      logger.info('Redis连接空闲超时，断开连接', 'REDIS', '🔌')
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
    logger.success('Redis连接建立', 'REDIS')
  })

  client.on('ready', () => {
    logger.success('Redis准备就绪', 'REDIS')
    if (redis === client) {
      updateActivity()
    }
  })

  client.on('error', (err) => {
    logger.error('Redis连接错误', 'REDIS', '', err)
  })

  client.on('close', () => {
    logger.info('Redis连接关闭', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('end', () => {
    logger.info('Redis连接结束', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('reconnecting', (delay) => {
    logger.info(`Redis重新连接中...延迟: ${delay}ms`, 'REDIS', '🔄')
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
      logger.info('建立Redis连接...', 'REDIS', '🔌')

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

      logger.error('Redis连接失败', 'REDIS', '', error)
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
      logger.info('Redis连接已断开', 'REDIS', '🔌')
    } catch (error) {
      logger.error('断开Redis连接时出错', 'REDIS', '', error)
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
    logger.error('当前数据保存模式不是Redis', 'REDIS')
    throw new Error('当前数据保存模式不是Redis')
  }

  if (!redis || redis.status !== 'ready') {
    return await connectRedis()
  }

  if (Date.now() - lastActivity > STALE_CONNECTION_THRESHOLD) {
    logger.info('Redis连接空闲时间过长，主动重建连接', 'REDIS', '🔄')
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
      logger.info('没有找到任何账户', 'REDIS', '✅')
      return []
    }

    // 使用pipeline一次性获取所有账户数据
    const pipeline = client.pipeline()
    keys.forEach(key => {
      pipeline.hgetall(key)
    })

    const results = await pipeline.exec()
    if (!results) {
      logger.error('获取账户数据失败', 'REDIS')
      return []
    }

    const accounts = results.map((result, index) => {
      // result格式为[err, value]
      const [err, accountData] = result
      if (err) {
        logger.error(`获取账户 ${keys[index]} 数据失败`, 'REDIS', '', err)
        return null
      }
      if (!accountData || Object.keys(accountData).length === 0) {
        logger.error(`账户 ${keys[index]} 数据为空`, 'REDIS')
        return null
      }
      // stats 以 JSON 字符串存储于 HSET——malformed/missing 返回 undefined，由上层 ensureStats 补默认
      let stats
      if (accountData.stats) {
        try {
          stats = JSON.parse(accountData.stats)
        } catch (parseError) {
          logger.warn(`账户 ${keys[index]} stats JSON 解析失败，使用默认值: ${parseError.message}`, 'REDIS')
          stats = undefined
        }
      }
      return {
        email: keys[index].replace('user:', ''),
        password: accountData.password || '',
        token: accountData.token || '',
        expires: accountData.expires || '',
        proxy: accountData.proxy || null,
        stats
      }
    }).filter(Boolean) // 过滤掉null值

    logger.success(`获取所有账户成功，共 ${accounts.length} 个账户`, 'REDIS')
    return accounts
  } catch (err) {
    logger.error('获取账户时出错', 'REDIS', '', err)
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

    const { password, token, expires, proxy, stats } = value

    // 仅写入显式传入的字段——HSET 不影响其他字段，保留 MERGE 语义
    // 这样 partial save（token refresh / proxy update）不会清零 daily stats
    const payload = {}
    if (password !== undefined) payload.password = password || ''
    if (token !== undefined) payload.token = token || ''
    if (expires !== undefined) payload.expires = expires || ''
    if (proxy !== undefined) payload.proxy = proxy || ''
    if (stats !== undefined) payload.stats = JSON.stringify(stats)

    if (Object.keys(payload).length === 0) {
      logger.warn(`账户 ${key} setAccount 收到空 payload，跳过写入`, 'REDIS')
      return true
    }

    await client.hset(`user:${key}`, payload)

    logger.success(`账户 ${key} 设置成功`, 'REDIS')
    return true
  } catch (err) {
    logger.error(`设置账户 ${key} 失败`, 'REDIS', '', err)
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
      logger.success(`账户 ${key} 删除成功`, 'REDIS')
      return true
    } else {
      logger.warn(`账户 ${key} 不存在`, 'REDIS')
      return false
    }
  } catch (err) {
    logger.error(`删除账户 ${key} 失败`, 'REDIS', '', err)
    return false
  }
}

const SETTINGS_KEY = 'qwen2api:settings'

/**
 * 获取运行时设置
 * @returns {Promise<Object>} 设置对象 (字段类型 — string, 调用方ответственен за parseInt)
 */
const getSettings = async () => {
  try {
    const client = await ensureConnection()
    const data = await client.hgetall(SETTINGS_KEY)
    return data && Object.keys(data).length > 0 ? data : {}
  } catch (err) {
    logger.error('获取运行时设置失败', 'REDIS', '', err)
    return {}
  }
}

/**
 * 保存运行时设置（部分合并 через hset）
 * @param {Object} partial - 字段
 * @returns {Promise<boolean>} 设置是否成功
 */
const setSettings = async (partial) => {
  try {
    const client = await ensureConnection()
    const stringified = {}
    for (const [k, v] of Object.entries(partial || {})) {
      stringified[k] = v === null || v === undefined ? '' : String(v)
    }
    if (Object.keys(stringified).length === 0) return true
    await client.hset(SETTINGS_KEY, stringified)
    return true
  } catch (err) {
    logger.error('保存运行时设置失败', 'REDIS', '', err)
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

    logger.info(`键 "${key}" ${result ? '存在' : '不存在'}`, 'REDIS', result ? '✅' : '❌')
    return result
  } catch (err) {
    logger.error(`检查键 "${key}" 时出错`, 'REDIS', '', err)
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
  logger.info('清理Redis连接...', 'REDIS', '🧹')
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
