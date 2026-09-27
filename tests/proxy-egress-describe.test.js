const test = require('node:test')
const assert = require('node:assert/strict')

const config = require('../src/config/index.js')
const { describeEgress } = require('../src/utils/proxy-helper')
const { assertParseBreakerClosed, noteParseOutcome, resetParseBreaker } = require('../src/utils/upload')

// The WAF challenge is per egress IP. Every parse failure names its egress so a
// burnt proxy can be told apart from a Qwen-side outage in one log line.

const withGlobalProxy = (value, fn) => {
  const saved = config.proxyUrl
  config.proxyUrl = value
  try {
    return fn()
  } finally {
    config.proxyUrl = saved
  }
}

test('describeEgress: "direct" when neither the account nor PROXY_URL sets a proxy', () => {
  withGlobalProxy(null, () => {
    assert.equal(describeEgress({ email: 'a@example.com' }), 'direct')
    assert.equal(describeEgress(null), 'direct')
    assert.equal(describeEgress(undefined), 'direct')
  })
})

test('describeEgress: the account proxy wins over PROXY_URL and is trimmed', () => {
  withGlobalProxy('http://global.example:8080', () => {
    assert.equal(
      describeEgress({ proxy: '  socks5://lohari-warp-qwen:9091  ' }),
      'socks5://lohari-warp-qwen:9091'
    )
  })
})

test('describeEgress: falls back to PROXY_URL when the account has no proxy', () => {
  withGlobalProxy('socks5://127.0.0.1:1080', () => {
    assert.equal(describeEgress({ proxy: '' }), 'socks5://127.0.0.1:1080')
    assert.equal(describeEgress({}), 'socks5://127.0.0.1:1080')
  })
})

test('describeEgress: credentials are dropped, only protocol//host:port remains', () => {
  withGlobalProxy(null, () => {
    assert.equal(
      describeEgress({ proxy: 'http://user:s3cr3t@proxy.example:3128' }),
      'http://proxy.example:3128'
    )
    assert.equal(
      describeEgress({ proxy: 'socks5://u:p@10.0.0.2:1080' }),
      'socks5://10.0.0.2:1080'
    )
  })
})

test('describeEgress: an "@" in the password, query or path never leaks or eats the host', () => {
  withGlobalProxy(null, () => {
    // password containing "@": userinfo ends at the LAST "@" of the authority
    const leaky = describeEgress({ proxy: 'http://user:p@ss@proxy.example:3128' })
    assert.equal(leaky, 'http://proxy.example:3128')
    assert.doesNotMatch(leaky, /ss/)
    // "@" in the query with no path segment: no credentials, host must survive
    assert.equal(
      describeEgress({ proxy: 'http://proxy.example:3128?token=abc@def' }),
      'http://proxy.example:3128'
    )
    // "@" in the path
    assert.equal(
      describeEgress({ proxy: 'socks5://proxy.example:1080/a@b/c' }),
      'socks5://proxy.example:1080'
    )
  })
})

test('describeEgress: an unparseable URL still gets its userinfo masked', () => {
  withGlobalProxy(null, () => {
    assert.throws(() => new URL('http://u:p@ss@[::1'), 'precondition: this shape must not parse')
    assert.equal(describeEgress({ proxy: 'http://u:p@ss@[::1' }), 'http://***@[::1')
    assert.equal(describeEgress({ proxy: 'http://[::1' }), 'http://[::1')
  })
})

test('breaker-open rejection names the egress like every other parse failure', () => {
  const savedBreaker = config.agentParseBreakerSeconds
  config.agentParseBreakerSeconds = 90
  resetParseBreaker()
  try {
    const waf = () => Object.assign(new Error('waf'), { code: 'qwen_parse_waf_challenge', parseCode: 'WAF_CAPTCHA' })
    for (let i = 0; i < 5; i++) noteParseOutcome(waf())
    assert.throws(
      () => assertParseBreakerClosed({ proxy: 'socks5://u:p@lohari-warp-qwen:9091' }),
      (error) =>
        error.breakerOpen === true &&
        error.parseCode === 'WAF_CAPTCHA' &&
        error.egress === 'socks5://lohari-warp-qwen:9091' &&
        /upload skipped, via socks5:\/\/lohari-warp-qwen:9091\)$/.test(error.message) &&
        !error.message.includes('u:p@')
    )
  } finally {
    resetParseBreaker()
    config.agentParseBreakerSeconds = savedBreaker
  }
})
