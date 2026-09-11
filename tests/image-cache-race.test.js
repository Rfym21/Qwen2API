const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')

const uploadModule = require('../src/utils/upload.js')
const { parserMessages, imgCacheManager } = require('../src/utils/chat-helpers.js')

// Since the cache learned to expire entries, `cacheIsExist` in file mode UNLINKS the file
// it just found dead (img-caches.js), and in default mode it deletes the map entry. Before
// that, nothing in src/ ever removed a cache entry, so "exists" and "read it" could not
// disagree. The upload path asked both questions separately —
//     if (cacheIsExist(sig)) return item(getCache(sig).url)
// — and shipped whatever `.url` came back. When the entry died between the two calls (a
// second PM2 worker in CACHE_MODE=file, the README's Docker recommendation, or simply the
// TTL crossing in between), that is `{status: 404, url: null}` and the upstream body became
// {"type":"image","image":null}: an image the model never sees, with no error anywhere.
const DATA_URI = 'data:image/png;base64,QUJD'
const imageMessages = () => ([{ role: 'user', content: [{ type: 'image_url', image_url: { url: DATA_URI } }] }])

const realUpload = uploadModule.uploadFileToQwenOss
const realGetCache = imgCacheManager.getCache
const realExists = imgCacheManager.cacheIsExist
after(() => {
  uploadModule.uploadFileToQwenOss = realUpload
  imgCacheManager.getCache = realGetCache
  imgCacheManager.cacheIsExist = realExists
})

let uploads = 0
beforeEach(() => {
  imgCacheManager.clear()
  uploads = 0
  imgCacheManager.getCache = realGetCache
  imgCacheManager.cacheIsExist = realExists
  uploadModule.uploadFileToQwenOss = async () => {
    uploads += 1
    return { status: 200, file_url: `https://oss.invalid/fresh-${uploads}.png`, file_id: `f${uploads}` }
  }
})

const urlsIn = (parsed) => JSON.stringify(parsed).match(/https:\/\/oss\.invalid\/[^"]+/g) || []

for (const [label, miss] of [
  ['vanished between the two checks (404)', { status: 404, url: null }],
  ['unreadable (500)', { status: 500, url: null }],
  ['present but empty', { status: 200, url: '' }]
]) {
  test(`una entrada ${label} se re-sube, nunca se entrega image:null`, async () => {
    // El estado imposible que el borrado perezoso hizo posible: "existe" dice que si,
    // la lectura dice que no.
    imgCacheManager.cacheIsExist = () => true
    imgCacheManager.getCache = () => miss

    const parsed = await parserMessages(imageMessages(), {}, 't2t')
    const serialized = JSON.stringify(parsed)
    assert.equal(uploads, 1, 'un fallo de lectura del cache tiene que volver a subir')
    assert.ok(!/"image"\s*:\s*null/.test(serialized), `se entrego una imagen nula: ${serialized}`)
    assert.ok(!/"url"\s*:\s*null/.test(serialized), `se entrego una URL nula: ${serialized}`)
    assert.deepEqual(urlsIn(parsed), ['https://oss.invalid/fresh-1.png'])
  })
}

test('un acierto de verdad sigue reusando la URL, sin volver a subir', async () => {
  await parserMessages(imageMessages(), {}, 't2t')
  const second = await parserMessages(imageMessages(), {}, 't2t')
  assert.equal(uploads, 1, 'la segunda peticion del mismo turno reusa el cache')
  assert.deepEqual(urlsIn(second), ['https://oss.invalid/fresh-1.png'])
})
