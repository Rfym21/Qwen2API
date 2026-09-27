const config = require('../config')
const rateLimit = require('express-rate-limit')

const normalizeApiKey = providedKey => providedKey.startsWith('Bearer ') ? providedKey.slice(7) : providedKey

/**
 * 验证API Key是否有效
 * @param {string} providedKey - 提供的API Key
 * @returns {Object} 验证结果 { isValid: boolean, isAdmin: boolean }
 */
const validateApiKey = (providedKey) => {
  if (!providedKey) {
    return { isValid: false, isAdmin: false }
  }

  // 移除Bearer前缀
  const cleanKey = normalizeApiKey(providedKey)

  // 检查是否在有效的API keys列表中
  const isValid = config.apiKeys.includes(cleanKey)
  const isAdmin = cleanKey === config.adminKey

  return { isValid, isAdmin }
}

/**
 * API Key验证中间件 - 验证任何有效的API Key
 */
const apiKeyVerify = (req, res, next) => {
  const apiKey = req.headers['authorization'] || req.headers['Authorization'] || req.headers['x-api-key']
  const { isValid, isAdmin } = validateApiKey(apiKey)

  if (!isValid) {
    // Anthropic-compatible error schema for Claude Code clients.
    // Detect by x-api-key header or /v1/messages path — Claude Code always
    // sends x-api-key and hits /v1/messages. Accept header not required
    // (curl tests and some SDK versions omit it).
    const isAnthropicClient = !!(
      req.headers['x-api-key'] || req.path?.startsWith('/v1/messages')
    )
    if (isAnthropicClient) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' }
      })
    }
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // 将权限信息附加到请求对象
  req.isAdmin = isAdmin
  req.apiKey = normalizeApiKey(apiKey)
  next()
}

/**
 * 管理员权限验证中间件 - 只允许管理员API Key
 */
const adminKeyVerify = (req, res, next) => {
  const apiKey = req.headers['authorization'] || req.headers['Authorization'] || req.headers['x-api-key']
  const { isValid, isAdmin } = validateApiKey(apiKey)

  if (!isValid || !isAdmin) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  req.isAdmin = isAdmin
  req.apiKey = normalizeApiKey(apiKey)
  next()
}

const HEAVY_ENDPOINT_PATHS = [
  '/v1/chat/completions',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/videos',
  '/v1/messages',
  '/cli/v1/chat/completions'
]

const heavyEndpointLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.apiKey,
  handler: (req, res, _next, options) => {
    const untilReset = req.rateLimit?.resetTime instanceof Date
      ? req.rateLimit.resetTime.getTime() - Date.now()
      : options.windowMs
    res.set('Retry-After', String(Math.max(1, Math.ceil(untilReset / 1000))))
    const message = 'Too many requests; retry after the current rate-limit window'
    if (req.path.toLowerCase().startsWith('/v1/messages')) {
      return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message } })
    }
    return res.status(429).json({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message } })
  }
})

/**
 * Protect expensive API routes before global body parsers allocate request memory.
 * @param {import('express').Express} app - Express application receiving API routes.
 * @returns {void}
 */
const registerHeavyEndpointLimit = app => {
  app.post(HEAVY_ENDPOINT_PATHS, apiKeyVerify, heavyEndpointLimiter)
}

module.exports = {
  apiKeyVerify,
  adminKeyVerify,
  validateApiKey,
  registerHeavyEndpointLimit
}
