// GET /settings and POST /setModelMap handlers, offline. The models-map.js stub goes into
// require.cache BEFORE anything else (settings.js destructures getLatestModels at its first
// require) and env is set before src/config is required. This file pulls in data-persistence
// and the redis client: run it through `npm test` (--test-force-exit), never standalone.
process.env.MODEL_MAP = 'env-alias=qwen3-max'
process.env.DATA_SAVE_MODE = 'none'
process.env.API_KEY = 'test-admin'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const T2T = (id, meta = {}) => ({ id, info: { meta: { chat_type: ['t2t', 'search'], ...meta } } })
const UPSTREAM = [
  { id: 'qwen-image', info: { meta: { chat_type: ['t2i'], abilities: { thinking: true } } } },
  T2T('qwen3.8-max', { abilities: { thinking: true } }),
  T2T('qwen3-max')
]
let upstream = () => UPSTREAM
const fetchCalls = []
const modelsMapPath = require.resolve('../src/models/models-map.js')
const modelsMapStub = new Module(modelsMapPath)
modelsMapStub.filename = modelsMapPath
modelsMapStub.loaded = true
modelsMapStub.exports = { getLatestModels: async (force = false) => { fetchCalls.push(force); return upstream(force) } }
require.cache[modelsMapPath] = modelsMapStub

const config = require('../src/config/index.js')
const DataPersistence = require('../src/utils/data-persistence')
const saved = []
let persistResult = true
DataPersistence.prototype.saveSettings = async function (partial) { saved.push(partial); return persistResult }

const router = require('../src/routes/settings.js')
const { recordUnmapped, getUnmappedModels, resetModelMapState } = require('../src/utils/model-map.js')

// last layer of the route stack = the handler (adminKeyVerify sits before it)
const handlerFor = (path, method) => {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method])
  assert.ok(layer, `route ${method.toUpperCase()} ${path} is mounted`)
  return layer.route.stack[layer.route.stack.length - 1].handle
}
const getSettings = handlerFor('/settings', 'get')
const setModelMap = handlerFor('/setModelMap', 'post')

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this },
  json(payload) { this.body = payload; return this }
})
const run = async (handler, body) => {
  const res = createRes()
  await handler({ body, headers: {} }, res)
  return res
}

describe('settings route: model map', () => {
  beforeEach(() => {
    config.modelMap = process.env.MODEL_MAP
    saved.length = 0
    fetchCalls.length = 0
    persistResult = true
    upstream = () => UPSTREAM
    resetModelMapState()
  })

  it('GET carries the map, its env seed, chat-capable targets, unmapped names and the save mode', async () => {
    recordUnmapped('gpt-4o')
    const res = await run(getSettings, undefined)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.modelMap, 'env-alias=qwen3-max')
    assert.equal(res.body.modelMapEnv, 'env-alias=qwen3-max')
    assert.deepEqual(res.body.unmappedModels, ['gpt-4o'])
    // t2t only, -thinking added where the ability is set, the t2i model excluded even with thinking
    assert.deepEqual(res.body.modelMapTargets, ['qwen3.8-max', 'qwen3.8-max-thinking', 'qwen3-max'])
    assert.equal(res.body.dataSaveMode, 'none')
    assert.equal(res.body.chatRetryCount, config.chatRetryCount, 'existing fields are still there')
  })

  it('GET survives an upstream list failure with no targets', async () => {
    upstream = () => { throw new Error('boom') }
    const res = await run(getSettings, undefined)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.modelMapTargets, [])
  })

  it('POST without an entries array is 400 and changes nothing', async () => {
    for (const body of [{}, [], undefined, { entries: 'a=b' }, { entries: null }]) {
      const res = await run(setModelMap, body)
      assert.equal(res.statusCode, 400, JSON.stringify(body))
      assert.equal(res.body.error, '无效的模型映射')
      assert.equal(res.body.errors[0].field, 'entries')
    }
    assert.equal(config.modelMap, 'env-alias=qwen3-max')
    assert.deepEqual(saved, [])
    assert.deepEqual(fetchCalls, [], 'no upstream fetch for a malformed body')
  })

  it('POST with an unknown target is 400 with the offending row after one forced refresh; nothing changes', async () => {
    const res = await run(setModelMap, { entries: [{ alias: 'claude-a', target: 'qwen3.8-max' }, { alias: 'claude-b', target: 'nope' }], fallback: '' })
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.errors.length, 1)
    assert.equal(res.body.errors[0].index, 1)
    assert.equal(res.body.errors[0].field, 'target')
    assert.deepEqual(fetchCalls, [false, true], 'a stale cache is refreshed once before answering 400')
    assert.equal(config.modelMap, 'env-alias=qwen3-max')
    assert.deepEqual(saved, [])
  })

  it('POST with a target that only the refreshed list knows succeeds', async () => {
    upstream = (force) => force ? [...UPSTREAM, T2T('qwen-new')] : UPSTREAM
    const res = await run(setModelMap, { entries: [{ alias: 'claude-a', target: 'qwen-new' }], fallback: '' })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.modelMap, 'claude-a=qwen-new')
    assert.deepEqual(fetchCalls, [false, true])
  })

  it('POST with valid rows sets config, persists { modelMap } and echoes persisted + dataSaveMode', async () => {
    const res = await run(setModelMap, {
      entries: [{ alias: 'Claude-Opus-5 [1m]', target: 'qwen3.8-max' }, { alias: 'gpt-4o', target: 'qwen3.8-max-thinking' }],
      fallback: 'qwen3-max'
    })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const raw = 'claude-opus-5=qwen3.8-max,gpt-4o=qwen3.8-max-thinking,*=qwen3-max'
    assert.deepEqual(res.body, { status: true, message: '模型映射更新成功', persisted: true, modelMap: raw, dataSaveMode: 'none' })
    assert.equal(config.modelMap, raw)
    assert.deepEqual(saved, [{ modelMap: raw }])
    assert.deepEqual(fetchCalls, [false], 'a valid map needs no forced refresh')

    persistResult = false
    const again = await run(setModelMap, { entries: [], fallback: 'qwen3-max' })
    assert.equal(again.statusCode, 200)
    assert.equal(again.body.persisted, false)
    assert.equal(again.body.dataSaveMode, 'none')
    assert.equal(config.modelMap, '*=qwen3-max')
  })

  it('POST { reset: true } goes back to the env map and persists modelMap: null', async () => {
    config.modelMap = 'saved=qwen3.8-max'
    const res = await run(setModelMap, { reset: true })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { status: true, reset: true, message: '模型映射已恢复为 env', persisted: true, modelMap: 'env-alias=qwen3-max', dataSaveMode: 'none' })
    assert.equal(config.modelMap, 'env-alias=qwen3-max')
    assert.deepEqual(saved, [{ modelMap: null }])
    assert.deepEqual(fetchCalls, [])
    // only the literal true resets; anything else is a normal (and here malformed) save
    assert.equal((await run(setModelMap, { reset: 'yes' })).statusCode, 400)
  })

  it('saved aliases disappear from the unmapped record', async () => {
    recordUnmapped('Claude-Opus-5')
    recordUnmapped('gpt-4o')
    const res = await run(setModelMap, { entries: [{ alias: 'claude-opus-5', target: 'qwen3.8-max' }], fallback: '' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(getUnmappedModels(), ['gpt-4o'])
    assert.deepEqual((await run(getSettings, undefined)).body.unmappedModels, ['gpt-4o'])
  })
})
