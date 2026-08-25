const fs = require('fs')
const path = require('path')
const config = require('../config')
const { logger } = require('./logger')

class imgCacheManager {
  constructor() {
    this.cacheMap = new Map()
  }

  cacheIsExist(signature) {
    try {
      if (config.cacheMode === 'default') {
        return this.cacheMap.has(signature)
      } else {
        const cachePath = path.join(__dirname, '../../caches', `${signature}.txt`)
        return fs.existsSync(cachePath)
      }
    } catch (e) {
      logger.error('Cache check failed', 'CACHE', '', e)
      return false
    }
  }

  addCache(signature, url) {
    try {
      const isExist = this.cacheIsExist(signature)

      if (isExist) {
        return false
      } else {

        if (config.cacheMode === 'default') {
          this.cacheMap.set(signature, url)
        } else {
          const cachePath = path.join(__dirname, '../../caches', `${signature}.txt`)
          fs.writeFileSync(cachePath, url)
        }

        return true

      }
    } catch (e) {
      logger.error('Failed to add cache', 'CACHE', '', e)
      return false
    }
  }

  getCache(signature) {
    try {
      const cachePath = path.join(__dirname, '../../caches', `${signature}.txt`)
      const isExist = this.cacheIsExist(signature)

      if (isExist) {
        if (config.cacheMode === 'default') {
          return {
            status: 200,
            url: this.cacheMap.get(signature)
          }
        } else {
          const data = fs.readFileSync(cachePath, 'utf-8')
          return {
            status: 200,
            url: data
          }
        }
      } else {
        return {
          status: 404,
          url: null
        }
      }
    } catch (e) {
      logger.error('Failed to get cache', 'CACHE', '', e)
      return {
        status: 500,
        url: null
      }
    }
  }
}

module.exports = imgCacheManager
