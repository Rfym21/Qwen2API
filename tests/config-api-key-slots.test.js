// An unexpanded API_KEY must stop the boot, not silently demote the admin key.
//
// `docker-compose.next.yml` carries `API_KEY=${QWEN2API_ADMIN_KEY_V2},${QWEN2API_API_KEY}`.
// Deployed without the admin variable in scope it expands to `,sk-client…`; the old parser
// filtered the empty slot away and promoted the CLIENT key to admin, so the dashboard
// answered "invalid API key" to the real admin key. That is how qwen-next lost its
// dashboard on 2026-09-16 — a config bug that only surfaced as an auth failure.
process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseApiKeys } = require('../src/config/index.js')

test('an empty slot is refused: an unexpanded variable never boots', () => {
  // The exact shape the broken deploy produced.
  assert.throws(() => parseApiKeys(',sk-client'), /API_KEY/)
  // Trailing and middle slots too, and whitespace-only counts as empty.
  assert.throws(() => parseApiKeys('sk-admin,'), /API_KEY/)
  assert.throws(() => parseApiKeys('sk-admin,,sk-client'), /API_KEY/)
  assert.throws(() => parseApiKeys('sk-admin,   ,sk-client'), /API_KEY/)
})

test('the error names how many slots are empty and where, so the fix is obvious', () => {
  assert.throws(() => parseApiKeys(',sk-client'), (error) => {
    assert.match(error.message, /第 1 位/)
    assert.match(error.message, /共 2 位/)
    return true
  })
  assert.throws(() => parseApiKeys(',sk-client,'), (error) => {
    assert.match(error.message, /第 1、3 位/)
    return true
  })
})

test('an unset API_KEY still yields an empty config, not a throw', () => {
  // Boot without any key is a separate, already-handled case (the server logs and refuses
  // requests); only a PARTIALLY expanded value is the deploy bug this guards.
  // `undefined` is not testable here: it falls through to the parameter default, which
  // reads the real process.env.API_KEY this file has to set to import the module at all.
  for (const value of ['', null]) {
    assert.deepEqual(parseApiKeys(value), { apiKeys: [], adminKey: null })
  }
})

test('well-formed values keep parsing exactly as before: slot 1 is the admin key', () => {
  assert.deepEqual(parseApiKeys('sk-admin,sk-client'), {
    apiKeys: ['sk-admin', 'sk-client'],
    adminKey: 'sk-admin'
  })
  // Surrounding whitespace is trimmed, as it always was.
  assert.deepEqual(parseApiKeys(' sk-admin , sk-client '), {
    apiKeys: ['sk-admin', 'sk-client'],
    adminKey: 'sk-admin'
  })
  // A single key is both the only key and the admin key.
  assert.deepEqual(parseApiKeys('sk-only'), { apiKeys: ['sk-only'], adminKey: 'sk-only' })
})
