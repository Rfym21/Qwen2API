const test = require('node:test')
const assert = require('node:assert/strict')

const { isValidProxyUrl, getProxyAgent, describeEgress, invalidateProxyAgent } = require('../src/utils/proxy-helper')

// socks5:// resolves the target hostname locally and hands the proxy an IP; socks5h://
// lets the proxy resolve (curl semantics). On qwen-next (2026-09-16) 76 of 80 upstream
// connections reached sing-box as bare IPs: DNS for Qwen's domains was leaving through
// Hetzner's resolver while the TCP went through WARP. The `h` variant closes that gap,
// and the dashboard/route validators must let it through or the field cannot be saved.

test('socks5h:// is a valid account proxy URL, alongside socks5/http/https', () => {
  assert.equal(isValidProxyUrl('socks5h://lohari-warp-qwen:9091'), true)
  assert.equal(isValidProxyUrl('socks5://lohari-warp-qwen:9091'), true)
  assert.equal(isValidProxyUrl('SOCKS5H://x:1'), true)
  assert.equal(isValidProxyUrl('http://x:1'), true)
  assert.equal(isValidProxyUrl('socks4://x:1'), false)
  assert.equal(isValidProxyUrl('socks5hh://x:1'), false)
  assert.equal(isValidProxyUrl('socks5h:/x:1'), false)
})

test('socks5h:// builds a SOCKS agent that leaves DNS to the proxy; socks5:// resolves locally', () => {
  const remoteUrl = 'socks5h://127.0.0.1:1080'
  const localUrl = 'socks5://127.0.0.1:1080'
  const remote = getProxyAgent({ email: 'socks5h@example.com', proxy: remoteUrl })
  const local = getProxyAgent({ email: 'socks5@example.com', proxy: localUrl })
  try {
    assert.equal(remote.shouldLookup, false, 'socks5h must hand the hostname to the proxy')
    assert.equal(local.shouldLookup, true, 'socks5 keeps the historical local lookup')
    assert.equal(remote.proxy.type, 5)
  } finally {
    invalidateProxyAgent(remoteUrl)
    invalidateProxyAgent(localUrl)
  }
})

test('describeEgress keeps the scheme so a log line tells socks5h apart from socks5, without credentials', () => {
  assert.equal(
    describeEgress({ email: 'a@example.com', proxy: 'socks5h://user:secret@lohari-warp-qwen:9091' }),
    'socks5h://lohari-warp-qwen:9091'
  )
  assert.equal(
    describeEgress({ email: 'a@example.com', proxy: 'socks5://lohari-warp-qwen:9091' }),
    'socks5://lohari-warp-qwen:9091'
  )
})
