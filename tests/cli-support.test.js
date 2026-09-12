const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { gzipSync } = require('node:zlib');
const axios = require('axios');

const config = require('../src/config/index.js');
const cliManager = require('../src/utils/cli.manager.js');
const cliSupport = require('../src/utils/cli-support.js');
const { applyProxyToAxiosConfig, fetchWithProxy, invalidateProxyAgent } = require('../src/utils/proxy-helper.js');

const originalProxyUrl = config.proxyUrl;
config.proxyUrl = null;
test.after(() => { config.proxyUrl = originalProxyUrl; });

/**
 * Keep the destination unreachable so a successful request proves proxy use.
 * The fixture checks the actual SOCKS5/CONNECT handshake before serving HTTP.
 */
async function startProxy(t, { protocol, authenticated, rejectConnect = false, stall = false }) {
  const requests = [];
  const credentials = [];
  const sockets = new Set();
  const closedConnections = [];
  const server = createServer(socket => {
    sockets.add(socket);
    closedConnections.push(new Promise(resolve => socket.once('close', resolve)));
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let stage = protocol === 'socks5' ? 'greeting' : 'tunnel';

    socket.on('data', chunk => {
      if (stall) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (stage === 'greeting') {
          if (pending.length < 2 || pending.length < 2 + pending[1]) return;
          assert.equal(pending[0], 5);
          const method = authenticated ? 2 : 0;
          assert.ok(pending.subarray(2, 2 + pending[1]).includes(method));
          pending = pending.subarray(2 + pending[1]);
          socket.write(Buffer.from([5, method]));
          stage = authenticated ? 'authentication' : 'connect';
        } else if (stage === 'authentication') {
          if (pending.length < 2 || pending.length < 3 + pending[1]) return;
          const usernameLength = pending[1];
          const passwordLength = pending[2 + usernameLength];
          const length = 3 + usernameLength + passwordLength;
          if (pending.length < length) return;
          assert.equal(pending[0], 1);
          credentials.push({
            username: pending.subarray(2, 2 + usernameLength).toString(),
            password: pending.subarray(3 + usernameLength, length).toString()
          });
          pending = pending.subarray(length);
          socket.write(Buffer.from([1, 0]));
          stage = 'connect';
        } else if (stage === 'connect') {
          if (pending.length < 10) return;
          assert.deepEqual([...pending.subarray(0, 8)], [5, 1, 0, 1, 127, 0, 0, 1]);
          assert.equal(pending.readUInt16BE(8), 65000);
          pending = pending.subarray(10);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          stage = 'request';
        } else if (stage === 'tunnel') {
          const boundary = pending.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          assert.equal(pending.toString('ascii').split('\r\n')[0], 'CONNECT 127.0.0.1:65000 HTTP/1.1');
          if (rejectConnect) {
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return;
          }
          pending = pending.subarray(boundary + 4);
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          stage = 'request';
        } else {
          const boundary = pending.indexOf('\r\n\r\n');
          if (boundary === -1) return;
          const headers = pending.subarray(0, boundary).toString();
          const contentLength = Number(headers.match(/content-length: (\d+)/i)?.[1] || 0);
          if (pending.length < boundary + 4 + contentLength) return;
          const [method, path] = headers.split('\r\n')[0].split(' ');
          const body = pending.subarray(boundary + 4, boundary + 4 + contentLength).toString();
          requests.push({ method, path, body });
          if (path === '/timeout') return;
          const response = path === '/stream' ? 'data: {"ok":true}\n\n' : JSON.stringify({
            via: protocol,
            device_code: 'device-code',
            user_code: 'user-code',
            access_token: 'proxy-access-token',
            refresh_token: 'proxy-refresh-token',
            expires_in: 3600
          });
          const contentType = path === '/stream' ? 'text/event-stream' : 'application/json';
          const status = path === '/error' ? '403 Forbidden' : path === '/redirect' ? '307 Temporary Redirect' : '200 OK';
          const encodedResponse = path === '/gzip' ? gzipSync(response) : response;
          const extraHeaders = path === '/gzip' ? 'Content-Encoding: gzip\r\n' : path === '/redirect' ? 'Location: /gzip\r\n' : '';
          const responseHeaders = `HTTP/1.1 ${status}\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(encodedResponse)}\r\n${extraHeaders}Connection: close\r\n\r\n`;
          if (path === '/stream') {
            socket.write(responseHeaders + response.slice(0, 8));
            setTimeout(() => socket.end(response.slice(8)), 10);
          } else {
            socket.write(responseHeaders);
            socket.end(encodedResponse);
          }
          return;
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const auth = authenticated ? 'proxy%40user:p%40ss%3Aword@' : '';
  return { url: `${protocol}://${auth}127.0.0.1:${server.address().port}`, requests, credentials, waitForClose: () => Promise.all(closedConnections) };
}

for (const scenario of [
  { protocol: 'socks5', authenticated: false, global: true },
  { protocol: 'socks5', authenticated: true, global: false },
  { protocol: 'http', authenticated: false, global: false }
]) {
  test(`${scenario.global ? 'global' : 'account'} ${scenario.protocol} proxy carries Axios and every CLI OAuth request${scenario.authenticated ? ' with authentication' : ''}`, { timeout: 10000 }, async t => {
    const proxy = await startProxy(t, scenario);
    const previousProxy = config.proxyUrl;
    const previousBaseUrl = config.qwenChatProxyUrl;
    config.proxyUrl = scenario.global ? proxy.url : 'http://127.0.0.1:1';
    config.qwenChatProxyUrl = 'http://127.0.0.1:65000';
    t.after(() => {
      config.proxyUrl = previousProxy;
      config.qwenChatProxyUrl = previousBaseUrl;
      invalidateProxyAgent(proxy.url);
    });
    const account = { email: 'proxy-test@example.com', ...(scenario.global ? {} : { proxy: proxy.url }) };

    const response = await axios.get('http://127.0.0.1:65000/axios', applyProxyToAxiosConfig({ timeout: 2000 }, account));
    assert.equal(response.data.via, scenario.protocol);
    const device = await cliManager.initiateDeviceFlow(account);
    assert.equal(device.status, true);
    assert.equal(device.device_code, 'device-code');
    assert.equal(await cliManager.authorizeLogin(device.user_code, 'test-token', account), true);
    const token = await cliManager.pollForToken(device.device_code, device.code_verifier, account);
    assert.equal(token.access_token, 'proxy-access-token');
    const refreshed = await cliManager.refreshAccessToken(token, account);
    assert.equal(refreshed.access_token, 'proxy-access-token');
    assert.equal(refreshed.refresh_token, 'proxy-refresh-token');
    const stream = await axios.get('http://127.0.0.1:65000/stream', applyProxyToAxiosConfig({ responseType: 'stream', timeout: 2000 }, account));
    assert.equal(typeof stream.data.pipe, 'function');
    const chunks = [];
    for await (const chunk of stream.data) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'data: {"ok":true}\n\n');
    const failure = await axios.get('http://127.0.0.1:65000/error', applyProxyToAxiosConfig({ responseType: 'stream', timeout: 2000 }, account))
      .then(() => null, error => error);
    assert.equal(failure.response.status, 403);
    assert.equal(typeof failure.response.data.pipe, 'function');
    const errorChunks = [];
    for await (const chunk of failure.response.data) errorChunks.push(Buffer.from(chunk));
    assert.equal(JSON.parse(Buffer.concat(errorChunks).toString()).via, scenario.protocol);
    const redirected = await axios.post('http://127.0.0.1:65000/redirect', { replay: true }, applyProxyToAxiosConfig({ timeout: 2000 }, account));
    assert.equal(redirected.data.via, scenario.protocol);
    await assert.rejects(
      axios.get('http://127.0.0.1:65000/timeout', applyProxyToAxiosConfig({ timeout: 50 }, account)),
      error => ['ETIMEDOUT', 'ECONNABORTED'].includes(error.code)
    );
    assert.deepEqual(proxy.requests.map(({ method, path }) => [method, path]), [
      ['GET', '/axios'],
      ['POST', '/api/v1/oauth2/device/code'],
      ['POST', '/api/v2/oauth2/authorize'],
      ['POST', '/api/v1/oauth2/token'],
      ['POST', '/api/v1/oauth2/token'],
      ['GET', '/stream'],
      ['GET', '/error'],
      ['POST', '/redirect'],
      ['POST', '/gzip'],
      ['GET', '/timeout']
    ]);
    assert.equal(new URLSearchParams(proxy.requests[1].body).get('code_challenge_method'), 'S256');
    assert.equal(JSON.parse(proxy.requests[2].body).user_code, 'user-code');
    assert.equal(new URLSearchParams(proxy.requests[4].body).get('grant_type'), 'refresh_token');
    assert.equal(proxy.requests[7].body, proxy.requests[8].body);
    assert.equal(JSON.parse(proxy.requests[8].body).replay, true);
    assert.deepEqual(proxy.credentials, scenario.authenticated
      ? Array.from({ length: 10 }, () => ({ username: 'proxy@user', password: 'p@ss:word' }))
      : []);
  });
}

test('a rejected CONNECT fails promptly for HTTP and HTTPS requests', { timeout: 5000 }, async t => {
  const proxy = await startProxy(t, { protocol: 'http', rejectConnect: true });
  t.after(() => invalidateProxyAgent(proxy.url));
  for (const protocol of ['http', 'https']) {
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(
      fetchWithProxy(`${protocol}://127.0.0.1:65000/`, { signal }, { proxy: proxy.url }),
      error => /407/.test(error.message) && !signal.aborted
    );
  }
});

test('an unresponsive SOCKS5 handshake is bounded and releases its connection', { timeout: 15000 }, async t => {
  const proxy = await startProxy(t, { protocol: 'socks5', stall: true });
  t.after(() => invalidateProxyAgent(proxy.url));
  const started = Date.now();
  await assert.rejects(fetchWithProxy('http://127.0.0.1:65000/', {}, { proxy: proxy.url }), error => /timed out/i.test(error.cause?.message || error.message));
  await proxy.waitForClose();
  assert.ok(Date.now() - started < 14000);
});

test('pollForToken stops after 3 unsuccessful attempts', async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;

  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 504,
      statusText: 'Gateway Time-out',
      headers: new Map([['content-type', 'text/html']]),
      text: async () => '<html>504 Gateway Time-out</html>'
    };
  };
  global.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const result = await cliManager.pollForToken('device-code', 'code-verifier');
    assert.equal(attempts, 3);
    assert.deepEqual(result, {
      status: false,
      access_token: null,
      refresh_token: null,
      expiry_date: null
    });
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

test('getAccountCliState reports unsupported CLI without touching account health', () => {
  const state = cliSupport.getAccountCliState({
    cli_info: null,
    cli_unavailable_reason: 'unsupported',
    expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } }
  }, {}, Date.now());

  assert.equal(state.status.cli, 'unsupported');
  assert.equal(state.status.kind, 'active');
  assert.equal(state.cliQuotaLimit, 0);
  assert.equal(state.cliRequestNumber, 0);
});

test('getAccountCliState keeps normal accounts on default CLI quota', () => {
  const state = cliSupport.getAccountCliState({
    cli_info: { request_number: 12 },
    expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 2, input: 10, output: 20 } }
  }, {}, Date.now());

  assert.equal(state.status.kind, 'active');
  assert.equal(state.status.cli, 'available');
  assert.equal(state.cliQuotaLimit, 2000);
  assert.equal(state.cliRequestNumber, 12);
});

test('getAccountCliState marks uninitialized accounts as CLI pending', () => {
  const state = cliSupport.getAccountCliState({
    cli_info: null,
    cli_unavailable_reason: null,
    expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } }
  }, {}, Date.now());

  assert.equal(state.status.cli, 'pending');
  assert.equal(state.status.kind, 'active');
  assert.equal(state.cliQuotaLimit, 0);
  assert.equal(state.cliRequestNumber, 0);
});

// The whole point of splitting kind and cli: with a single field the disabled CLI
// shadowed every health state, so a cooling-down account looked perfectly normal.
test('CLI availability never shadows account health', () => {
  const now = Date.now();

  const cooling = cliSupport.getAccountCliState({
    cli_info: null,
    cli_unavailable_reason: 'disabled',
    expires: Math.floor(now / 1000) + 24 * 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } }
  }, { cooldownEndsAt: now + 60 * 1000 }, now);

  assert.equal(cooling.status.kind, 'cooldown');
  assert.equal(cooling.status.cli, 'disabled');
  assert.equal(cooling.status.cooldownEndsAt, now + 60 * 1000);

  const expiring = cliSupport.getAccountCliState({
    cli_info: null,
    cli_unavailable_reason: 'disabled',
    expires: Math.floor(now / 1000) + 60 * 60,
    stats: { chat: { input: 0, output: 0 }, cli: { calls: 0, input: 0, output: 0 } }
  }, {}, now);

  assert.equal(expiring.status.kind, 'token_expiring');
  assert.equal(expiring.status.cli, 'disabled');
});

test('getCliAvailability maps every unavailability reason', () => {
  assert.equal(cliSupport.getCliAvailability({ cli_unavailable_reason: 'disabled' }), 'disabled');
  assert.equal(cliSupport.getCliAvailability({ cli_unavailable_reason: 'unsupported' }), 'unsupported');
  assert.equal(cliSupport.getCliAvailability({ cli_info: null }), 'pending');
  assert.equal(cliSupport.getCliAvailability({ cli_info: { request_number: 1 } }), 'available');
});

// Regression: `chatBaseUrl` used to be declared inside the try, so the catch's
// log line threw a ReferenceError that masked the real authorization failure
// and turned the promise into a rejection instead of `false`.
test('authorizeLogin returns false and logs status + URL on a non-ok response', async () => {
  const { logger } = require('../src/utils/logger');
  const originalFetch = global.fetch;
  const originalError = logger.error;

  const logged = [];
  logger.error = (...args) => { logged.push(args); };

  try {
    global.fetch = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Map([['content-type', 'text/plain']]),
      text: async () => 'denied'
    });
    const onNonOk = await cliManager.authorizeLogin('user-code', 'token');
    assert.equal(onNonOk, false);

    // The FIRST log (before the catch) must carry the response detail — that
    // log's content is half the point of the fix.
    assert.ok(logged.length >= 2, 'expected the pre-catch log plus the catch log');
    const firstDetail = logged[0].find(a => a && typeof a === 'object');
    assert.equal(firstDetail?.status, 403);
    assert.equal(firstDetail?.body, 'denied');

    const urlLogs = logged.filter(args =>
      args.some(a => a && typeof a === 'object' && String(a.url || '').includes('/api/v2/oauth2/authorize')));
    assert.equal(urlLogs.length, 1);
  } finally {
    global.fetch = originalFetch;
    logger.error = originalError;
  }
});

test('authorizeLogin returns false and logs the URL when fetch itself throws', async () => {
  const { logger } = require('../src/utils/logger');
  const originalFetch = global.fetch;
  const originalError = logger.error;

  const logged = [];
  logger.error = (...args) => { logged.push(args); };

  try {
    global.fetch = async () => { throw new Error('network down'); };
    const onThrow = await cliManager.authorizeLogin('user-code', 'token');
    assert.equal(onThrow, false);

    const urlLogs = logged.filter(args =>
      args.some(a => a && typeof a === 'object' && String(a.url || '').includes('/api/v2/oauth2/authorize')));
    assert.equal(urlLogs.length, 1);
  } finally {
    global.fetch = originalFetch;
    logger.error = originalError;
  }
});
