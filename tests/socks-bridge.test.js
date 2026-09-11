// Loopback CONNECT -> SOCKS5 bridge (src/utils/socks-bridge.js) and its wiring in proxy-helper.
// Bun's fetch only accepts http(s) proxies, so socks5 account proxies are reached through the bridge.
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { HttpsProxyAgent } = require('https-proxy-agent')

const config = require('../src/config/index.js')
config.proxyUrl = null // no global PROXY_URL leaking in from the environment
const { parseSocksUrl, ensureSocksBridge, closeSocksBridges } = require('../src/utils/socks-bridge.js')
const { getProxyAgent } = require('../src/utils/proxy-helper.js')

const openSockets = new Set()
const track = (socket) => {
  openSockets.add(socket)
  socket.once('close', () => openSockets.delete(socket))
  return socket
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()))
const onceData = (socket) => new Promise((resolve) => socket.once('data', resolve))
const onceClose = (socket) => new Promise((resolve) => (socket.closed ? resolve() : socket.once('close', resolve)))

// Echo target behind the fake SOCKS server.
const startTarget = async () => {
  const server = net.createServer((socket) => { track(socket).pipe(socket) })
  return { server, port: await listen(server) }
}

// Minimal SOCKS5 server, no auth. Records each CONNECT destination; `fail` answers "connection refused".
const startFakeSocks = async ({ targetPort, fail = false }) => {
  const requests = []
  const server = net.createServer((socket) => {
    track(socket)
    socket.on('error', () => {})
    let stage = 'greeting'
    socket.on('data', (chunk) => {
      if (stage === 'greeting') {
        stage = 'request'
        socket.write(Buffer.from([0x05, 0x00]))
        return
      }
      if (stage !== 'request') return
      stage = 'relay'
      const atyp = chunk[3]
      let host
      let offset
      if (atyp === 0x01) {
        host = Array.from(chunk.subarray(4, 8)).join('.')
        offset = 8
      } else if (atyp === 0x03) {
        host = chunk.subarray(5, 5 + chunk[4]).toString()
        offset = 5 + chunk[4]
      } else {
        host = chunk.subarray(4, 20).toString('hex')
        offset = 20
      }
      requests.push({ atyp, host, port: chunk.readUInt16BE(offset) })
      if (fail) {
        socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }
      const upstream = track(net.connect(targetPort, '127.0.0.1', () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.pipe(upstream).pipe(socket)
      }))
      upstream.on('error', () => socket.destroy())
    })
  })
  return { server, port: await listen(server), requests }
}

// Raw client: send `text` to the bridge, resolve with the first response chunk.
const rawConnect = async (bridgeUrl, text) => {
  const { hostname, port } = new URL(bridgeUrl)
  const socket = track(net.connect(Number(port), hostname))
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(text)
  const response = (await onceData(socket)).toString('latin1')
  return { socket, response }
}

let target
let socks
let socksFail
let socksUrl
let socksFailUrl
let bridgeUrl
let bridgeFailUrl

test.before(async () => {
  target = await startTarget()
  socks = await startFakeSocks({ targetPort: target.port })
  socksFail = await startFakeSocks({ targetPort: target.port, fail: true })
  socksUrl = `socks5://127.0.0.1:${socks.port}`
  socksFailUrl = `socks5://127.0.0.1:${socksFail.port}`
  bridgeUrl = await ensureSocksBridge(socksUrl)
  bridgeFailUrl = await ensureSocksBridge(socksFailUrl)
})

test.after(async () => {
  for (const socket of openSockets) socket.destroy()
  await closeSocksBridges()
  await Promise.all([target, socks, socksFail].map((fixture) => closeServer(fixture.server)))
})

test('parseSocksUrl maps socks5:// URLs to socks client options', () => {
  assert.deepEqual(parseSocksUrl('socks5://proxy.test:1081'), { host: 'proxy.test', port: 1081, type: 5 })
  assert.deepEqual(parseSocksUrl('socks5://proxy.test'), { host: 'proxy.test', port: 1080, type: 5 })
  assert.deepEqual(parseSocksUrl('socks5://u:p%40s@[::1]:1080'),
    { host: '::1', port: 1080, type: 5, userId: 'u', password: 'p@s' })
})

test('CONNECT to a hostname tunnels through SOCKS5 and relays bytes both ways', async () => {
  const { socket, response } = await rawConnect(bridgeUrl,
    'CONNECT example.test:8443 HTTP/1.1\r\nHost: example.test:8443\r\nProxy-Connection: Keep-Alive\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 200 /)
  assert.deepEqual(socks.requests.at(-1), { atyp: 3, host: 'example.test', port: 8443 })
  socket.write('ping')
  assert.equal((await onceData(socket)).toString(), 'ping')
  socket.destroy()
})

test('CONNECT to an IPv6 literal strips brackets and dials ATYP 4', async () => {
  const { socket, response } = await rawConnect(bridgeUrl, 'CONNECT [::1]:443 HTTP/1.1\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 200 /)
  assert.deepEqual(socks.requests.at(-1), { atyp: 4, host: '0'.repeat(31) + '1', port: 443 })
  socket.destroy()
})

test('a SOCKS5 failure answers 502 and closes', async () => {
  const { socket, response } = await rawConnect(bridgeFailUrl, 'CONNECT example.test:443 HTTP/1.1\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 502 /)
  await onceClose(socket)
})

test('non-CONNECT requests answer 405', async () => {
  const { socket, response } = await rawConnect(bridgeUrl, 'GET / HTTP/1.1\r\nHost: example.test\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 405 /)
  await onceClose(socket)
})

test('oversized headers answer 431', async () => {
  const { socket, response } = await rawConnect(bridgeUrl, 'A'.repeat(9 * 1024))
  assert.match(response, /^HTTP\/1\.1 431 /)
  await onceClose(socket)
})

test('getProxyAgent routes socks5 through one bridge per URL, one agent per account', async () => {
  const [agentA, agentAConcurrent] = await Promise.all([
    getProxyAgent({ email: 'a@test', proxy: socksUrl }),
    getProxyAgent({ email: 'a@test', proxy: socksUrl })
  ])
  assert.ok(agentA instanceof HttpsProxyAgent)
  assert.equal(agentA.proxy.href, `${bridgeUrl}/`)
  assert.equal(agentAConcurrent, agentA)
  const agentB = await getProxyAgent({ email: 'b@test', proxy: socksUrl })
  assert.notEqual(agentB, agentA)
  assert.equal(agentB.proxy.href, agentA.proxy.href)
  const agentOther = await getProxyAgent({ email: 'a@test', proxy: socksFailUrl })
  assert.equal(agentOther.proxy.href, `${bridgeFailUrl}/`)
  assert.notEqual(agentOther.proxy.port, agentA.proxy.port)
})

test('http proxies are used as-is and no proxy resolves to undefined', async () => {
  const agent = await getProxyAgent({ email: 'c@test', proxy: 'http://127.0.0.1:9' })
  assert.ok(agent instanceof HttpsProxyAgent)
  assert.equal(agent.proxy.href, 'http://127.0.0.1:9/')
  assert.equal(await getProxyAgent({ email: 'd@test' }), undefined)
  assert.equal(await getProxyAgent(undefined), undefined)
})
