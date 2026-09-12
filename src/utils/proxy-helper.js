const { once } = require('node:events');
const { STATUS_CODES } = require('node:http');
const { isIP } = require('node:net');
const { PassThrough, Readable } = require('node:stream');
const { checkServerIdentity } = require('node:tls');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
// The explicit entry bypasses Bun's built-in undici shim, which ignores custom sockets.
const { Agent, Pool, ProxyAgent, errors, interceptors, request: proxyRequest } = require('undici/index.js');

const config = require('../config/index.js');
const { logger } = require('./logger');

// Per-account agent cache keyed by `${proxyUrl}::${email}`.
// LRU eviction when cache exceeds MAX_AGENT_CACHE_SIZE.
const proxyAgents = new Map()
const MAX_AGENT_CACHE_SIZE = 50
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
const proxyUrls = new WeakMap();
const proxyTransports = new WeakMap();

/**
 * Reuse the account's SOCKS/CONNECT implementation with an HTTP client that honors sockets.
 */
const getProxyTransport = (proxyAgent) => {
    let transport = proxyTransports.get(proxyAgent);
    if (transport) return transport;

    const dispatcher = proxyAgent instanceof HttpsProxyAgent ? new ProxyAgent({
        uri: proxyAgent.proxy.href,
        token: proxyAgent.proxy.username || proxyAgent.proxy.password
            ? `Basic ${Buffer.from(`${decodeURIComponent(proxyAgent.proxy.username)}:${decodeURIComponent(proxyAgent.proxy.password)}`).toString('base64')}`
            : undefined,
        requestTls: { ...proxyAgent.options, timeout: PROXY_CONNECT_TIMEOUT_MS },
        proxyTls: { ...proxyAgent.connectOpts, timeout: PROXY_CONNECT_TIMEOUT_MS },
        clientFactory: (origin, options) => new Pool(origin, { ...options, headersTimeout: PROXY_CONNECT_TIMEOUT_MS })
    }) : new Agent({
        connect: async (options, callback) => {
            let socket;
            try {
                const secureEndpoint = options.protocol === 'https:';
                const targetHostname = options.servername || options.hostname;
                const connector = new SocksProxyAgent(proxyUrls.get(proxyAgent), { timeout: PROXY_CONNECT_TIMEOUT_MS });
                socket = await connector.connect(new PassThrough(), {
                    ...proxyAgent.options,
                    ...options,
                    host: options.hostname,
                    port: Number(options.port || (secureEndpoint ? 443 : 80)),
                    secureEndpoint,
                    servername: isIP(targetHostname) ? undefined : targetHostname,
                    checkServerIdentity: (hostname, certificate) => checkServerIdentity(targetHostname, certificate),
                    ALPNProtocols: ['http/1.1']
                });
                if (secureEndpoint) {
                    await once(socket, 'secureConnect', { signal: AbortSignal.timeout(PROXY_CONNECT_TIMEOUT_MS) });
                }
                // Bound tunnel setup without imposing the same idle limit on model generation.
                socket.setTimeout(0);
                callback(null, socket);
            } catch (error) {
                socket?.destroy();
                // Undici retries raw hostname errors against alternate SNI values; a proxy must fail closed.
                callback(error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? new errors.SecureProxyConnectionError(error) : error, null);
            }
        }
    });
    const requestDispatcher = dispatcher.compose(interceptors.redirect({ maxRedirections: 20 }), interceptors.decompress());
    const fetch = async (url, options) => {
        const request = new globalThis.Request(url, options);
        // Keep buffered upstream payloads replayable across 307/308 redirects.
        const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
        const response = await proxyRequest(request.url, {
            dispatcher: requestDispatcher,
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body,
            signal: request.signal,
            maxRedirections: request.redirect === 'follow' ? 20 : 0
        });
        const noBody = request.method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
        if (noBody) await response.body.dump();
        // Bun stalls on Undici fetch's WebStream bridge; its native Response streams correctly.
        try {
            return new globalThis.Response(noBody ? null : Readable.toWeb(response.body), {
                status: response.statusCode,
                statusText: STATUS_CODES[response.statusCode] || '',
                headers: response.headers
            });
        } catch (error) {
            response.body.destroy();
            throw error;
        }
    };
    const adapter = async (requestConfig) => {
        const adaptedConfig = {
            ...requestConfig,
            env: { ...requestConfig.env, fetch, Request: globalThis.Request, Response: globalThis.Response }
        };
        try {
            const response = await axios.getAdapter('fetch', adaptedConfig)(adaptedConfig);
            // Existing SSE consumers rely on Node streams for both success and error bodies.
            if (requestConfig.responseType === 'stream') response.data = Readable.fromWeb(response.data);
            return response;
        } catch (error) {
            if (requestConfig.responseType === 'stream' && error.response?.data?.getReader) {
                error.response.data = Readable.fromWeb(error.response.data);
            }
            throw error;
        }
    };
    transport = { dispatcher, fetch, adapter };
    proxyTransports.set(proxyAgent, transport);
    return transport;
};

const destroyProxyAgent = (agent) => {
    const transport = proxyTransports.get(agent);
    if (transport) {
        transport.dispatcher.destroy().catch(error => {
            logger.warn('关闭代理连接池失败', 'PROXY', '', error.message);
        });
        proxyTransports.delete(agent);
    }
    agent.destroy();
};

// Accept http/https/socks5 protocols; regex intentionally loose to catch common typos only
const PROXY_URL_REGEX = /^(https?|socks5):\/\/[^\s]+$/i

/**
 * Validate proxy URL format.
 * Null/undefined/empty are valid (means "no account-level proxy").
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
const isValidProxyUrl = (url) => {
    if (url === null || url === undefined || url === '') return true
    if (typeof url !== 'string') return false
    const trimmed = url.trim()
    if (!trimmed) return true
    return PROXY_URL_REGEX.test(trimmed)
}

/**
 * Resolve the effective proxy URL for an account.
 * Priority: account.proxy > global PROXY_URL > null
 * @param {Object} [account]
 * @returns {string|null}
 */
const resolveProxyUrl = (account) => {
    if (account && typeof account.proxy === 'string' && account.proxy.trim()) {
        return account.proxy.trim()
    }
    return config.proxyUrl || null
}

/**
 * Evict oldest entry from agent cache when over limit.
 * Map iteration order is insertion order, so first key is oldest.
 */
const evictOldestAgent = () => {
    if (proxyAgents.size <= MAX_AGENT_CACHE_SIZE) return
    const oldestKey = proxyAgents.keys().next().value
    if (oldestKey !== undefined) {
        const agent = proxyAgents.get(oldestKey)
        destroyProxyAgent(agent);
        proxyAgents.delete(oldestKey)
    }
}

/**
 * Build cache key from proxy URL and account email.
 * @param {string|null} url
 * @param {Object} [account]
 * @returns {string}
 */
const buildAgentCacheKey = (url, account) => {
    const email = account && account.email ? account.email : '__global__'
    return `${url || ''}::${email}`
}

/**
 * Get or create a proxy agent, keyed by proxy URL + account email.
 * Separate TCP pools per account even when sharing the same proxy.
 * @param {string|null} url
 * @param {Object} [account]
 * @returns {HttpsProxyAgent|SocksProxyAgent|undefined}
 */
const getOrCreateAgent = (url, account) => {
    if (!url) return undefined
    const key = buildAgentCacheKey(url, account)
    let agent = proxyAgents.get(key)
    if (!agent) {
        const proxyUrl = new URL(url);
        switch (proxyUrl.protocol) {
            case 'socks5:':
                agent = new SocksProxyAgent(proxyUrl);
                break;
            case 'http:':
            case 'https:':
                agent = new HttpsProxyAgent(proxyUrl);
                break;
            default:
                throw new Error(`Unsupported proxy protocol: ${proxyUrl.protocol}`);
        }
        proxyUrls.set(agent, proxyUrl);
        proxyAgents.set(key, agent)
        evictOldestAgent()
    } else {
        // Move to end (most recently used) by deleting and re-inserting
        proxyAgents.delete(key)
        proxyAgents.set(key, agent)
    }
    return agent
}

/**
 * Get proxy agent for an account.
 * @param {Object} [account] - Account object (optional). Falls back to global PROXY_URL
 * @returns {HttpsProxyAgent|SocksProxyAgent|undefined}
 */
const getProxyAgent = (account) => {
    return getOrCreateAgent(resolveProxyUrl(account), account)
}

/**
 * Invalidate cached agent for a specific proxy URL.
 * Called when an account's proxy is changed or removed.
 * @param {string|null} url
 * @returns {void}
 */
const invalidateProxyAgent = (url) => {
    if (!url) return
    // Delete all entries matching this proxy URL exactly (any account).
    // Cache keys are `${proxyUrl}::${email}`; match only when the URL segment
    // before '::' equals the target url to avoid prefix collisions (e.g. port 8080 vs 80800).
    for (const [key, agent] of proxyAgents.entries()) {
        const sepIdx = key.lastIndexOf('::')
        if (sepIdx !== -1 && key.slice(0, sepIdx) === url) {
            destroyProxyAgent(agent);
            proxyAgents.delete(key)
        }
    }
}

/**
 * Get Chat API base URL.
 * @returns {string}
 */
const getChatBaseUrl = () => config.qwenChatProxyUrl

/**
 * Get CLI API base URL.
 * @returns {string}
 */
const getCliBaseUrl = () => config.qwenCliProxyUrl

/**
 * Apply proxy settings to axios request config.
 * Note: account as second optional param for backward compatibility.
 * @param {Object} [requestConfig]
 * @param {Object} [account]
 * @returns {Object}
 */
const applyProxyToAxiosConfig = (requestConfig = {}, account) => {
    const proxyAgent = getProxyAgent(account)
    if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent;
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
        if (process.versions.bun) {
            requestConfig.adapter = getProxyTransport(proxyAgent).adapter;
        }
    }
    return requestConfig
}

/**
 * Fetch through the account proxy, falling back to the global proxy.
 * @param {string|URL} url
 * @param {Object} [fetchOptions]
 * @param {Object} [account]
 * @returns {Promise<Response>}
 */
const fetchWithProxy = (url, fetchOptions = {}, account) => {
    const proxyAgent = getProxyAgent(account);
    if (!proxyAgent) return fetch(url, fetchOptions);

    return getProxyTransport(proxyAgent).fetch(url, fetchOptions);
};

module.exports = {
    resolveProxyUrl,
    getProxyAgent,
    invalidateProxyAgent,
    getChatBaseUrl,
    getCliBaseUrl,
    applyProxyToAxiosConfig,
    fetchWithProxy,
    isValidProxyUrl
}
