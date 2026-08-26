const test = require('node:test')
const assert = require('node:assert/strict')

const { resolveChatMode, buildFeChatMessage } = require('../src/utils/chat-helpers.js')
const config = require('../src/config/index.js')
const { processRequestBody } = require('../src/middlewares/chat-middleware.js')

const withFlag = (value, fn) => {
  const original = config.enableTempChats
  config.enableTempChats = value
  try {
    fn()
  } finally {
    config.enableTempChats = original
  }
}

test('resolveChatMode: explicit normal beats the global temp-chats flag', () => {
  withFlag(true, () => {
    assert.equal(resolveChatMode('normal'), 'normal')
  })
})

test('resolveChatMode: local requested wins regardless of flag', () => {
  withFlag(false, () => {
    assert.equal(resolveChatMode('local'), 'local')
  })
  withFlag(true, () => {
    assert.equal(resolveChatMode('local'), 'local')
  })
})

test('resolveChatMode: unset follows ENABLE_TEMP_CHATS', () => {
  withFlag(true, () => {
    assert.equal(resolveChatMode(undefined), 'local')
    assert.equal(resolveChatMode(null), 'local')
    assert.equal(resolveChatMode(''), 'local')
  })
  withFlag(false, () => {
    assert.equal(resolveChatMode(undefined), 'normal')
    assert.equal(resolveChatMode('weird-value'), 'normal')
  })
})

const runMiddleware = async (body) => {
  const req = {
    body: { messages: [{ role: 'user', content: 'hi' }], model: 'qwen3.7-plus', stream: false, ...body }
  }
  const res = {
    status(code) {
      this.code = code
      return { json: (payload) => ({ code: this.code, payload }) }
    }
  }
  let nextCalled = false
  await processRequestBody(req, res, () => { nextCalled = true })
  return { nextCalled, chatMode: req.body.chat_mode }
}

test('middleware stamps chat_mode=local when flag enabled and client silent', async () => {
  withFlag(true, async () => {
    const { nextCalled, chatMode } = await runMiddleware({})
    assert.equal(nextCalled, true)
    assert.equal(chatMode, 'local')
  })
})

test('middleware honors explicit client chat_mode over the flag', async () => {
  withFlag(true, async () => {
    const optOut = await runMiddleware({ chat_mode: 'normal' })
    assert.equal(optOut.chatMode, 'normal')

    const optIn = await runMiddleware({ chat_mode: 'local' })
    assert.equal(optIn.chatMode, 'local')
  })
})

test('middleware defaults to normal when flag disabled', async () => {
  withFlag(false, async () => {
    const { chatMode } = await runMiddleware({})
    assert.equal(chatMode, 'normal')
  })
})

test('buildFeChatMessage emits the full FE 0.2.81 shape (WAF fingerprint)', () => {
  const message = buildFeChatMessage({
    role: 'assistant',
    content: 'hello',
    chatType: 't2t',
    thinkingEnabled: true,
    modelId: 'qwen3.7-plus'
  })
  for (const key of ['id', 'fid', 'parentId', 'parent_id', 'childrenIds', 'role', 'content',
    'user_action', 'files', 'timestamp', 'models', 'model', 'chat_type',
    'feature_config', 'extra', 'sub_chat_type']) {
    assert.ok(key in message, `missing FE field: ${key}`)
  }
  assert.equal(message.user_action, 'chat')
  assert.deepEqual(message.models, ['qwen3.7-plus'])
  assert.equal(message.feature_config.output_schema, 'phase')
  assert.equal(message.feature_config.thinking_enabled, true)
  assert.equal(message.extra.meta.subChatType, 't2t')
})
