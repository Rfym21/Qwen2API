const fs = require('fs')
const path = require('path')
const config = require('../config')
const { logger } = require('./logger')

// Vida de una URL de subida cacheada.
//
// Todo el beneficio ocurre dentro de un mismo turno del usuario: el bucle de tools manda
// varias peticiones HTTP y cada una re-subía la misma imagen (medido 2026-09-08: 6 subidas
// de 114440 bytes en 77 segundos). 10 minutos cubren el bucle más lento con holgura.
//
// El límite NO se apoya en conocer la caducidad real de las URLs de Qwen OSS: el `file_url`
// lo acuña el endpoint STS antes de subir un byte (upload.js:151-157), así que no tenemos
// cota inferior. Se apoya en que este repo ya envía la versión de TTL infinito de esta misma
// apuesta como despliegue Docker recomendado (README.md:207,222-234: CACHE_MODE=file con
// ./caches montado escribe la misma URL en disco y la reusa para siempre, entre reinicios).
// Un mapa en memoria acotado a 10 minutos es estrictamente más conservador que eso.
//
// Por eso este número NO debe hacerse configurable ni refrescarse en cada acierto: es la
// única cota sobre la antigüedad de una URL entregada al upstream.
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
// ~500 B por entrada (clave hex de 64 + URL) → 512 entradas < 0.5 MB.
const IMAGE_CACHE_MAX_ENTRIES = 512

class imgCacheManager {
  constructor() {
    this.cacheMap = new Map()
  }

  cacheIsExist(signature) {
    try {
      if (config.cacheMode === 'default') {
        // Caducidad perezosa, comprobada al leer. Sin setTimeout: un temporizador por
        // entrada mantiene viva la clausura y un handle en el event loop.
        const entry = this.cacheMap.get(signature)
        if (!entry) return false
        if (Date.now() - entry.at > IMAGE_CACHE_TTL_MS) {
          this.cacheMap.delete(signature)
          return false
        }
        return true
      } else {
        const cachePath = path.join(__dirname, '../../caches', `${signature}.txt`)
        return fs.existsSync(cachePath)
      }
    } catch (e) {
      logger.error('缓存检查失败', 'CACHE', '', e)
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
          this.cacheMap.set(signature, { url, at: Date.now() })
          // Las entradas nunca se refrescan, así que el orden de inserción ES el orden de
          // antigüedad: FIFO ya desaloja la más vieja. Un LRU no compraría nada y costaría
          // la garantía de antigüedad máxima.
          while (this.cacheMap.size > IMAGE_CACHE_MAX_ENTRIES) {
            this.cacheMap.delete(this.cacheMap.keys().next().value)
          }
        } else {
          const cachePath = path.join(__dirname, '../../caches', `${signature}.txt`)
          fs.writeFileSync(cachePath, url)
        }

        return true

      }
    } catch (e) {
      logger.error('添加缓存失败', 'CACHE', '', e)
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
            url: this.cacheMap.get(signature).url
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
      logger.error('获取缓存失败', 'CACHE', '', e)
      return {
        status: 500,
        url: null
      }
    }
  }

  /** Vacía el caché en memoria. Existe para aislar tests: el singleton vive a nivel de
   *  módulo y node --test aísla por archivo, no por test. */
  clear() {
    this.cacheMap.clear()
  }
}

module.exports = imgCacheManager
