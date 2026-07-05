const express = require('express')
const router = express.Router()
const config = require('../config')
const DataPersistence = require('../utils/data-persistence')
const { apiKeyVerify, adminKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')

const dataPersistence = new DataPersistence()


router.get('/settings', adminKeyVerify, async (req, res) => {
  // 分离管理员密钥和普通密钥
  const regularKeys = config.apiKeys.filter(key => key !== config.adminKey)

  res.json({
    apiKey: config.apiKey, // 保持向后兼容
    adminKey: config.adminKey,
    regularKeys: regularKeys,
    defaultHeaders: config.defaultHeaders,
    defaultCookie: config.defaultCookie,
    autoRefresh: config.autoRefresh,
    autoRefreshInterval: config.autoRefreshInterval,
    batchLoginConcurrency: config.batchLoginConcurrency,
    outThink: config.outThink,
    legacyReasoningInContent: config.legacyReasoningInContent,
    searchInfoMode: config.searchInfoMode,
    simpleModelMap: config.simpleModelMap,
    chatRetryCount: config.chatRetryCount,
    chatRetryBackoffMs: config.chatRetryBackoffMs
  })
})

// 添加普通API Key
router.post('/addRegularKey', adminKeyVerify, async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) {
      return res.status(400).json({ error: 'API Key不能为空' })
    }

    // 检查是否已存在
    if (config.apiKeys.includes(apiKey)) {
      return res.status(409).json({ error: 'API Key已存在' })
    }

    // 添加到配置中
    config.apiKeys.push(apiKey)

    const persisted = await dataPersistence.saveSettings({ apiKeys: config.apiKeys })

    res.json({ message: 'API Key添加成功', persisted })
  } catch (error) {
    logger.error('添加API Key失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 删除普通API Key
router.post('/deleteRegularKey', adminKeyVerify, async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) {
      return res.status(400).json({ error: 'API Key不能为空' })
    }

    // 不能删除管理员密钥
    if (apiKey === config.adminKey) {
      return res.status(403).json({ error: '不能删除管理员密钥' })
    }

    // 从配置中移除
    const index = config.apiKeys.indexOf(apiKey)
    if (index === -1) {
      return res.status(404).json({ error: 'API Key不存在' })
    }

    config.apiKeys.splice(index, 1)

    const persisted = await dataPersistence.saveSettings({ apiKeys: config.apiKeys })

    res.json({ message: 'API Key删除成功', persisted })
  } catch (error) {
    logger.error('删除API Key失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新自动刷新设置
router.post('/setAutoRefresh', adminKeyVerify, async (req, res) => {
  try {
    const { autoRefresh, autoRefreshInterval } = req.body

    if (typeof autoRefresh !== 'boolean') {
      return res.status(400).json({ error: '无效的自动刷新设置' })
    }

    if (autoRefreshInterval !== undefined) {
      const interval = parseInt(autoRefreshInterval)
      if (isNaN(interval) || interval < 0) {
        return res.status(400).json({ error: '无效的自动刷新间隔' })
      }
    }
    config.autoRefresh = autoRefresh
    config.autoRefreshInterval = autoRefreshInterval || 6 * 60 * 60
    res.json({
      status: true,
      message: '自动刷新设置更新成功'
    })
  } catch (error) {
    logger.error('更新自动刷新设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新批量登录并发数
router.post('/setBatchLoginConcurrency', adminKeyVerify, async (req, res) => {
  try {
    const concurrency = parseInt(req.body.batchLoginConcurrency)

    if (isNaN(concurrency) || concurrency < 1 || concurrency > 20) {
      return res.status(400).json({ error: '无效的批量登录并发数，允许范围为 1-20' })
    }

    config.batchLoginConcurrency = concurrency
    res.json({
      status: true,
      message: '批量登录并发数更新成功'
    })
  } catch (error) {
    logger.error('更新批量登录并发数失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新思考输出设置
router.post('/setOutThink', adminKeyVerify, async (req, res) => {
  try {
    const { outThink } = req.body;
    if (typeof outThink !== 'boolean') {
      return res.status(400).json({ error: '无效的思考输出设置' })
    }

    config.outThink = outThink
    res.json({
      status: true,
      message: '思考输出设置更新成功'
    })
  } catch (error) {
    logger.error('更新思考输出设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新推理输出格式（旧版：推理并入 content 的 <think> 标签；关闭：推理走 reasoning_content）
router.post('/setLegacyReasoning', adminKeyVerify, async (req, res) => {
  try {
    const { legacyReasoningInContent } = req.body
    if (typeof legacyReasoningInContent !== 'boolean') {
      return res.status(400).json({ error: '无效的推理格式设置' })
    }

    config.legacyReasoningInContent = legacyReasoningInContent
    res.json({
      status: true,
      message: '推理格式设置更新成功'
    })
  } catch (error) {
    logger.error('更新推理格式设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新搜索信息模式
router.post('/search-info-mode', adminKeyVerify, async (req, res) => {
  try {
    const { searchInfoMode } = req.body
    if (!['table', 'text'].includes(searchInfoMode)) {
      return res.status(400).json({ error: '无效的搜索信息模式' })
    }

    config.searchInfoMode = searchInfoMode
    res.json({
      status: true,
      message: '搜索信息模式更新成功'
    })
  } catch (error) {
    logger.error('更新搜索信息模式失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新聊天请求 retry 配置
router.post('/setRetryConfig', adminKeyVerify, async (req, res) => {
  try {
    const { chatRetryCount, chatRetryBackoffMs } = req.body
    const count = parseInt(chatRetryCount, 10)
    const backoff = parseInt(chatRetryBackoffMs, 10)

    if (isNaN(count) || count < 0 || count > 10) {
      return res.status(400).json({ error: '无效的 retry 次数，允许范围为 0-10' })
    }
    if (isNaN(backoff) || backoff < 0 || backoff > 60000) {
      return res.status(400).json({ error: '无效的 backoff 毫秒数，允许范围为 0-60000' })
    }

    config.chatRetryCount = count
    config.chatRetryBackoffMs = backoff

    // 持久化 (在 'none' 模式下 saveSettings вернёт false, но это ОК — env baseline остаётся)
    const persisted = await dataPersistence.saveSettings({
      chatRetryCount: count,
      chatRetryBackoffMs: backoff
    })

    logger.info(
      `聊天 retry 配置更新: count=${count}, backoff=${backoff}ms (持久化: ${persisted ? '是' : '否'})`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      message: '聊天 retry 配置更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新聊天 retry 配置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新简化模型映射设置
router.post('/simple-model-map', adminKeyVerify, async (req, res) => {
  try {
    const { simpleModelMap } = req.body
    if (typeof simpleModelMap !== 'boolean') {
      return res.status(400).json({ error: '无效的简化模型映射设置' })
    }

    config.simpleModelMap = simpleModelMap
    res.json({
      status: true,
      message: '简化模型映射设置更新成功'
    })
  } catch (error) {
    logger.error('更新简化模型映射设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
