const express = require('express')
const router = express.Router()
const config = require('../config')
const DataPersistence = require('../utils/data-persistence')
const { adminKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')
const { NAME_MAX_LENGTH, buildModelMap, parseModelMap, getUnmappedModels, forgetUnmapped } = require('../utils/model-map')
const { getLatestModels } = require('../models/models-map')

const dataPersistence = new DataPersistence()

// 可作为映射目标的聊天模型 id：每个 t2t 模型的 id，支持 thinking 的再加一个 -thinking 变体。
// 不受 simpleModelMap 影响：dashboard 的下拉框要能选到 -thinking。
const listChatTargets = (models) => {
  const targets = []
  for (const model of (Array.isArray(models) ? models : [])) {
    const id = String(model?.id || '')
    if (!id || !model?.info?.meta?.chat_type?.includes('t2t')) continue
    targets.push(id)
    if (model?.info?.meta?.abilities?.thinking) targets.push(`${id}-thinking`)
  }
  return targets
}

const isUnknownTargetError = (item) =>
  (item.field === 'target' || item.field === 'fallback') && String(item.message).includes('is not an upstream model')

router.get('/settings', adminKeyVerify, async (req, res) => {
  // 分离管理员密钥和普通密钥
  const regularKeys = config.apiKeys.filter(key => key !== config.adminKey)
  const upstreamModels = await getLatestModels().catch(() => [])

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
    chatRetryBackoffMs: config.chatRetryBackoffMs,
    // 模型映射：当前生效原文、env 种子（用于标记每行来源）、可选目标、落到回退目标的入站名（本进程）
    modelMap: config.modelMap,
    modelMapEnv: process.env.MODEL_MAP || '',
    modelMapTargets: listChatTargets(upstreamModels),
    unmappedModels: getUnmappedModels(),
    dataSaveMode: config.dataSaveMode
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

// 更新模型映射：{ entries: [{ alias, target }], fallback } 或 { reset: true }
// 每个 target 都对照上游模型列表校验；任一错误 → 400，什么都不改。
// mapIncomingModel 每次重新解析 config.modelMap，所以改字符串即刻生效，无需重启。
router.post('/setModelMap', adminKeyVerify, async (req, res) => {
  try {
    const { entries, fallback, reset } = req.body || {}

    // 恢复 env：清掉 dashboard 保存的映射（存 null → applyPersistedSettings 视为未设置）
    if (reset === true) {
      config.modelMap = process.env.MODEL_MAP || ''
      const persisted = await dataPersistence.saveSettings({ modelMap: null })
      logger.info(`模型映射已恢复为 env (持久化: ${persisted ? '是' : '否'})`, 'CONFIG', '⚙️')
      return res.json({
        status: true,
        reset: true,
        message: '模型映射已恢复为 env',
        persisted,
        modelMap: config.modelMap,
        dataSaveMode: config.dataSaveMode
      })
    }

    // 没有 entries 数组的请求体（{}、[]、非 JSON）不能被当成"清空映射"
    if (!Array.isArray(entries)) {
      return res.status(400).json({
        error: '无效的模型映射',
        errors: [{ index: null, field: 'entries', value: '', message: 'entries must be an array' }]
      })
    }

    let upstreamModels = await getLatestModels()
    let result = buildModelMap(entries, fallback, upstreamModels)
    // 目标不在列表里：模型列表缓存可能已过期（最长一小时），强制刷新一次再判
    if (result.errors.some(isUnknownTargetError)) {
      upstreamModels = await getLatestModels(true)
      result = buildModelMap(entries, fallback, upstreamModels)
    }
    const { raw, errors } = result

    if (errors.length > 0) {
      return res.status(400).json({ error: '无效的模型映射', errors })
    }

    config.modelMap = raw

    // 'none' 模式下 saveSettings 返回 false：只在内存里生效，env 仍是重启后的基线
    const persisted = await dataPersistence.saveSettings({ modelMap: raw })

    // 已经分配了映射的名字不再是"待分配"
    forgetUnmapped(Object.keys(parseModelMap(raw)).filter(alias => alias !== '*'))

    logger.info(
      `模型映射更新: "${raw.slice(0, NAME_MAX_LENGTH)}" (持久化: ${persisted ? '是' : '否'})`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      message: '模型映射更新成功',
      persisted,
      modelMap: raw,
      dataSaveMode: config.dataSaveMode
    })
  } catch (error) {
    logger.error('更新模型映射失败', 'CONFIG', '', error)
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
