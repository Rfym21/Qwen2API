const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')

process.env.API_KEY = 'chat-challenge-test-key'
process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
process.env.ENABLE_CLI = 'false'
process.env.ENABLE_FILE_LOG = 'false'
process.env.PROXY_URL = ''

const accountManager = require('../src/utils/account')
const { sendChatRequest } = require('../src/utils/request')
const {
  assertNoUpstreamFailure,
  assertChatChallengeBreakerClosed,
  resetChatChallengeBreaker,
  describeUpstreamFailure,
  isWafChallengeError,
  isRateLimitError
} = require('../src/utils/upstream-error')

// The only frame Qwen sent on every chat challenge in prod, 2026-09-23..26 (477 of 502 sends).
const challenge = { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'] }
const answer = { choices: [{ delta: { phase: 'answer', content: '你好' }, finish_reason: null }] }
const thrown = fn => { try { fn() } catch (error) { return error } return null }

test.before(async () => { await accountManager._initPromise })
test.beforeEach(() => resetChatChallengeBreaker())
test.after(() => { accountManager.destroy() })

test('a chat challenge is a retryable overload, not a 502/500, and blames neither context nor account', () => {
  const error = thrown(() => assertNoUpstreamFailure(challenge))
  assert.ok(isWafChallengeError(error) && !isRateLimitError(error))
  assert.doesNotMatch(error.publicMessage, /上下文|账号/)
  assert.deepEqual(describeUpstreamFailure(error, 500),
    { rateLimited: false, overloaded: true, status: 529, retryAfter: 30 })
  assert.equal(describeUpstreamFailure(error, 502, 503).status, 503)
})

test('three chat challenges in a row stop new requests; a request that gets an answer closes the breaker', () => {
  thrown(() => assertNoUpstreamFailure(challenge))
  thrown(() => assertNoUpstreamFailure(challenge))
  assert.equal(thrown(assertChatChallengeBreakerClosed), null, 'two strikes keep it closed')
  assert.equal(thrown(() => assertNoUpstreamFailure(challenge)).retryAfter, 60, 'the third asks for the full cooldown')

  const blocked = thrown(assertChatChallengeBreakerClosed)
  assert.ok(isWafChallengeError(blocked))
  assert.deepEqual(describeUpstreamFailure(blocked, 500),
    { rateLimited: false, overloaded: true, status: 529, retryAfter: 60 })

  assertNoUpstreamFailure(answer)
  assert.equal(thrown(assertChatChallengeBreakerClosed), null)
})

test('an open breaker lets requests through again after its cooldown, and the first challenged one reopens it', () => {
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    for (let strike = 0; strike < 3; strike += 1) thrown(() => assertNoUpstreamFailure(challenge))
    now += 30_000
    assert.equal(thrown(assertChatChallengeBreakerClosed).retryAfter, 30, 'Retry-After is the time actually left')
    now += 30_000
    assert.equal(thrown(assertChatChallengeBreakerClosed), null, 'cooldown over: the probe goes out')
    thrown(() => assertNoUpstreamFailure(challenge))
    assert.equal(thrown(assertChatChallengeBreakerClosed).retryAfter, 60)
  } finally {
    Date.now = realNow
  }
})

test('sendChatRequest refuses while the breaker is open, before creating a chat or uploading history', async () => {
  const realPost = axios.post
  axios.post = async () => assert.fail('an open breaker must not reach Qwen')
  try {
    for (let strike = 0; strike < 3; strike += 1) thrown(() => assertNoUpstreamFailure(challenge))
    await assert.rejects(
      sendChatRequest({ model: 'qwen3-max', messages: [{ role: 'user', content: '你好' }] },
        { currentAccount: { email: 'breaker@example.invalid', token: 'breaker-test-token' } }),
      error => isWafChallengeError(error) && describeUpstreamFailure(error, 500).status === 529
    )
  } finally {
    axios.post = realPost
  }
})
