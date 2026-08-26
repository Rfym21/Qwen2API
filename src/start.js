const cluster = require('cluster')
const os = require('os')
const { logger } = require('./utils/logger')

// 加载环境变量
require('dotenv').config()

// 获取CPU核心数
const cpuCores = os.cpus().length

// 获取环境变量配置
const PM2_INSTANCES = process.env.PM2_INSTANCES || '1'
const SERVICE_PORT = process.env.SERVICE_PORT || 3000
const NODE_ENV = process.env.NODE_ENV || 'production'

// 解析进程数
let instances
if (PM2_INSTANCES === 'max') {
  instances = cpuCores
} else if (!isNaN(PM2_INSTANCES)) {
  instances = parseInt(PM2_INSTANCES)
} else {
  instances = 1
}

// 限制进程数不能超过CPU核心数
if (instances > cpuCores) {
  logger.warn(`Configured processes(${instances}) exceeds CPU cores(${cpuCores}), auto-adjusting to ${cpuCores}`, 'AUTO')
  instances = cpuCores
}

logger.info('🚀 Qwen2API Smart Boot', 'AUTO')
logger.info(`CPU cores: ${cpuCores}`, 'AUTO')
logger.info(`Configured processes: ${PM2_INSTANCES}`, 'AUTO')
logger.info(`Actual started processes: ${instances}`, 'AUTO')
logger.info(`Service port: ${SERVICE_PORT}`, 'AUTO')

// 智能判断启动方式
if (instances === 1) {
  logger.info('📦 Starting in single-process mode', 'AUTO')
  // 直接启动服务器
  require('./server.js')
} else {
  // 检查是否通过PM2启动
  if (process.env.PM2_USAGE || process.env.pm_id !== undefined) {
    logger.info(`PM2 process started - PID: ${process.pid}, Worker PID: ${process.env.pm_id || 'unknown'}`, 'PM2')
    require('./server.js')
  } else if (cluster.isMaster) {
    logger.info(`🔥 Starting with Node.js cluster mode (${instances} processes)`, 'AUTO')

    logger.info(`Starting master process - PID: ${process.pid}`, 'CLUSTER')
    logger.info(`Runtime environment: ${NODE_ENV}`, 'CLUSTER')

    // Create worker processes
    for (let i = 0; i < instances; i++) {
      const worker = cluster.fork()
      logger.info(`Starting worker process ${i + 1}/${instances} - PID: ${worker.process.pid}`, 'CLUSTER')
    }

    // Listen for worker exit
    cluster.on('exit', (worker, code, signal) => {
      logger.error(`Worker process ${worker.process.pid} exited - code: ${code}, signal: ${signal}`, 'CLUSTER')

      // Auto-restart worker
      if (!worker.exitedAfterDisconnect) {
        logger.info('Restarting worker process...', 'CLUSTER')
        const newWorker = cluster.fork()
        logger.info(`New worker process started - PID: ${newWorker.process.pid}`, 'CLUSTER')
      }
    })

    // Listen for worker online
    cluster.on('online', (worker) => {
      logger.info(`Worker process ${worker.process.pid} is online`, 'CLUSTER')
    })

    // Listen for worker disconnect
    cluster.on('disconnect', (worker) => {
      logger.warn(`Worker process ${worker.process.pid} disconnected`, 'CLUSTER')
    })

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully...', 'CLUSTER')
      cluster.disconnect(() => {
        process.exit(0)
      })
    })

    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully...', 'CLUSTER')
      cluster.disconnect(() => {
        process.exit(0)
      })
    })

  } else {
    // Worker process logic
    logger.info(`Worker process started - PID: ${process.pid}`, 'WORKER')
    require('./server.js')

    // Worker graceful shutdown
    process.on('SIGTERM', () => {
      logger.info(`Worker process ${process.pid} received SIGTERM, closing...`, 'WORKER')
      process.exit(0)
    })

    process.on('SIGINT', () => {
      logger.info(`Worker process ${process.pid} received SIGINT, closing...`, 'WORKER')
      process.exit(0)
    })
  }
}
