const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const axios = require('axios')

// The Bun/undici proxy transport must never bridge a body through Readable.toWeb/fromWeb: under
// Bun the bridge drops undici's body error on a mid-body close, the consumer hangs and the
// rejection escapes as a process crash (qwen-next, 2026-09-16). The transport itself is
// runtime-agnostic, so this drives it under Node through a real SOCKS5 hop against an upstream
// that cuts the socket mid-body.

process.env.DATA_SAVE_MODE = 'none'
process.env.ACCOUNTS = ''
const { getProxyAgent, getProxyTransport } = require('../src/utils/proxy-helper')

const SSE_FRAME = `data: ${'x'.repeat(120)}\n\n`
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// Minimal SOCKS5: no auth, CONNECT, IPv4 or domain targets; propagates the upstream close.
const startSocks5 = () => net.createServer((client) => {
  client.on('error', () => {})
  client.once('data', (greeting) => {
    if (greeting[0] !== 5) return client.destroy()
    client.write(Buffer.from([5, 0]))
    client.once('data', (request) => {
      if (request[0] !== 5 || request[1] !== 1) return client.destroy()
      let host, offset
      if (request[3] === 1) {
        host = request.subarray(4, 8).join('.')
        offset = 8
      } else if (request[3] === 3) {
        const length = request[4]
        host = request.subarray(5, 5 + length).toString()
        offset = 5 + length
      } else {
        return client.destroy()
      }
      const upstream = net.connect(request.readUInt16BE(offset), host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
    })
  })
})

const startUpstream = () => http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const [route, query = ''] = req.url.split('?')
    if (route === '/sse-cut') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let sent = 0; sent < 5708; sent += SSE_FRAME.length) res.write(SSE_FRAME)
      setTimeout(() => res.socket.destroy(), 30)
    } else if (route === '/sse-401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    } else if (route === '/json') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-probe': '1' })
      res.end(JSON.stringify({ ok: true, method: req.method, query, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization || '' }))
    } else if (route === '/json-500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
    } else if (route === '/bytes') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([1, 2, 3, 250]))
    } else if (route === '/reset') {
      req.socket.destroy()
    } else if (route === '/slow-headers') {
      setTimeout(() => { res.writeHead(200); res.end('late') }, 1500)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
})

let socks, upstream, base, transport
const escaped = []
const onEscape = (error) => escaped.push(error)

test.before(async () => {
  process.on('unhandledRejection', onEscape)
  process.on('uncaughtException', onEscape)
  socks = startSocks5()
  upstream = startUpstream()
  const socksPort = await listen(socks)
  base = `http://127.0.0.1:${await listen(upstream)}`
  transport = getProxyTransport(getProxyAgent({ email: 'transport@example.com', proxy: `socks5://127.0.0.1:${socksPort}` }))
})

test.after(() => {
  process.off('unhandledRejection', onEscape)
  process.off('uncaughtException', onEscape)
  socks.close()
  upstream.close()
})

const request = (config) => axios.request({ adapter: transport.adapter, proxy: false, ...config })
const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error)
const readAll = async (stream) => {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

test('stream: a mid-body close rejects the consumer and escapes nowhere', async () => {
  const response = await request({ url: `${base}/sse-cut`, method: 'post', data: '{}', responseType: 'stream', timeout: 5000 })
  assert.equal(response.status, 200)
  assert.equal(typeof response.data.on, 'function', 'SSE consumers expect a Node stream')
  let received = 0
  await assert.rejects(
    (async () => { for await (const chunk of response.data) received += chunk.length })(),
    (error) => error.code === 'UND_ERR_SOCKET'
  )
  assert.ok(received > 0, 'the cut happens after bytes were delivered')
  await settle()
  assert.deepEqual(escaped, [])
})

test('stream: a non-2xx still rejects with the body as a Node stream', async () => {
  const error = await rejection(request({ url: `${base}/sse-401`, responseType: 'stream' }))
  assert.equal(error.response?.status, 401)
  assert.equal(typeof error.response.data.on, 'function')
  assert.equal(await readAll(error.response.data), '{"error":"unauthorized"}')
})

test('json: method, query, body and headers reach the upstream; axios parses the text', async () => {
  const response = await request({
    url: `${base}/json`,
    method: 'post',
    params: { chat_id: 'abc' },
    data: { hello: 'world' },
    headers: { Authorization: 'Bearer test' }
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-probe'], '1')
  assert.deepEqual(response.data, { ok: true, method: 'POST', query: 'chat_id=abc', body: '{"hello":"world"}', auth: 'Bearer test' })
  const error = await rejection(request({ url: `${base}/json-500` }))
  assert.equal(error.response?.status, 500)
  assert.deepEqual(error.response.data, { error: 'boom' })
})

test('arraybuffer: returns a Buffer like the Node adapter', async () => {
  const response = await request({ url: `${base}/bytes`, responseType: 'arraybuffer' })
  assert.ok(Buffer.isBuffer(response.data))
  assert.deepEqual([...response.data], [1, 2, 3, 250])
})

test('request-phase transport errors map onto the codes request.js retries', async () => {
  const reset = await rejection(request({ url: `${base}/reset`, responseType: 'stream' }))
  assert.equal(reset.isAxiosError, true)
  assert.equal(reset.code, 'ECONNRESET')
  assert.equal(reset.cause?.code, 'UND_ERR_SOCKET')
  const timeout = await rejection(request({ url: `${base}/slow-headers`, timeout: 200 }))
  assert.equal(timeout.code, 'ECONNABORTED')
  assert.equal(timeout.cause?.code, 'UND_ERR_HEADERS_TIMEOUT')
})

test('fetch: the Response is buffered, so a mid-body close rejects instead of hanging', async () => {
  const ok = await transport.fetch(`${base}/json`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).ok, true)
  await assert.rejects(transport.fetch(`${base}/sse-cut`, { method: 'POST', body: '{}' }), (error) => error.code === 'UND_ERR_SOCKET')
  await settle()
  assert.deepEqual(escaped, [])
})
