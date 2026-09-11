const fs = require('fs')
const config = require('../config')
const { logger } = require('./logger')
const { resolveRuntimePath } = require('./runtime-paths')

// Vida de una URL de subida cacheada.
//
// Todo el beneficio ocurre dentro de un mismo turno del usuario: el bucle de tools manda
// varias peticiones HTTP y cada una re-subía la misma imagen (medido 2026-09-08: 6 subidas
// de 114440 bytes en 77 segundos). 10 minutos cubren el bucle más lento con holgura.
//
// CORRECCIÓN 2026-09-08: la versión anterior de este comentario decía que no teníamos cota
// inferior sobre la vida de una URL de Qwen OSS. Sí la tenemos, y viene impresa en la propia
// URL. Medido subiendo un PNG de verdad:
//   x-oss-date = 20260909T042756Z   x-oss-expires = 300   x-oss-signature-version = OSS4-HMAC-SHA256
// Es decir 5 minutos desde la fecha de firma, la MITAD de este TTL. Pasado ese punto el OSS
// responde 403 `AccessDenied / Request has expired` y la imagen desaparece sin un solo error
// por nuestro lado: el upstream recibe una URL muerta y el modelo contesta como si no
// hubiera imagen. Por eso la caducidad real se lee de la URL (`presignedUrlExpiryMs`) y este
// número queda solo como tope superior por si algún día llega una URL sin firmar.
//
// No debe hacerse configurable ni refrescarse en cada acierto: es una cota sobre la
// antigüedad de una URL entregada al upstream, no un parámetro de rendimiento.
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000
// Cuando la URL no dice cuándo muere. Más corto que el tope de arriba a propósito: todo el
// beneficio del caché ocurre dentro de un turno (medido: 6 subidas en 77 s).
const UNKNOWN_EXPIRY_TTL_MS = 4 * 60 * 1000
// La URL todavía tiene que viajar en el cuerpo y que el upstream vaya a buscarla. Entregar
// una que caduca dentro de dos segundos es entregar una muerta.
const EXPIRY_SAFETY_MARGIN_MS = 30 * 1000

/**
 * Cuándo muere una URL prefirmada, leído de la propia URL.
 *
 * `x-oss-date` viene en ISO-8601 básico (`YYYYMMDDTHHMMSSZ`), que Date no parsea, y
 * `x-oss-expires` son segundos desde esa fecha.
 *
 * @param {string} url
 * @returns {number|null} epoch ms de la caducidad, o null si la URL no lo dice
 */
const presignedUrlExpiryMs = (url) => {
  try {
    const params = new URL(String(url)).searchParams
    const expires = Number(params.get('x-oss-expires'))
    const stamp = params.get('x-oss-date')
    if (!Number.isFinite(expires) || expires <= 0 || !stamp) return null
    const parts = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
    if (!parts) return null
    const signedAt = Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5], +parts[6])
    if (!Number.isFinite(signedAt)) return null
    return signedAt + expires * 1000
  } catch {
    return null
  }
}

/**
 * ¿Sigue sirviendo esta URL cacheada? Manda la caducidad firmada; si la URL no la lleva,
 * manda la antigüedad de la entrada.
 *
 * @param {string} url
 * @param {number|null} cachedAt - epoch ms en que se guardó, o null si no se sabe (modo file)
 * @returns {boolean}
 */
const cachedUrlIsUsable = (url, cachedAt) => {
  const expiry = presignedUrlExpiryMs(url)
  if (expiry !== null) return Date.now() + EXPIRY_SAFETY_MARGIN_MS < expiry
  if (!Number.isFinite(cachedAt)) return false
  return Date.now() - cachedAt <= UNKNOWN_EXPIRY_TTL_MS
}
// ~500 B por entrada (clave hex de 64 + URL) → 512 entradas < 0.5 MB.
const IMAGE_CACHE_MAX_ENTRIES = 512

class imgCacheManager {
  constructor() {
    this.cacheMap = new Map()
    if (config.cacheMode === 'file') {
      fs.mkdirSync(resolveRuntimePath('caches'), { recursive: true })
    }
  }

  cacheIsExist(signature) {
    try {
      if (config.cacheMode === 'default') {
        // Caducidad perezosa, comprobada al leer. Sin setTimeout: un temporizador por
        // entrada mantiene viva la clausura y un handle en el event loop.
        const entry = this.cacheMap.get(signature)
        if (!entry) return false
        if (Date.now() - entry.at > IMAGE_CACHE_TTL_MS || !cachedUrlIsUsable(entry.url, entry.at)) {
          this.cacheMap.delete(signature)
          return false
        }
        return true
      } else {
        // El modo file no guardaba caducidad NINGUNA: `existsSync` a secas servía la misma
        // URL para siempre, entre reinicios incluidos, y es el modo que el README recomienda
        // para Docker. La firma de la URL sí sabe cuándo muere, así que se lee de ahí; sin
        // firma se cae al mtime del fichero. Un fallo de lectura es un miss, no una excepción.
        const cachePath = resolveRuntimePath('caches', `${signature}.txt`)
        if (!fs.existsSync(cachePath)) return false
        const url = fs.readFileSync(cachePath, 'utf-8')
        if (cachedUrlIsUsable(url, fs.statSync(cachePath).mtimeMs)) return true
        // Se borra para que addCache vuelva a escribir: si no, addCache ve el fichero y
        // se cree que ya está guardado.
        try { fs.unlinkSync(cachePath) } catch { /* otro worker se adelantó */ }
        return false
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
          // Se borra antes de escribir para que la clave vuelva al FINAL del orden de
          // inserción: el desalojo FIFO de abajo da por hecho que ese orden es el de
          // antigüedad, y una entrada re-subida tras caducar es la más NUEVA de todas.
          this.cacheMap.delete(signature)
          this.cacheMap.set(signature, { url, at: Date.now() })
          // Las entradas nunca se refrescan, así que el orden de inserción ES el orden de
          // antigüedad: FIFO ya desaloja la más vieja. Un LRU no compraría nada y costaría
          // la garantía de antigüedad máxima.
          while (this.cacheMap.size > IMAGE_CACHE_MAX_ENTRIES) {
            this.cacheMap.delete(this.cacheMap.keys().next().value)
          }
        } else {
          const cachePath = resolveRuntimePath('caches', `${signature}.txt`)
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
      const cachePath = resolveRuntimePath('caches', `${signature}.txt`)
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
// Expuestos para poder probar la caducidad sin viajar en el tiempo ni tocar el disco.
module.exports.presignedUrlExpiryMs = presignedUrlExpiryMs
module.exports.cachedUrlIsUsable = cachedUrlIsUsable
