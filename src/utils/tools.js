const crypto = require('crypto')
const { jwtDecode } = require('jwt-decode')
const { logger } = require('./logger')


const isJson = (str) => {
  try {
    JSON.parse(str)
    return true
  } catch (error) {
    return false
  }
}

const sleep = async (ms) => {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

const sha256Encrypt = (text) => {
  if (typeof text !== 'string') {
    logger.error('Input must be a string', 'TOOLS')
    throw new Error('Input must be a string')
  }
  const hash = crypto.createHash('sha256')
  hash.update(text, 'utf-8')
  return hash.digest('hex')
}

const JwtDecode = (token) => {
  try {
    const decoded = jwtDecode(token, { complete: true })
    return decoded
  } catch (error) {
    logger.error('Failed to parse JWT', 'JWT', '', error)
    return null
  }
}

/**
 * 生成UUID v4
 * 使用Node.js内置的crypto.randomUUID()
 * @returns {string} UUID v4字符串
 */
const generateUUID = () => {
  return crypto.randomUUID()
}

/**
 * 浏览器风格 timezone 请求头（仅 ASCII）
 * 中文 Windows 的 Date#toString 含“中国标准时间”，会破坏 HTTP 头。
 * @returns {string}
 */
const getTimezoneHeader = () => {
  // 去掉非 ASCII（如“中国标准时间”），并压缩空白
  return new Date().toString().replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
}

module.exports = {
  isJson,
  sleep,
  sha256Encrypt,
  JwtDecode,
  generateUUID,
  getTimezoneHeader
}
