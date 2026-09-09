const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const uploadModule = require('../src/utils/upload.js')
const { parserMessages, imgCacheManager } = require('../src/utils/chat-helpers.js')
const CacheManager = require('../src/utils/img-caches.js')
const config = require('../src/config')

const { presignedUrlExpiryMs, cachedUrlIsUsable } = CacheManager

// Medido 2026-09-08 subiendo un PNG real a Qwen: el file_url devuelto lleva
// `x-oss-expires=300` y `x-oss-date`, o sea 5 minutos de vida. El caché lo servía hasta
// 10 minutos (modo default) o para siempre (modo file, el que recomienda el README para
// Docker). Pasada la firma el OSS responde 403 `Request has expired` y la imagen se cae
// sin un solo error por nuestro lado: el upstream recibe una URL muerta.
const signed = (offsetSeconds, expires = 300) => {
  const at = new Date(Date.now() + offsetSeconds * 1000)
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `https://qwen-webui-prod.oss-accelerate.aliyuncs.com/a/b.png?x-oss-date=${stamp}&x-oss-expires=${expires}&x-oss-signature-version=OSS4-HMAC-SHA256`
}

test('lee la caducidad firmada de la propia URL', () => {
  const url = 'https://oss.invalid/a.png?x-oss-date=20260909T042756Z&x-oss-expires=300'
  assert.equal(presignedUrlExpiryMs(url), Date.UTC(2026, 8, 9, 4, 27, 56) + 300000)
})

test('una URL sin firma o con firma ilegible no inventa caducidad', () => {
  for (const url of [
    'https://oss.invalid/a.png',
    'https://oss.invalid/a.png?x-oss-expires=300',
    'https://oss.invalid/a.png?x-oss-date=nope&x-oss-expires=300',
    'https://oss.invalid/a.png?x-oss-date=20260909T042756Z&x-oss-expires=abc',
    'no es una url'
  ]) {
    assert.equal(presignedUrlExpiryMs(url), null, url)
  }
})

test('la firma manda sobre la antiguedad de la entrada, en los dos sentidos', () => {
  // Recien guardada pero ya caducada: NO se puede servir aunque el TTL del mapa sobre.
  assert.equal(cachedUrlIsUsable(signed(-600), Date.now()), false)
  // Firmada hace poco: se sirve.
  assert.equal(cachedUrlIsUsable(signed(-10), Date.now()), true)
  // Dentro del margen de seguridad: le quedan segundos, no llega vivo al upstream.
  assert.equal(cachedUrlIsUsable(signed(-295), Date.now()), false)
})

test('sin firma se cae a un TTL conservador, no al tope de 10 minutos', () => {
  const url = 'https://oss.invalid/a.png'
  assert.equal(cachedUrlIsUsable(url, Date.now()), true)
  assert.equal(cachedUrlIsUsable(url, Date.now() - 3 * 60 * 1000), true)
  assert.equal(cachedUrlIsUsable(url, Date.now() - 5 * 60 * 1000), false, '5 min < el TTL de 10 min del mapa')
  assert.equal(cachedUrlIsUsable(url, null), false, 'sin fecha ni firma no hay nada que garantice')
})

const realUpload = uploadModule.uploadFileToQwenOss
after(() => { uploadModule.uploadFileToQwenOss = realUpload })

let calls = 0
let nextUrl = () => `https://oss.invalid/${calls}.png`
const imageMessages = (b64) => ([{
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }]
}])

beforeEach(() => {
  imgCacheManager.clear()
  calls = 0
  uploadModule.uploadFileToQwenOss = async () => {
    calls += 1
    return { status: 200, file_url: nextUrl(), file_id: `f${calls}` }
  }
})

test('una URL viva se reusa; una caducada se vuelve a subir', async () => {
  // La primera subida devuelve una URL firmada hace 10 minutos: ya nace muerta.
  const delivered = []
  nextUrl = () => { const u = calls === 1 ? signed(-600) : signed(-1); delivered.push(u); return u }
  await parserMessages(imageMessages('QUJD'), {}, 't2t')
  const second = JSON.stringify(await parserMessages(imageMessages('QUJD'), {}, 't2t'))
  assert.equal(calls, 2, 'la URL ya caducada no se puede reusar')
  assert.ok(second.includes(delivered[1].split('?')[0]), 'se entrega la URL de la RE-subida')
  assert.ok(presignedUrlExpiryMs(delivered[1]) > Date.now(), 'y esa si sigue viva')

  nextUrl = () => signed(-1)
  imgCacheManager.clear()
  calls = 0
  await parserMessages(imageMessages('WFla'), {}, 't2t')
  await parserMessages(imageMessages('WFla'), {}, 't2t')
  assert.equal(calls, 1, 'una URL viva SI se reusa dentro del turno')
})

test('modo file: una URL caducada en disco es un miss y se reescribe', () => {
  const cachesDir = path.join(__dirname, '..', 'caches')
  fs.mkdirSync(cachesDir, { recursive: true })
  const signature = `test-expiry-${process.pid}`
  const cachePath = path.join(cachesDir, `${signature}.txt`)
  const previousMode = config.cacheMode
  config.cacheMode = 'file'
  try {
    const manager = new CacheManager()
    fs.writeFileSync(cachePath, signed(-600))
    // Antes de esto el modo file era un existsSync a secas: servia la URL muerta para
    // siempre, entre reinicios incluidos.
    assert.equal(manager.cacheIsExist(signature), false, 'una URL muerta en disco no es un acierto')
    assert.equal(fs.existsSync(cachePath), false, 'la entrada muerta se retira para poder reescribirla')

    assert.equal(manager.addCache(signature, signed(-1)), true)
    assert.equal(manager.cacheIsExist(signature), true)
    assert.equal(manager.getCache(signature).status, 200)
  } finally {
    config.cacheMode = previousMode
    try { fs.unlinkSync(cachePath) } catch { /* ya no está */ }
  }
})
