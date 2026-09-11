const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = 'failover-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const AccountRotator = require('../src/utils/account-rotator')
const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime')
const { createAccountReplayBody } = require('../src/utils/agent-account-failover')
const { assertNoUpstreamFailure, isRateLimitError, isWafChallengeError } = require('../src/utils/upstream-error')
const { handleStreamResponse, handleNonStreamResponse } = require('../src/controllers/chat')

const accounts = ['first', 'second', 'third'].map(name => ({ email: `${name}@example.invalid`, token: `${name}-test-token` }))
const requestBody = { model: 'qwen-test', messages: [{ role: 'user', content: 'Complete the task.' }] }
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const answerFrame = content => frame({ choices: [{ delta: { phase: 'answer', content }, finish_reason: null }] })
const failureFrame = (code = 'quota_limit') => frame({ success: false, data: { code } })
const finishedStream = (content = '<agent_final>OK</agent_final>') => Readable.from([
  answerFrame(content),
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }),
  'data: [DONE]\n\n'
])
const options = overrides => ({
  has_tools: true, allowed_tool_names: ['get_time'], tool_choice: 'auto',
  currentAccount: accounts[0], requestBody, agent_turn_max_attempts: 3,
  ...overrides
})

test.before(async () => { await accountManager._initPromise })
test.beforeEach(() => {
  accountManager.accountTokens = [...accounts]
  accountManager.isInitialized = true
  accountManager.accountRotator = new AccountRotator()
  accountManager.accountRotator.setAccounts(accounts)
})
test.after(() => { accountManager.destroy() })

test('quota_limit is recognized without an English message; explicit WAF is not quota', () => {
  assert.throws(() => assertNoUpstreamFailure({ error: { code: 'quota_limit', num: 2 } }), error =>
    isRateLimitError(error) && error.details.waitHours === 2)
  assert.throws(() => assertNoUpstreamFailure({ success: false, data: { code: 'upstream_waf_challenge' } }), error =>
    isWafChallengeError(error) && !isRateLimitError(error))
})

test('exhausted or challenged pools never fall back to cooled accounts', () => {
  const rotator = accountManager.accountRotator
  rotator.recordQuotaExhausted(accounts[0].email)
  rotator.recordChallenge(accounts[1].email)
  for (let count = 0; count < rotator.maxFailures; count += 1) rotator.recordFailure(accounts[2].email, 'ECONNRESET')
  assert.equal(rotator.getNextAccount(), null)
  rotator.resetFailures(accounts[1].email)
  assert.equal(rotator.getAccountByEmail(accounts[1].email), null, 'refreshing a token must not clear WAF cooldown')
  rotator.challengeCooldownUntil.set(accounts[1].email, Date.now() - 1)
  assert.equal(rotator.getNextAccount().email, accounts[1].email)
  assert.equal(rotator.getNextAccount([accounts[1].email]), null)
})

test('mid-stream buffered quota failure closes the old stream and accepts a fresh account', async () => {
  let oldStreamClosed = false
  const originalStream = Readable.from((async function* () {
    try {
      yield answerFrame('Uncommitted draft that must not leak.')
      yield failureFrame()
      yield answerFrame('unreachable')
    } finally { oldStreamClosed = true }
  })())
  const result = await runOpenAIAgentTurn(originalStream, options({
    sendChatRequest: async (body, requestOptions) => {
      assert.equal(oldStreamClosed, true)
      assert.equal(requestOptions.currentAccount.email, accounts[1].email)
      assert.equal(requestOptions.chatId, null)
      assert.equal(requestOptions.parentId, null)
      return { status: true, response: finishedStream(), currentAccount: requestOptions.currentAccount }
    }
  }))
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 2)
  assert.equal(result.currentAccount.email, accounts[1].email)
  assert.equal(result.attempt.visibleText, 'OK')
  assert.ok(accountManager.accountRotator.quotaCooldownUntil.has(accounts[0].email))
})

test('failover replays full text rather than old account context attachments and IDs', async () => {
  const originalBody = {
    ...requestBody, chat_id: 'old-chat', parentId: 'old-parent',
    messages: [{ role: 'user', content: 'Full history and tools', parent_id: 'old-parent' }]
  }
  const submittedBody = { messages: [{ role: 'user', content: 'Shortened prompt', files: [{ id: 'old-file' }] }] }
  const result = await runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
    requestBody: originalBody, upstream_request_body: submittedBody,
    upstream_context: { chatId: 'old-chat', responseId: 'old-response' },
    upstreamOptions: { contextPrefixKey: 'old-prefix', allowContextCompaction: true },
    sendChatRequest: async (body, requestOptions) => {
      assert.deepEqual(body, { model: 'qwen-test', messages: [{ role: 'user', content: 'Full history and tools' }] })
      assert.equal(requestOptions.contextPrefixKey, null)
      assert.equal(requestOptions.allowContextCompaction, false)
      return { status: true, response: finishedStream(), currentAccount: requestOptions.currentAccount }
    }
  }))
  assert.equal(result.ok, true)
  assert.equal(originalBody.chat_id, 'old-chat', 'the caller request is not mutated')
})

test('user media prevents unsafe cross-account replay', async () => {
  const mediaBody = { ...requestBody, messages: [{ role: 'user', content: 'Look at this', files: [{ id: 'user-file' }] }] }
  assert.equal(createAccountReplayBody(mediaBody), null)
  await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
    requestBody: mediaBody, sendChatRequest: async () => assert.fail('must not replay uploaded media')
  })), isRateLimitError)
})

test('no account rotation after client-visible final text or reasoning', async () => {
  for (const channel of ['content', 'reasoning']) {
    accountManager.accountRotator.reset()
    let delivered = ''
    const initial = channel === 'content'
      ? answerFrame('<agent_final>Already delivered')
      : frame({ choices: [{ delta: { phase: 'think', content: 'Already thinking.' }, finish_reason: null }] })
    await assert.rejects(runOpenAIAgentTurn(Readable.from([initial, failureFrame()]), options({
      [`on_${channel}_delta`]: text => { delivered += text },
      sendChatRequest: async () => assert.fail('must not mix another generation into visible output')
    })), isRateLimitError)
    assert.ok(delivered.length > 0, `${channel} guard was actually exercised`)
  }
})

test('WAF can switch once but never fans out through the entire account pool', async () => {
  let retries = 0
  await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame('upstream_waf_challenge')]), options({
    agent_turn_max_attempts: 6,
    sendChatRequest: async (body, requestOptions) => {
      retries += 1
      return { status: true, response: Readable.from([failureFrame('upstream_waf_challenge')]), currentAccount: requestOptions.currentAccount }
    }
  })), error => isWafChallengeError(error) && error.failedAccountEmail === accounts[1].email)
  assert.equal(retries, 1)
  assert.equal(accountManager.accountRotator.challengeCooldownUntil.size, 2)
  assert.equal(accountManager.accountRotator.getNextAccount().email, accounts[2].email)
})

test('quota failover respects the total attempt budget and preserves the final quota error', async () => {
  let retries = 0
  await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
    agent_turn_max_attempts: 2,
    sendChatRequest: async (body, requestOptions) => {
      retries += 1
      return { status: true, response: Readable.from([failureFrame()]), currentAccount: requestOptions.currentAccount }
    }
  })), error => isRateLimitError(error) && error.failedAccountEmail === accounts[1].email)
  assert.equal(retries, 1)
})

test('no healthy replacement or disconnected client stops without new upstream requests', async () => {
  for (const disconnected of [false, true]) {
    accountManager.accountRotator.reset()
    if (!disconnected) accountManager.accountRotator.setAccounts([accounts[0]])
    else accountManager.accountRotator.setAccounts(accounts)
    await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
      isClientDisconnected: () => disconnected,
      sendChatRequest: async () => assert.fail('no retry is permitted')
    })), isRateLimitError)
  }
})

test('unrelated upstream errors are neither rotated nor marked as account exhaustion', async () => {
  await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame('Bad_Request')]), options({
    sendChatRequest: async () => assert.fail('business error must not rotate')
  })), error => error.code === 'Bad_Request')
  assert.equal(accountManager.accountRotator.getStats().available, accounts.length)
})

test('a protocol retry after failover stays bound to the replacement account and its context', async () => {
  let retries = 0
  const replacementBody = { messages: [{ role: 'user', content: 'new-short-prompt', files: [{ id: 'new-file' }] }] }
  const result = await runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
    upstream_context: { chatId: 'old-chat', responseId: 'old-response' },
    sendChatRequest: async (body, requestOptions) => {
      retries += 1
      assert.equal(requestOptions.currentAccount.email, accounts[1].email)
      if (retries === 1) return {
        status: true, response: finishedStream('Still working'), chatId: 'new-chat',
        currentAccount: requestOptions.currentAccount, requestBody: replacementBody
      }
      assert.equal(requestOptions.chatId, 'new-chat')
      assert.equal(requestOptions.parentId, null, 'must not keep the old response ID')
      assert.equal(requestOptions.contextPrefixKey, null)
      assert.deepEqual(body.messages[0].files, [{ id: 'new-file' }])
      return { status: true, response: finishedStream(), currentAccount: requestOptions.currentAccount }
    }
  }))
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  assert.equal(result.currentAccount.email, accounts[1].email)
})

test('an exception during a later protocol retry names the replacement account, not the original', async () => {
  let retries = 0
  await assert.rejects(runOpenAIAgentTurn(Readable.from([failureFrame()]), options({
    sendChatRequest: async (body, requestOptions) => {
      retries += 1
      if (retries === 1) return { status: true, response: finishedStream('Still working'), currentAccount: requestOptions.currentAccount }
      assertNoUpstreamFailure({ error: { code: 'quota_limit' } })
    }
  })), error => isRateLimitError(error) && error.failedAccountEmail === accounts[1].email && error.accountFailureRecorded)
  assert.equal(accountManager.accountRotator.quotaCooldownUntil.size, 2)
})

function createResponse() {
  return {
    output: '', headers: {}, headersSent: false, writableEnded: false, statusCode: 200,
    set(headers) { Object.assign(this.headers, headers); return this },
    status(statusCode) { this.statusCode = statusCode; return this },
    write(chunk) { this.headersSent = true; this.output += chunk; return true },
    end() { this.writableEnded = true },
    json(payload) { this.output = JSON.stringify(payload); this.headersSent = true; this.writableEnded = true }
  }
}

test('OpenAI controllers attribute successful JSON and SSE usage to the replacement only', async context => {
  const recorded = []
  context.mock.method(accountManager, 'accumulateStats', (email, kind, usage) => recorded.push({ email, kind, usage }))
  for (const stream of [false, true]) {
    accountManager.accountRotator.reset()
    const response = createResponse()
    const runtimeOptions = options({ sendChatRequest: async (body, requestOptions) => ({
      status: true, response: finishedStream(), currentAccount: requestOptions.currentAccount
    }) })
    if (stream) await handleStreamResponse(response, Readable.from([failureFrame()]), false, false, requestBody, runtimeOptions)
    else await handleNonStreamResponse(response, Readable.from([failureFrame()]), false, false, 'qwen-test', requestBody, runtimeOptions)
    assert.match(response.output, /OK/)
    assert.doesNotMatch(response.output, /insufficient_quota/)
  }
  assert.deepEqual(recorded.map(record => record.email), [accounts[1].email, accounts[1].email])
  assert.ok(recorded.every(record => record.usage.input === 4 && record.usage.output === 1))
})

test('controller reports exhausted pool with 429 and does not double-mark the original account', async context => {
  const recorded = []
  context.mock.method(accountManager, 'recordAccountQuotaExhausted', email => {
    recorded.push(email)
    accountManager.accountRotator.recordQuotaExhausted(email)
  })
  accountManager.accountRotator.setAccounts(accounts.slice(0, 2))
  const response = createResponse()
  await handleNonStreamResponse(response, Readable.from([failureFrame()]), false, false, 'qwen-test', requestBody, options({
    sendChatRequest: async (body, requestOptions) => ({ status: true, response: Readable.from([failureFrame()]), currentAccount: requestOptions.currentAccount })
  }))
  assert.equal(response.statusCode, 429)
  assert.deepEqual(recorded, accounts.slice(0, 2).map(account => account.email))
  assert.equal(JSON.parse(response.output).error.type, 'insufficient_quota')
})
