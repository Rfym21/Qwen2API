const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')

const uploadModule = require('../src/utils/upload.js')
const { parserMessages, imgCacheManager } = require('../src/utils/chat-helpers.js')
const CacheManager = require('../src/utils/img-caches.js')

// El uploader se sustituye sobre el OBJETO del módulo. Solo funciona porque chat-helpers
// guarda una referencia al módulo en vez de desestructurar la función: con el binding
// desestructurado el stub se ignora en silencio y el test pega a la red de verdad.
const realUpload = uploadModule.uploadFileToQwenOss
after(() => { uploadModule.uploadFileToQwenOss = realUpload })

let calls = 0

const imageMessages = (b64) => ([{
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }]
}])

beforeEach(() => {
  // Aislamiento. node --test aísla por ARCHIVO, no por test, y el caché es un singleton
  // de módulo: sin esto el segundo test vería la entrada del primero y contaría 1 subida
  // donde espera 2. Esta línea es la razón de que clear() exista.
  imgCacheManager.clear()
  calls = 0
  uploadModule.uploadFileToQwenOss = async () => {
    calls += 1
    return { status: 200, file_url: `https://oss.invalid/${calls}.png`, file_id: `f${calls}` }
  }
})

test('la misma imagen en dos peticiones se sube UNA vez', async () => {
  // Dos llamadas a parserMessages == dos peticiones HTTP del mismo turno (bucle de tools).
  const first = await parserMessages(imageMessages('QUJD'), {}, 't2t')
  const second = await parserMessages(imageMessages('QUJD'), {}, 't2t')
  assert.equal(calls, 1, 'la segunda petición debe reusar la URL cacheada')
  // No basta con contar subidas: hay que comprobar que la URL entregada es la buena.
  assert.match(JSON.stringify(first), /oss\.invalid\/1\.png/)
  assert.match(JSON.stringify(second), /oss\.invalid\/1\.png/)
})

test('una imagen distinta sí se vuelve a subir', async () => {
  await parserMessages(imageMessages('QUJD'), {}, 't2t')
  await parserMessages(imageMessages('WFla'), {}, 't2t')
  assert.equal(calls, 2, 'el caché no debe colapsar imágenes distintas')
})

test('una entrada más vieja que el TTL no se sirve', () => {
  // Instancia propia: nunca toca el singleton.
  const cache = new CacheManager()
  cache.addCache('sig', 'https://oss.invalid/old.png')
  assert.equal(cache.cacheIsExist('sig'), true)
  cache.cacheMap.get('sig').at -= 11 * 60 * 1000
  assert.equal(cache.cacheIsExist('sig'), false, 'caducada')
  assert.equal(cache.cacheMap.has('sig'), false, 'y además desalojada')
  assert.equal(cache.getCache('sig').status, 404)
})

test('el caché está acotado y desaloja lo más viejo primero', () => {
  const cache = new CacheManager()
  for (let i = 0; i < 600; i++) cache.addCache(`sig-${i}`, `https://oss.invalid/${i}.png`)
  assert.equal(cache.cacheMap.size, 512, 'acotado')
  assert.equal(cache.cacheIsExist('sig-0'), false, 'la más vieja se fue')
  assert.equal(cache.cacheIsExist('sig-599'), true, 'la más nueva sigue')
})

test('una entrada caducada deja sitio a una subida nueva', () => {
  const cache = new CacheManager()
  cache.addCache('sig', 'https://oss.invalid/old.png')
  cache.cacheMap.get('sig').at -= 11 * 60 * 1000
  assert.equal(cache.addCache('sig', 'https://oss.invalid/new.png'), true)
  assert.equal(cache.getCache('sig').url, 'https://oss.invalid/new.png')
})
