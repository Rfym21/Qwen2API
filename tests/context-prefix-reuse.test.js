// Reutilizacion del prefijo de historial entre turnos (src/utils/context-prefix-cache.js +
// src/utils/request.js#externalizeOversizedAgentContext). Sin red: uploader y cache inyectados.
//
// Medido en vivo el 2026-09-10 (tools/dev-probes/probe-prefix-file-reuse.js, qwen-next):
// un file_id parseado se lee desde chats NUEVOS y desde OTRAS cuentas (3/3 cuentas), un
// file_id inexistente NO da error (el modelo contesta sin el adjunto) y un descriptor sin
// url falla en seco ("Internal error!"). De ahi: sin pinning de cuenta, TTL absoluto y el
// descriptor real siempre entero.
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const config = require('../src/config/index.js')
const {
  externalizeOversizedAgentContext,
  buildAgentContextLivePrompt
} = require('../src/utils/request.js')
const {
  hashText,
  buildContextPrefixKey,
  createContextPrefixCache,
  prefixMatches
} = require('../src/utils/context-prefix-cache.js')
const { buildChatFileDescriptor } = require('../src/utils/upload.js')
const { ContextExternalizationError } = require('../src/utils/upstream-error.js')

test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* no cargado */ }
})

const HISTORY_MARKER = '# Conversation history (JSONL)'
const CURRENT_MARKER = '# Current message'
const LEDGER = '# Already executed this task\n' +
  'These calls already ran and their results are above. Reuse a result instead of repeating its call, unless a later action could have changed it.\n' +
  '#1 Read(path=src/a.js) -> 12 lines'
const SYSTEM = `# System\nYou are a coding agent.\n${'rule '.repeat(400).trim()}`
const COMPACTED = 'complete copy is in the attachment'
// 20 lineas de ~440 B + system ~2 KB desbordan; el diseño horneado (cola vacia) cabe con
// margen; una cola de 2 lineas cabe; una de 10 (4,4 KB) ya no.
const THRESHOLD = 8192

const line = (i) => JSON.stringify({ role: i % 2 ? 'user' : 'assistant', content: `message ${i} ${'x'.repeat(400)}` })
const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => line(from + i))
const envelopeText = (historyLines, current = 'continue the task') => [
  SYSTEM,
  LEDGER,
  `${HISTORY_MARKER}\n${historyLines.join('\n')}`,
  `${CURRENT_MARKER}\n${JSON.stringify({ role: 'user', content: current })}`
].join('\n\n')
const payloadFor = (text) => ({
  model: 'qwen3-max',
  messages: [
    { role: 'user', content: text, files: [], chat_type: 't2t' },
    { role: 'assistant', content: '' }
  ]
})
const inlineOf = (result) => result.payload.messages[0].content
const fileIdsOf = (result) => result.payload.messages[0].files.map(file => file.id)

const makeUploader = ({ fail = null, defer = false } = {}) => {
  const calls = []
  const pending = []
  const uploader = (text, token, account, options = {}) => {
    calls.push({ text, token, email: account?.email, options })
    if (fail) return Promise.reject(fail)
    const n = calls.length
    const file = buildChatFileDescriptor({
      fileId: `file-${n}`,
      fileUrl: `https://oss.example/${n}/file-${n}.txt`,
      filename: options.filename || 'FULL.txt',
      size: Buffer.byteLength(text)
    })
    if (!defer) return Promise.resolve(file)
    return new Promise(resolve => pending.push(() => resolve(file)))
  }
  return { uploader, calls, pending }
}

let now = 1_000_000
const newCache = () => createContextPrefixCache({ ttlMs: 60_000, maxEntries: 10, now: () => now })

const run = (text, { uploader, cache, key = 'k', account = { email: 'a@x' }, allow = false, threshold = THRESHOLD }) =>
  externalizeOversizedAgentContext(payloadFor(text), 'tok', account, {
    uploader,
    cache,
    contextPrefixKey: key,
    thresholdBytes: threshold,
    allowContextCompaction: allow
  })

const tick = () => new Promise(resolve => setImmediate(resolve))

// ---------------------------------------------------------------- horneado / reutilizacion

test('bake: the file holds exactly the history block; inline keeps system, ledger, notice and current; nothing compacted', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  const result = await run(envelopeText(history), { uploader, cache })

  assert.equal(result.externalized, true)
  assert.equal(result.bakedPrefix, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, history.join('\n'))
  assert.equal(calls[0].token, 'tok')
  assert.match(calls[0].options.filename, /^QWEN2API_AGENT_HISTORY_\d+\.txt$/)

  const name = calls[0].options.filename
  const inline = inlineOf(result)
  assert.ok(inline.startsWith('# Agent context attachment'))
  assert.ok(inline.includes(SYSTEM))
  assert.ok(inline.includes(LEDGER))
  assert.ok(inline.includes(
    `${HISTORY_MARKER}\n[earlier history: the first 20 JSONL messages are in the attachment ${name}; the JSONL below continues from message 21]`
  ))
  assert.ok(inline.endsWith(`${CURRENT_MARKER}\n${JSON.stringify({ role: 'user', content: 'continue the task' })}`))
  assert.equal(inline.includes(history[0]), false)
  assert.equal(inline.includes(COMPACTED), false)
  assert.deepEqual(fileIdsOf(result), ['file-1'])
  assert.equal(result.payload.messages[1].content, '')

  const entry = cache.get('k')
  assert.equal(entry.prefixLines, 20)
  assert.equal(entry.prefixChars, history.join('\n').length)
  assert.equal(entry.prefixHash, hashText(history.join('\n')))
  assert.equal(entry.accountEmail, 'a@x')
})

test('hit: the next turn (history + 2 lines) reuses the descriptor with zero uploads; only the new lines go inline', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache })

  const extra = lines(2, 21)
  const result = await run(envelopeText([...history, ...extra]), { uploader, cache })
  assert.equal(calls.length, 1)
  assert.equal(result.reusedPrefix, true)
  assert.equal(result.bakedPrefix, undefined)
  const inline = inlineOf(result)
  assert.ok(inline.includes(`continues from message 21]\n${extra.join('\n')}\n\n${CURRENT_MARKER}`))
  assert.equal(inline.includes(history[19]), false)
  assert.equal(inline.includes(COMPACTED), false)
  assert.deepEqual(fileIdsOf(result), ['file-1'])
})

test('prefix mismatch: an earlier line rendered differently is a new bake and the entry is replaced', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache })

  const edited = [...history]
  edited[2] = JSON.stringify({ role: 'user', content: 'message 3 rendered differently' })
  const result = await run(envelopeText([...edited, ...lines(1, 21)]), { uploader, cache })
  assert.equal(calls.length, 2)
  assert.equal(result.bakedPrefix, true)
  assert.equal(cache.get('k').file.id, 'file-2')
  assert.equal(cache.get('k').prefixLines, 21)
})

test('any account serves the next turn: a different account reuses the same file (measured 3/3 cross-account)', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache, account: { email: 'a@x' } })

  const result = await run(envelopeText([...history, ...lines(1, 21)]), { uploader, cache, account: { email: 'b@x' } })
  assert.equal(calls.length, 1)
  assert.equal(result.reusedPrefix, true)
  assert.deepEqual(fileIdsOf(result), ['file-1'])
})

test('tail too big: re-bake with the whole current history; the following +1 line reuses the new file', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache })

  const grown = [...history, ...lines(10, 21)]
  const rebaked = await run(envelopeText(grown), { uploader, cache })
  assert.equal(calls.length, 2)
  assert.equal(rebaked.bakedPrefix, true)
  assert.equal(calls[1].text, grown.join('\n'))
  assert.equal(cache.get('k').prefixLines, 30)

  const next = lines(1, 31)
  const reused = await run(envelopeText([...grown, ...next]), { uploader, cache })
  assert.equal(calls.length, 2)
  assert.equal(reused.reusedPrefix, true)
  assert.ok(inlineOf(reused).includes(`continues from message 31]\n${next[0]}`))
  assert.deepEqual(fileIdsOf(reused), ['file-2'])
})

test('B2 fallback: when even the baked layout does not fit, the whole envelope is uploaded as today and the cache is untouched', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache })

  const text = envelopeText([...history, ...lines(1, 21)], 'c'.repeat(9000))
  const result = await run(text, { uploader, cache })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].text, text)
  assert.equal(calls[1].options.filename, undefined)
  assert.equal(result.externalized, true)
  assert.equal(result.bakedPrefix, undefined)
  assert.equal(result.reusedPrefix, undefined)
  assert.equal(inlineOf(result), buildAgentContextLivePrompt(text, undefined, 'FULL.txt'))
  assert.deepEqual(fileIdsOf(result), ['file-2'])
  assert.equal(cache.get('k').file.id, 'file-1')
})

test('bake failure: 529 with tools, compaction without; the cache keeps the previous entry and the next bake is not blocked', async () => {
  const good = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader: good.uploader, cache })

  const grown = [...history, ...lines(10, 21)]
  const bad = makeUploader({ fail: new Error('Qwen 文档解析服务失败: WAF_CAPTCHA') })
  await assert.rejects(run(envelopeText(grown), { uploader: bad.uploader, cache }), ContextExternalizationError)
  assert.equal(bad.calls.length, 1)
  assert.equal(cache.get('k').file.id, 'file-1')

  const compacted = await run(envelopeText(grown), { uploader: bad.uploader, cache, allow: true })
  assert.equal(compacted.externalized, false)
  assert.equal(compacted.compacted, true)
  assert.equal(cache.get('k').file.id, 'file-1')

  // El horneado fallido no deja un vuelo colgado: el siguiente sube de verdad.
  const retried = await run(envelopeText(grown), { uploader: good.uploader, cache })
  assert.equal(retried.bakedPrefix, true)
  assert.equal(good.calls.length, 2)
})

test('TTL is absolute: past it the entry is gone and the next turn bakes again', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const history = lines(20)
  await run(envelopeText(history), { uploader, cache })
  now += 30_000
  await run(envelopeText([...history, ...lines(1, 21)]), { uploader, cache })
  assert.equal(calls.length, 1)
  now += 31_000
  const result = await run(envelopeText([...history, ...lines(2, 21)]), { uploader, cache })
  assert.equal(calls.length, 2)
  assert.equal(result.bakedPrefix, true)
})

test('single-flight: a concurrent request for the same key waits for the bake and then reuses it', async () => {
  const { uploader, calls, pending } = makeUploader({ defer: true })
  const cache = newCache()
  const history = lines(20)
  const first = run(envelopeText(history), { uploader, cache })
  await tick()
  const second = run(envelopeText([...history, ...lines(1, 21)]), { uploader, cache })
  await tick()
  assert.equal(calls.length, 1)
  pending.splice(0).forEach(resolve => resolve())
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.bakedPrefix, true)
  assert.equal(r2.reusedPrefix, true)
  assert.equal(calls.length, 1)
})

test('without a session key, or with the kill switch off, the path is B2 (whole envelope uploaded) and the cache is never used', async () => {
  const { uploader, calls } = makeUploader()
  const cache = newCache()
  const text = envelopeText(lines(20))

  const noKey = await run(text, { uploader, cache, key: null })
  assert.equal(calls[0].text, text)
  assert.equal(noKey.bakedPrefix, undefined)
  assert.equal(cache.size, 0)

  const previous = config.agentContextPrefixReuse
  config.agentContextPrefixReuse = false
  try {
    const off = await run(text, { uploader, cache })
    assert.equal(calls[1].text, text)
    assert.equal(off.bakedPrefix, undefined)
    assert.equal(cache.size, 0)
  } finally {
    config.agentContextPrefixReuse = previous
  }
})

// ---------------------------------------------------------------- unidades del modulo

test('prefixMatches: same hash on a line boundary only', () => {
  const prefix = lines(3).join('\n')
  const entry = { prefixHash: hashText(prefix), prefixChars: prefix.length }
  assert.equal(prefixMatches(prefix, entry), true)
  assert.equal(prefixMatches(`${prefix}\n${line(4)}`, entry), true)
  assert.equal(prefixMatches(`${prefix}${line(4)}`, entry), false)
  assert.equal(prefixMatches(prefix.slice(0, -1), entry), false)
  assert.equal(prefixMatches(`${prefix.slice(0, -1)}y\n${line(4)}`, entry), false)
  assert.equal(prefixMatches('', entry), false)
  assert.equal(prefixMatches(prefix, null), false)
})

test('buildContextPrefixKey: null without a user id; stable for the same session; different per session/model/system/tools/opener', () => {
  const base = { userId: 'session-1', model: 'qwen3-max', system: 'rules', tools: [{ name: 'Read' }], firstMessage: { role: 'user', content: 'hi' } }
  assert.equal(buildContextPrefixKey({ ...base, userId: undefined }), null)
  assert.equal(buildContextPrefixKey({ ...base, userId: '' }), null)
  const key = buildContextPrefixKey(base)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(buildContextPrefixKey({ ...base }), key)
  for (const change of [
    { userId: 'session-2' },
    { model: 'qwen3-coder' },
    { system: 'other rules' },
    { tools: [{ name: 'Write' }] },
    { firstMessage: { role: 'user', content: 'hello' } }
  ]) {
    assert.notEqual(buildContextPrefixKey({ ...base, ...change }), key, JSON.stringify(change))
  }
})

test('createContextPrefixCache: LRU eviction at maxEntries, delete, clear', () => {
  const cache = createContextPrefixCache({ ttlMs: 0, maxEntries: 2, now: () => now })
  cache.set('a', { file: 'A' })
  cache.set('b', { file: 'B' })
  assert.equal(cache.get('a').file, 'A')
  cache.set('c', { file: 'C' })
  assert.equal(cache.size, 2)
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a').file, 'A')
  assert.equal(cache.delete('a'), true)
  cache.clear()
  assert.equal(cache.size, 0)
})
