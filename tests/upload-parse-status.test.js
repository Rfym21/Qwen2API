// Fail-fast cuando el servicio de parse de documentos de Qwen esta caido.
//
// Observado en vivo 2026-09-09 21:25 (qwen-next y prod, 22/22 sondeos): Qwen sigue
// contestando HTTP 200, pero el cuerpo es
//   POST /api/v2/files/parse         -> {"success":true, "data":{"code":"Internal_Server_Error"}}
//   POST /api/v2/files/parse/status  -> {"success":false,"data":{"code":"Internal_Server_Error"}}
// sin ningun `status` por archivo. El bucle lo tomaba por "pendiente": 30 sondeos x 500 ms
// = 15 s por turno, y despues un "解析超时" que no era un timeout.
const test = require('node:test')
const assert = require('node:assert/strict')
const OSS = require('ali-oss');

process.env.API_KEY = process.env.API_KEY || 'test-only-key'
process.env.ENABLE_FILE_LOG = 'false';

// axios se parchea en el cache de require ANTES de cargar upload.js, que lo captura al
// requerirse. Ningun otro modulo del test toca la red.
const axiosPath = require.resolve('axios')
const calls = []
const stsCalls = [];
const ossRequests = [];
let ossRequestError = null;
let stsFailuresRemaining = 0;
let parseResponse = { data: { success: true, data: {} } }
let statusQueue = []
const axiosStub = {
  request: async (requestConfig) => {
    ossRequests.push(requestConfig);
    if (ossRequestError) throw ossRequestError;
    return {
      status: 200,
      headers: { toJSON: () => ({ 'x-oss-request-id': 'proxy-upload-test' }) },
      data: Buffer.from('upload response')
    };
  },
  post: async (url, data, requestConfig) => {
    calls.push(url)
    if (url.endsWith('/api/v1/files/getstsToken')) {
      stsCalls.push({ data, requestConfig });
      if (stsFailuresRemaining > 0) {
        stsFailuresRemaining -= 1;
        throw Object.assign(new Error('STS request timed out'), { code: 'ETIMEDOUT' });
      }
      return {
        status: 200,
        data: {
          access_key_id: 'test-access-key',
          access_key_secret: 'test-access-secret',
          security_token: 'test-security-token',
          file_url: 'https://example.invalid/upload.txt',
          file_path: 'test/upload.txt',
          bucketname: 'upload-proxy-test',
          region: 'oss-cn-hangzhou',
          file_id: 'upload-proxy-file'
        }
      };
    }
    if (url.endsWith('/api/v2/files/parse')) return parseResponse
    if (url.endsWith('/api/v2/files/parse/status')) {
      return statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]
    }
    throw new Error(`unexpected axios.post ${url}`)
  },
  get: async (url) => { throw new Error(`unexpected axios.get ${url}`) },
  create () { return axiosStub },
  defaults: { headers: { common: {} } },
  isAxiosError: () => false
}
axiosStub.default = axiosStub
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosStub }

const { parseUploadedTextFile, uploadFileToQwenOss } = require('../src/utils/upload.js');
const { getProxyAgent, invalidateProxyAgent } = require('../src/utils/proxy-helper.js');

test.after(() => {
  const accountModule = require.cache[require.resolve('../src/utils/account.js')];
  if (accountModule) accountModule.exports.destroy();
})

const reset = () => {
  calls.length = 0
  stsCalls.length = 0;
  ossRequests.length = 0;
  ossRequestError = null;
  stsFailuresRemaining = 0;
  parseResponse = { data: { success: true, data: {} } }
  statusQueue = []
}
const statusCalls = () => calls.filter(url => url.endsWith('/files/parse/status')).length
const perFile = (status) => ({ data: { success: true, data: { list: [{ file_id: 'f1', status }] } } })
const SERVICE_DOWN = { data: { success: false, data: { code: 'Internal_Server_Error' } } }

test('parse status with success:false fails on the FIRST poll, not after 30', async () => {
  reset()
  statusQueue = [SERVICE_DOWN]
  const started = Date.now()
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 200, maxAttempts: 30 }),
    (error) => {
      assert.equal(error.code, 'qwen_parse_unavailable')
      assert.equal(error.parseCode, 'Internal_Server_Error')
      assert.match(error.message, /Internal_Server_Error/)
      assert.doesNotMatch(error.message, /超时/)
      return true
    }
  )
  assert.equal(statusCalls(), 1)
  assert.ok(Date.now() - started < 1000, 'must not wait for the poll budget')
})

test('parse POST answering with an error code fails before any status poll', async () => {
  reset()
  parseResponse = { data: { success: true, data: { code: 'Internal_Server_Error' } } }
  statusQueue = [perFile('success')]
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10 }),
    (error) => error.code === 'qwen_parse_unavailable'
  )
  assert.equal(statusCalls(), 0)
})

test('a genuinely pending parse still resolves once the file reports success', async () => {
  reset()
  statusQueue = [perFile('pending'), perFile('parsing'), perFile('success')]
  assert.equal(await parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10 }), true)
  assert.equal(statusCalls(), 3)
})

test('a real timeout names the last status seen', async () => {
  reset()
  statusQueue = [perFile('parsing')]
  await assert.rejects(
    parseUploadedTextFile('f1', 'token', {}, { intervalMs: 10, maxAttempts: 3 }),
    /解析超时: f1 \(last status="parsing"\)/
  )
  assert.equal(statusCalls(), 3)
})

test('STS and OSS uploads use the same isolated proxy agent for each account', async (context) => {
  reset();
  const accounts = ['first', 'second'].map(name => ({
    email: `${name}@example.invalid`,
    proxy: 'socks5://127.0.0.1:1080'
  }));
  const originalPut = OSS.prototype.put;
  context.after(() => {
    OSS.prototype.put = originalPut;
    invalidateProxyAgent(accounts[0].proxy);
  });

  const ossAgents = [];
  const clients = [];
  OSS.prototype.put = async function (path, content) {
    clients.push(this);
    ossAgents.push({ agent: this.options.agent, httpsAgent: this.options.httpsAgent });
    if (this.options.urllib) {
      const response = await this.urllib.request(`https://upload.example.invalid/${path}`, {
        method: 'PUT', content, headers: { 'content-type': 'text/plain' }, timeout: 2000
      });
      assert.equal(response.status, 200);
      assert.equal(response.res.status, 200);
      assert.equal(response.headers['x-oss-request-id'], 'proxy-upload-test');
      assert.equal(response.data.toString(), 'upload response');
    }
    return { res: { status: 200 } };
  };

  for (const account of accounts) {
    const result = await uploadFileToQwenOss(Buffer.from('upload content'), 'upload.txt', 'test-token', account);
    assert.equal(result.file_id, 'upload-proxy-file');
  }

  assert.equal(stsCalls.length, 2);
  assert.equal(ossAgents.length, 2);
  for (let index = 0; index < accounts.length; index += 1) {
    const expectedAgent = getProxyAgent(accounts[index]);
    assert.equal(stsCalls[index].requestConfig.httpAgent, expectedAgent);
    assert.equal(stsCalls[index].requestConfig.httpsAgent, expectedAgent);
    assert.equal(stsCalls[index].requestConfig.proxy, false);
    assert.equal(ossAgents[index].agent, expectedAgent);
    assert.equal(ossAgents[index].httpsAgent, expectedAgent);
  }
  assert.notEqual(ossAgents[0].httpsAgent, ossAgents[1].httpsAgent);
  if (process.versions.bun) {
    assert.equal(ossRequests.length, 2);
    for (let index = 0; index < accounts.length; index += 1) {
      assert.equal(ossRequests[index].httpsAgent, getProxyAgent(accounts[index]));
      assert.equal(typeof ossRequests[index].adapter, 'function');
      assert.equal(ossRequests[index].data.toString(), 'upload content');
    }
    for (const [code, status] of [['ETIMEDOUT', -2], ['ERR_NETWORK', -1]]) {
      ossRequestError = Object.assign(new Error(`proxy failure: ${code}`), { code });
      await assert.rejects(clients[0].urllib.request('https://upload.example.invalid/file', {}), error => error.status === status);
      const sdkError = await clients[0].requestError(ossRequestError);
      assert.equal(sdkError.message, `proxy failure: ${code}`);
      assert.equal(sdkError.status, status);
    }
  }
});

test('STS and OSS retries retain the account proxy agent', async (context) => {
  reset();
  stsFailuresRemaining = 1;
  const account = { email: 'retry@example.invalid', proxy: 'socks5://127.0.0.1:1080' };
  const originalPut = OSS.prototype.put;
  context.after(() => {
    OSS.prototype.put = originalPut;
    invalidateProxyAgent(account.proxy);
  });
  const expectedAgent = getProxyAgent(account);

  const ossAgents = [];
  OSS.prototype.put = async function () {
    ossAgents.push({ agent: this.options.agent, httpsAgent: this.options.httpsAgent });
    if (ossAgents.length === 1) throw new Error('OSS upload failed');
    return { res: { status: 200 } };
  };

  const result = await uploadFileToQwenOss(Buffer.from('upload content'), 'upload.txt', 'test-token', account);

  assert.equal(result.file_id, 'upload-proxy-file');
  assert.equal(stsCalls.length, 2);
  assert.equal(ossAgents.length, 2);
  for (const { requestConfig } of stsCalls) {
    assert.equal(requestConfig.httpAgent, expectedAgent);
    assert.equal(requestConfig.httpsAgent, expectedAgent);
    assert.equal(requestConfig.proxy, false);
  }
  for (const { agent, httpsAgent } of ossAgents) {
    assert.equal(agent, expectedAgent);
    assert.equal(httpsAgent, expectedAgent);
  }
});
