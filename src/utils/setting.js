const accountManager = require('./account')
const { logger } = require('./logger')

/**
 * 账户设置工具
 * 提供账户的保存和删除功能，使用统一的账户管理器
 */

/**
 * 保存账户信息
 * @param {string} email - 邮箱地址
 * @param {string} password - 密码
 * @param {string} token - 访问令牌
 * @param {number} expires - 过期时间戳
 * @param {string|null} [proxy] - 账号专属代理 URL
 * @returns {Promise<boolean>} 保存是否成功
 */
const saveAccounts = async (email, password, token, expires, proxy = null) => {
  try {
    // 参数验证
    if (!email || !password) {
      logger.error('Failed to save account: email and password cannot be empty', 'SETTING')
      return false
    }

    // 使用账户管理器的统一方法
    const success = await accountManager.addAccount(email, password, proxy)

    if (success) {
      logger.success(`Account ${email} saved successfully`, 'SETTING')
      return true
    } else {
      logger.error(`Failed to save account ${email}`, 'SETTING')
      return false
    }
  } catch (error) {
    logger.error(`Error while saving account ${email}`, 'SETTING', '', error)
    return false
  }
}

/**
 * 删除账户
 * @param {string} email - 邮箱地址
 * @returns {Promise<boolean>} 删除是否成功
 */
const deleteAccount = async (email) => {
  try {
    // 参数验证
    if (!email) {
      logger.error('Failed to delete account: email cannot be empty', 'SETTING')
      return false
    }

    // 使用账户管理器的统一方法
    const success = await accountManager.removeAccount(email)

    if (success) {
      logger.success(`Account ${email} deleted successfully`, 'SETTING')
      return true
    } else {
      logger.error(`Failed to delete account ${email}`, 'SETTING')
      return false
    }
  } catch (error) {
    logger.error(`Error while deleting account ${email}`, 'SETTING', '', error)
    return false
  }
}

/**
 * 获取所有账户信息
 * @returns {Array} 账户列表
 */
const getAllAccounts = () => {
  try {
    return accountManager.getAllAccountKeys()
  } catch (error) {
    logger.error('Error while getting account list', 'SETTING', '', error)
    return []
  }
}

/**
 * 获取账户健康状态
 * @returns {Object} 健康状态统计
 */
const getAccountHealth = () => {
  try {
    return accountManager.getHealthStats()
  } catch (error) {
    logger.error('Error while getting account health status', 'SETTING', '', error)
    return {
      accounts: { total: 0, valid: 0, expired: 0, expiringSoon: 0, invalid: 0 },
      rotation: { total: 0, available: 0, inCooldown: 0 },
      initialized: false
    }
  }
}

/**
 * 手动刷新账户令牌
 * @param {string} email - 邮箱地址
 * @returns {Promise<boolean>} 刷新是否成功
 */
const refreshAccountToken = async (email) => {
  try {
    if (!email) {
      logger.error('Token refresh failed: email cannot be empty', 'SETTING')
      return false
    }

    const success = await accountManager.refreshAccountToken(email)

    if (success) {
      logger.success(`Account ${email} token refreshed successfully`, 'SETTING')
      return true
    } else {
      logger.error(`Account ${email} token refresh failed`, 'SETTING')
      return false
    }
  } catch (error) {
    logger.error(`Error while refreshing token for account ${email}`, 'SETTING', '', error)
    return false
  }
}

module.exports = {
  saveAccounts,
  deleteAccount,
  getAllAccounts,
  getAccountHealth,
  refreshAccountToken
}