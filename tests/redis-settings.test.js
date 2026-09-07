// setSettings merge in src/utils/redis.js against a fake ioredis. Env goes in BEFORE src/config
// is required (dotenv never overrides a set variable) and the fake into require.cache BEFORE
// redis.js is required. Relies on node:test per-file process isolation.
process.env.DATA_SAVE_MODE = 'redis'
process.env.REDIS_URL = 'redis://127.0.0.1:6379'

const { describe, it, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

// ensureConnection touches: new Redis(url, cfg), on/once/off, status, connect(), ping() -> 'PONG', disconnect()
const store = new Map()
const hsetCalls = []
let hgetError = null
class FakeRedis extends EventEmitter {
  constructor() { super(); this.status = 'wait' }
  async connect() { this.status = 'ready'; this.emit('ready') }
  async ping() { return 'PONG' }
  async hget(key, field) {
    if (hgetError) { const error = hgetError; hgetError = null; throw error }
    const hash = store.get(key)
    return hash && field in hash ? hash[field] : null
  }
  async hgetall(key) { return { ...(store.get(key) || {}) } }
  async hset(key, fields) {
    hsetCalls.push([key, { ...fields }])
    store.set(key, { ...(store.get(key) || {}), ...fields })
    return 1
  }
  async quit() { this.disconnect(); return 'OK' }
  disconnect() { this.status = 'end'; this.emit('end') }
}
const ioredisPath = require.resolve('ioredis')
const ioredisStub = new Module(ioredisPath)
ioredisStub.filename = ioredisPath
ioredisStub.loaded = true
ioredisStub.exports = FakeRedis
require.cache[ioredisPath] = ioredisStub

const config = require('../src/config/index.js')
const redisClient = require('../src/utils/redis.js')
const KEY = 'qwen2api:settings'
const stored = () => JSON.parse(store.get(KEY).json)

describe('redis setSettings merges over the stored settings', () => {
  beforeEach(() => { store.clear(); hsetCalls.length = 0; hgetError = null })
  after(async () => { await redisClient.cleanup() })

  it('the fake is wired', () => {
    assert.equal(config.dataSaveMode, 'redis')
    assert.equal(config.redisURL, 'redis://127.0.0.1:6379')
  })

  it('keeps apiKeys and chatRetryCount when the map is saved, and the map when they are saved', async () => {
    store.set(KEY, { json: JSON.stringify({ apiKeys: ['a', 'b'], chatRetryCount: 3 }) })
    assert.equal(await redisClient.setSettings({ modelMap: 'x=qwen3-max' }), true)
    assert.deepEqual(stored(), { apiKeys: ['a', 'b'], chatRetryCount: 3, modelMap: 'x=qwen3-max' })
    assert.deepEqual(await redisClient.getSettings(), { apiKeys: ['a', 'b'], chatRetryCount: 3, modelMap: 'x=qwen3-max' })
    assert.equal(await redisClient.setSettings({ chatRetryCount: 5 }), true)
    assert.deepEqual(stored(), { apiKeys: ['a', 'b'], chatRetryCount: 5, modelMap: 'x=qwen3-max' })
    // null is a stored value (reset to env), not a deletion
    assert.equal(await redisClient.setSettings({ modelMap: null }), true)
    assert.deepEqual(stored(), { apiKeys: ['a', 'b'], chatRetryCount: 5, modelMap: null })
    assert.equal(hsetCalls.length, 3)
    assert.equal(hsetCalls[0][0], KEY)
  })

  it('missing or corrupt json: the partial is written alone', async () => {
    assert.equal(await redisClient.setSettings({ modelMap: 'x=qwen3-max' }), true)
    assert.deepEqual(stored(), { modelMap: 'x=qwen3-max' })
    for (const bad of ['{nope', 'null', '[1,2]', '"str"', '']) {
      store.set(KEY, { json: bad })
      assert.deepEqual(await redisClient.getSettings(), {}, `getSettings on ${JSON.stringify(bad)}`)
      assert.equal(await redisClient.setSettings({ chatRetryCount: 1 }), true)
      assert.deepEqual(stored(), { chatRetryCount: 1 }, `setSettings on ${JSON.stringify(bad)}`)
    }
  })

  it('a failing read returns false and never writes', async () => {
    store.set(KEY, { json: JSON.stringify({ chatRetryCount: 9 }) })
    hgetError = new Error('boom')
    assert.equal(await redisClient.setSettings({ modelMap: 'lost=qwen3-max' }), false)
    assert.deepEqual(hsetCalls, [])
    assert.deepEqual(stored(), { chatRetryCount: 9 })
    hgetError = new Error('boom')
    assert.deepEqual(await redisClient.getSettings(), {})
  })
})
