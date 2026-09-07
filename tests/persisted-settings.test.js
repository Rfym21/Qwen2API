// Pure tests for src/utils/persisted-settings.js: the loadSettings() result applied onto config.
const test = require('node:test')
const assert = require('node:assert/strict')
const { logger } = require('../src/utils/logger')
const { applyPersistedSettings } = require('../src/utils/persisted-settings')

const ENV_MAP = 'env-alias=qwen3-max'
const baseConfig = () => ({
  chatRetryCount: 1,
  chatRetryBackoffMs: 400,
  apiKeys: ['admin'],
  adminKey: 'admin',
  modelMap: ENV_MAP
})

const withInfoLog = (fn) => {
  const lines = []
  const original = logger.info
  logger.info = (message) => { lines.push(String(message)) }
  try { return fn(lines) } finally { logger.info = original }
}

test('modelMap: "" clears the env map; {} and null keep it; a string overrides it with one info line', () => {
  withInfoLog((lines) => {
    const cleared = applyPersistedSettings(baseConfig(), { modelMap: '' })
    assert.equal(cleared.modelMap, '', 'an empty string is a saved value: the map is cleared')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /MODEL_MAP env overridden by dashboard-saved map: ""/)
  })
  assert.equal(applyPersistedSettings(baseConfig(), {}).modelMap, ENV_MAP)
  assert.equal(applyPersistedSettings(baseConfig(), { modelMap: null }).modelMap, ENV_MAP, 'null = reset to env')
  assert.equal(applyPersistedSettings(baseConfig(), { modelMap: 42 }).modelMap, ENV_MAP, 'non-string is ignored')
  withInfoLog((lines) => {
    const applied = applyPersistedSettings(baseConfig(), { modelMap: 'a=qwen3-max' })
    assert.equal(applied.modelMap, 'a=qwen3-max')
    assert.deepEqual(lines, ['MODEL_MAP env overridden by dashboard-saved map: "a=qwen3-max"'])
  })
  withInfoLog((lines) => {
    // same value as env: applied silently
    assert.equal(applyPersistedSettings(baseConfig(), { modelMap: ENV_MAP }).modelMap, ENV_MAP)
    assert.equal(lines.length, 0)
    // the logged value is bounded
    applyPersistedSettings(baseConfig(), { modelMap: 'x'.repeat(500) })
    assert.ok(lines[0].length < 260)
  })
})

test('chatRetryCount / chatRetryBackoffMs / apiKeys behave as before', () => {
  const config = applyPersistedSettings(baseConfig(), { chatRetryCount: '3', chatRetryBackoffMs: 900, apiKeys: ['root', 'user'] })
  assert.equal(config.chatRetryCount, 3)
  assert.equal(config.chatRetryBackoffMs, 900)
  assert.deepEqual(config.apiKeys, ['root', 'user'])
  assert.equal(config.adminKey, 'root')
  assert.equal(config.modelMap, ENV_MAP)

  const untouched = applyPersistedSettings(baseConfig(), { chatRetryCount: '', chatRetryBackoffMs: 'abc', apiKeys: ['only-one'] })
  assert.equal(untouched.chatRetryCount, 1)
  assert.equal(untouched.chatRetryBackoffMs, 400)
  assert.deepEqual(untouched.apiKeys, ['admin'], 'a single persisted key never replaces the env keys')
  assert.equal(applyPersistedSettings(baseConfig(), { chatRetryCount: -1 }).chatRetryCount, 1)
})

test('a non-object persisted value is treated as empty', () => {
  for (const persisted of [undefined, null, 'junk', 7]) {
    assert.deepEqual(applyPersistedSettings(baseConfig(), persisted), baseConfig())
  }
})
