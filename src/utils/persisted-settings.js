const { logger } = require('./logger')
const { NAME_MAX_LENGTH } = require('./model-map')

/**
 * 把持久化的运行时设置套到 config 上（web UI > env > 硬编码默认值）。
 * 纯函数：不读盘、不联网、不监听；server.js 用 loadSettings() 的结果调用它。
 * @param {Object} config - src/config 对象（就地修改）
 * @param {Object} persisted - loadSettings() 的结果
 * @returns {Object} config
 */
const applyPersistedSettings = (config, persisted) => {
  const saved = (persisted && typeof persisted === 'object') ? persisted : {}

  if (saved.chatRetryCount !== undefined && saved.chatRetryCount !== '') {
    const v = parseInt(saved.chatRetryCount, 10)
    if (!isNaN(v) && v >= 0) config.chatRetryCount = v
  }
  if (saved.chatRetryBackoffMs !== undefined && saved.chatRetryBackoffMs !== '') {
    const v = parseInt(saved.chatRetryBackoffMs, 10)
    if (!isNaN(v) && v >= 0) config.chatRetryBackoffMs = v
  }
  if (saved.apiKeys?.length > 1) {
    config.apiKeys = saved.apiKeys
    config.adminKey = saved.apiKeys[0]
  }
  // dashboard 保存过的模型映射覆盖 MODEL_MAP env。空串也是有效值（已清空）；null / 缺失表示未设置或已恢复 env。
  if (typeof saved.modelMap === 'string') {
    if (saved.modelMap !== config.modelMap) {
      logger.info(`MODEL_MAP env overridden by dashboard-saved map: "${saved.modelMap.slice(0, NAME_MAX_LENGTH)}"`, 'CONFIG')
    }
    config.modelMap = saved.modelMap
  }

  return config
}

module.exports = { applyPersistedSettings }
