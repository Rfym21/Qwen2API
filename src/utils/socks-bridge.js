const net = require('net')
const { SocksClient } = require('socks')

// Bun's node:http forwards an Agent's `proxy` URL to its native fetch, which only speaks
// http(s) proxies and rejects socks5:// with UnsupportedProxyProtocol; a custom agent's
// createConnection is never called. So for socks5 URLs we run one loopback HTTP CONNECT
// proxy per socks URL and point HttpsProxyAgent at it. The bridge dials the real SOCKS5
// server and pipes bytes both ways. Works the same under Node.
// 每个 socks URL 对应一个仅监听 127.0.0.1 的 CONNECT 桥；Bun 的 fetch 只支持 http(s) 代理
const bridges = new Map() // socksUrl -> Promise<string> ('http://127.0.0.1:<port>')
const servers = new Map() // socksUrl -> net.Server
const MAX_HEADER_BYTES = 8 * 1024
const DEFAULT_SOCKS_PORT = 1080

/**
 * Map a socks5:// URL to `socks` client proxy options.
 * @param {string} url
 * @returns {{host: string, port: number, type: 5, userId?: string, password?: string}}
 */
const parseSocksUrl = (url) => {
    const parsed = new URL(url)
    const proxy = {
        host: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: parsed.port ? Number(parsed.port) : DEFAULT_SOCKS_PORT,
        type: 5
    }
    if (parsed.username) proxy.userId = decodeURIComponent(parsed.username)
    if (parsed.password) proxy.password = decodeURIComponent(parsed.password)
    return proxy
}

const parseConnectTarget = (target) => {
    const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(target) || /^([^:\s]+):(\d{1,5})$/.exec(target)
    if (!match) return null
    const port = Number(match[2])
    if (port <= 0 || port >= 65536) return null
    return { host: match[1], port }
}

const reply = (socket, status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
}

const handleConnection = (proxy, socket) => {
    let head = Buffer.alloc(0)
    let clientClosed = false
    socket.on('error', () => socket.destroy())
    socket.once('close', () => { clientClosed = true })

    const onData = (chunk) => {
        head = Buffer.concat([head, chunk])
        const headerEnd = head.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
            if (head.length > MAX_HEADER_BYTES) reply(socket, '431 Request Header Fields Too Large')
            return
        }
        socket.off('data', onData)
        socket.pause()

        // Only the request line matters; Bun and https-proxy-agent both add Host/Proxy-Connection.
        const requestLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1')
        const leftover = head.subarray(headerEnd + 4)
        const match = /^(\S+) (\S+) HTTP\/1\.[01]$/.exec(requestLine)
        if (!match) return reply(socket, '400 Bad Request')
        if (match[1] !== 'CONNECT') return reply(socket, '405 Method Not Allowed')
        const destination = parseConnectTarget(match[2])
        if (!destination) return reply(socket, '400 Bad Request')

        SocksClient.createConnection({ proxy, command: 'connect', destination })
            .then(({ socket: upstream }) => {
                if (clientClosed) return upstream.destroy()
                upstream.on('error', () => socket.destroy())
                upstream.once('close', () => socket.destroy())
                socket.once('close', () => upstream.destroy())
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                if (leftover.length) upstream.write(leftover)
                socket.pipe(upstream).pipe(socket)
            })
            .catch(() => {
                if (!clientClosed) reply(socket, '502 Bad Gateway')
            })
    }
    socket.on('data', onData)
}

/**
 * Start (once) the loopback CONNECT bridge for a socks5 URL.
 * @param {string} socksUrl
 * @returns {Promise<string>} http://127.0.0.1:<port> to hand to HttpsProxyAgent
 */
const ensureSocksBridge = (socksUrl) => {
    const existing = bridges.get(socksUrl)
    if (existing) return existing
    const pending = new Promise((resolve, reject) => {
        const proxy = parseSocksUrl(socksUrl)
        const server = net.createServer((socket) => handleConnection(proxy, socket))
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            server.unref()
            servers.set(socksUrl, server)
            resolve(`http://127.0.0.1:${server.address().port}`)
        })
    })
    bridges.set(socksUrl, pending)
    // A failed start must not be cached; the next caller retries.
    pending.catch(() => bridges.delete(socksUrl))
    return pending
}

/** Close every bridge server (tests / shutdown). */
const closeSocksBridges = async () => {
    const closing = [...servers.values()].map((server) => new Promise((resolve) => server.close(() => resolve())))
    servers.clear()
    bridges.clear()
    await Promise.all(closing)
}

module.exports = {
    parseSocksUrl,
    ensureSocksBridge,
    closeSocksBridges
}
