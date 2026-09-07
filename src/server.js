const express = require('express')
const bodyParser = require('body-parser')
const config = require('./config/index.js')
const cors = require('cors')
const Tokens = require('csrf')
const { logger } = require('./utils/logger')
const DataPersistence = require('./utils/data-persistence')
const persistedSettings = require('./utils/persisted-settings')
const app = express()
const path = require('path')
const fs = require('fs')
const csrfTokens = new Tokens()
const modelsRouter = require('./routes/models.js')
const chatRouter = require('./routes/chat.js')
const cliChatRouter = require('./routes/cli.chat.js')
const anthropicRouter = require('./routes/anthropic.js')
const verifyRouter = require('./routes/verify.js')
const accountsRouter = require('./routes/accounts.js')
const settingsRouter = require('./routes/settings.js')

if (config.dataSaveMode === 'file') {
  if (!fs.existsSync(path.join(__dirname, '../data/data.json'))) {
    fs.writeFileSync(path.join(__dirname, '../data/data.json'), JSON.stringify({"accounts": [] }, null, 2))
  }
}

// SSXMOD initialization is now lazy (per-account); no startup side effect

app.use(bodyParser.json({ limit: '128mb' }))
app.use(bodyParser.urlencoded({ limit: '128mb', extended: true }))
app.use(cors())

// CSRF token endpoint: browser clients GET a token tied to a per-request secret
app.get('/api/csrf-token', (req, res) => {
  const secret = csrfTokens.secretSync()
  const token = csrfTokens.create(secret)
  // Return both so the client can store the secret in sessionStorage and send
  // both back on state-changing requests via X-CSRF-Token and X-CSRF-Secret headers
  res.json({ csrfToken: token, csrfSecret: secret })
})

// 没有凭证可用的公开端点：管理面板登录接口
const CSRF_EXEMPT_PATHS = new Set(['/verify'])

// CSRF validation middleware for state-changing browser requests
// API key clients (Authorization / x-api-key header) are exempt
const csrfProtect = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  // 登录请求本身没有凭证可带——它就是登录。放行后仍由 /verify 自己校验 apiKey。
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next()
  if (req.headers['authorization'] || req.headers['x-api-key']) return next()
  const secret = req.headers['x-csrf-secret']
  const token = req.headers['x-csrf-token']
  if (secret && token && csrfTokens.verify(secret, token)) return next()
  // Anthropic-compatible error schema for Claude Code clients.
  // Match authorization.js heuristic: x-api-key header or /v1/messages path.
  // Accept header not required (curl tests and some SDK versions omit it).
  const isAnthropicClient = !!(
    req.headers['x-api-key'] || req.path?.startsWith('/v1/messages')
  )
  if (isAnthropicClient) {
    return res.status(403).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid CSRF token' }
    })
  }
  return res.status(403).json({ error: 'Invalid CSRF token' })
}
app.use(csrfProtect)

// API路由
app.use(modelsRouter)
app.use(chatRouter)
app.use(cliChatRouter)
app.use(anthropicRouter)
app.use(verifyRouter)
app.use('/api', accountsRouter)
app.use('/api', settingsRouter)

app.use(express.static(path.join(__dirname, '../public/dist')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dist/index.html'), (err) => {
    if (err) {
      logger.error('管理页面加载失败', 'SERVER', '', err)
      res.status(500).send('服务器内部错误')
    }
  })
})

// 处理错误中间件（必须放在所有路由之后）
app.use((err, req, res, next) => {
  logger.error('服务器内部错误', 'SERVER', '', err)
  res.status(500).send('服务器内部错误')
})


// 服务器启动信息
const serverInfo = {
  address: config.listenAddress || 'localhost',
  port: config.listenPort,
  outThink: config.outThink ? '开启' : '关闭',
  legacyReasoning: config.legacyReasoningInContent ? '开启' : '关闭',
  searchInfoMode: config.searchInfoMode === 'table' ? '表格' : '文本',
  dataSaveMode: config.dataSaveMode,
  logLevel: config.logLevel,
  enableFileLog: config.enableFileLog
}

// 应用持久化的运行时设置（web UI > env > hardcoded default）
// Web UI 可覆盖 chatRetryCount / chatRetryBackoffMs; env в config/index.js — baseline
const applyPersistedSettings = async () => {
  try {
    const persisted = await new DataPersistence().loadSettings()
    persistedSettings.applyPersistedSettings(config, persisted)
  } catch (err) {
    logger.warn('加载持久化设置失败, 使用 env/默认值', 'CONFIG', '', err.message)
  }
}

const startServer = () => {
  if (config.listenAddress) {
    app.listen(config.listenPort, config.listenAddress, () => {
      logger.server('服务器启动成功', 'SERVER', serverInfo)
      logger.info('开源地址: https://github.com/Rfym21/Qwen2API', 'INFO')
      logger.info('电报群聊: https://t.me/nodejs_project', 'INFO')
    })
  } else {
    app.listen(config.listenPort, () => {
      logger.server('服务器启动成功', 'SERVER', serverInfo)
      logger.info('开源地址: https://github.com/Rfym21/Qwen2API', 'INFO')
      logger.info('电报群聊: https://t.me/nodejs_project', 'INFO')
    })
  }
}

applyPersistedSettings().finally(startServer)