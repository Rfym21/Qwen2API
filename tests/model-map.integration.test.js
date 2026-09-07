// Integration: the model map through BOTH real request builders, offline.
// The require.cache stub for models-map.js goes in BEFORE anything else is required
// (chat-helpers.js destructures getLatestModels at its first require). Relies on node:test
// per-file process isolation. This file DOES load account.js (through chat-helpers), so run it
// through `npm test` (--test-force-exit); never standalone without that flag.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { Readable } = require('node:stream');

const UPSTREAM = [
  { id: 'qwen3.8-max', info: { meta: { chat_type: ['t2t', 'search'], think_skip: { enable: true } } } },
  { id: 'qwen3-max', info: { meta: { chat_type: ['t2t'] } } }
];
const modelsMapPath = require.resolve('../src/models/models-map.js');
const modelsMapStub = new Module(modelsMapPath);
modelsMapStub.filename = modelsMapPath;
modelsMapStub.loaded = true;
modelsMapStub.exports = { getLatestModels: async () => UPSTREAM };
require.cache[modelsMapPath] = modelsMapStub;

// anthropic.js captures sendChatRequest by destructuring at its first require: patch first.
const requestModule = require('../src/utils/request.js');
let captured = null;
const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;
const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
requestModule.sendChatRequest = async (...args) => {
  captured = args.find(arg => arg && Array.isArray(arg.messages));
  return { status: true, response: Readable.from([answerFrame('hola'), STOP]), currentAccount: null };
};

const config = require('../src/config/index.js');
const { processRequestBody } = require('../src/middlewares/chat-middleware.js');
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js');
const { resetModelMapState } = require('../src/utils/model-map.js');

const createRes = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  set(headers) { Object.assign(this.headers, headers); return this; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; }
});

const runOpenAI = async (model) => {
  const req = { body: { model, messages: [{ role: 'user', content: 'hi' }] } };
  let err = null;
  await processRequestBody(req, createRes(), (e) => { err = e || null; });
  assert.equal(err, null, err && err.message);
  return req;
};

// fid / childrenIds / timestamp are fresh per call; neutralize them before comparing bodies
const normalizeBody = (body) => {
  const clone = JSON.parse(JSON.stringify(body));
  clone.timestamp = 0;
  for (const message of clone.messages || []) {
    message.fid = 'fid';
    message.childrenIds = ['child'];
    message.timestamp = 0;
  }
  return clone;
};

describe('model map through the real request builders', () => {
  beforeEach(() => { config.modelMap = ''; resetModelMapState(); captured = null; });
  after(() => { config.modelMap = ''; try { require('../src/utils/account.js').destroy(); } catch (e) { /* no accounts in tests */ } });

  it('OpenAI path: exact -thinking target reaches upstream as the base id with thinking on', async () => {
    config.modelMap = 'claude-opus-5=qwen3.8-max-thinking';
    const req = await runOpenAI('claude-opus-5');
    assert.equal(req.body.model, 'qwen3.8-max');
    assert.equal(req.body.messages[0].feature_config.thinking_enabled, true);
    assert.equal(req.body.chat_type, 't2t');
    assert.equal(req.enable_thinking, true);
  });

  it('OpenAI path: a Qwen id builds the same body with or without a map', async () => {
    config.modelMap = 'claude-opus-5=qwen3.8-max-thinking,*=qwen3-max';
    const mapped = normalizeBody((await runOpenAI('qwen3.8-max')).body);
    config.modelMap = '';
    const plain = normalizeBody((await runOpenAI('qwen3.8-max')).body);
    assert.deepEqual(mapped, plain);
    assert.equal(plain.model, 'qwen3.8-max');
    assert.equal(plain.messages[0].feature_config.thinking_enabled, false);
  });

  it('Anthropic path: * target reaches upstream as the base id with thinking on; response echoes it', async () => {
    config.modelMap = '*=qwen3.8-max-thinking';
    const res = createRes();
    await handleAnthropicMessages({
      body: { model: 'claude-opus-5', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] }
    }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body?.error || null));
    assert.ok(captured, 'sendChatRequest must have been called');
    assert.equal(captured.model, 'qwen3.8-max');
    assert.equal(captured.messages[0].feature_config.thinking_enabled, true);
    assert.equal(res.body.model, 'qwen3.8-max');
    const text = (res.body.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    assert.equal(text, 'hola');
  });
});
