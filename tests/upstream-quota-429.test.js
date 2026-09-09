// La cuota diaria de Qwen llega al cliente con el status equivocado en LOS DOS caminos.
//
// Observado en vivo, en las sesiones reales del usuario (2026-08-21). El cuerpo que Qwen
// manda cuando la cuenta agota el dia es, palabra por palabra:
//
//   UpstreamResponseError: You've reached the upper limit for today's usage.
//     code: 'RateLimited'
//
// y lo que el cliente agentico recibia era:
//
//   /v1/messages          -> HTTP 500 {"type":"error","error":{"type":"api_error",...}}
//   /v1/chat/completions  -> HTTP 502 {"error":{...,"type":"upstream_error","code":"RateLimited"}}
//
// Ninguno de los dos es distinguible de "el servidor esta roto", asi que Claude Code
// reintenta contra un muro: cada reintento quema otra cuenta del pool. Las APIs nativas
// contestan 429 — Anthropic con `rate_limit_error`, OpenAI con `insufficient_quota` —
// justamente para que el cliente sepa que esperar es lo unico que sirve.
//
// La clasificacion vive UNA vez, en src/utils/upstream-error.js. Los controladores solo
// la consultan y la traducen a su propia forma de cable; son gemelos y cambian juntos.
//
// Retry-After: solo si el upstream lo dio. Qwen manda `data.num` en HORAS en el paquete
// de cuota (misma lectura que src/controllers/chat.image.video.js:88). Sin ese campo no
// se emite la cabecera — inventar una espera es peor que no dar ninguna.

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');

process.env.API_KEY = process.env.API_KEY || 'test-only-key';

// Sin red: parchear el cache de require ANTES de requerir los controladores (ambos
// capturan sendChatRequest por destructuring en su primer require).
const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };
const requestModule = require('../src/utils/request.js');
let upstreamFactory = null;
requestModule.sendChatRequest = async () => (upstreamFactory
  ? { status: true, response: upstreamFactory(), currentAccount: null }
  : { status: false });

const {
  UpstreamResponseError,
  assertNoUpstreamFailure,
  isRateLimitError,
  rateLimitRetryAfterSeconds
} = require('../src/utils/upstream-error.js');
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js');
const { handleStreamResponse, handleNonStreamResponse } = require('../src/controllers/chat.js');

test.after(() => {
  require('../src/utils/account.js').destroy();
});

// --- material real -----------------------------------------------------------------

const QUOTA_MESSAGE = "You've reached the upper limit for today's usage.";

/** El paquete tal cual lo manda Qwen al agotarse la cuota diaria: sin `choices`. */
const quotaPayload = (extra = {}) => ({
  success: false,
  data: { code: 'RateLimited', details: QUOTA_MESSAGE, ...extra }
});

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const quotaFrame = (extra = {}) => frame(quotaPayload(extra));
const answerFrame = (content) => frame({
  choices: [{ delta: { phase: 'answer', content, status: null }, finish_reason: null }]
});

/** Generador crudo: Readable.from precargaria los frames y el corte no se observaria. */
const streamOf = (chunks) => {
  async function* gen() { for (const c of chunks) yield Buffer.from(c); }
  const s = gen();
  s.on = () => s;
  return s;
};

// --- dobles de res -----------------------------------------------------------------

const jsonRes = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  headersSent: false,
  writableEnded: false,
  set(h, v) { if (typeof h === 'string') this.headers[h] = v; else Object.assign(this.headers, h); return this; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; this.headersSent = true; this.writableEnded = true; return this; },
  write(chunk) { this.headersSent = true; this.output = (this.output || '') + String(chunk); return true; },
  end(chunk = '') { if (chunk) this.output = (this.output || '') + String(chunk); this.writableEnded = true; }
});

const streamRes = () => ({
  output: '',
  headers: {},
  statusCode: 200,
  headersSent: false,
  writableEnded: false,
  set(h, v) { if (typeof h === 'string') this.headers[h] = v; else Object.assign(this.headers, h); return this; },
  status(code) { this.statusCode = code; return this; },
  write(chunk) { this.headersSent = true; this.output += String(chunk); return true; },
  end(chunk = '') { if (chunk) this.output += String(chunk); this.writableEnded = true; },
  json(payload) { this.headersSent = true; this.output += JSON.stringify(payload); return this; },
  writeHead(code, h) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, h || {}); },
  flush() {}
});

/** Los eventos SSE de Anthropic salen como `event: X\ndata: {...}`. */
const sseEvents = (output) => String(output)
  .split('\n\n')
  .map(block => {
    const ev = /(?:^|\n)event: (.+)/.exec(block);
    const da = /(?:^|\n)data: (.+)/.exec(block);
    if (!ev || !da) return null;
    try { return { event: ev[1].trim(), data: JSON.parse(da[1]) }; } catch (_) { return null; }
  })
  .filter(Boolean);

/** Los frames de OpenAI son `data: {...}` a secas. */
const sseFrames = (output) => String(output)
  .split('\n\n')
  .map(block => {
    const da = /(?:^|\n)?data: ([\s\S]+)/.exec(block);
    if (!da || da[1].trim() === '[DONE]') return null;
    try { return JSON.parse(da[1]); } catch (_) { return null; }
  })
  .filter(Boolean);

// ===================================================================================
describe('clasificacion: la cuota agotada se reconoce una sola vez, en upstream-error', () => {
  it('el paquete real de cuota lanza UpstreamResponseError con code RateLimited', () => {
    assert.throws(
      () => assertNoUpstreamFailure(quotaPayload()),
      (e) => e instanceof UpstreamResponseError
        && e.code === 'RateLimited'
        && e.publicMessage === QUOTA_MESSAGE
    );
  });

  it('isRateLimitError reconoce ese error', () => {
    let caught = null;
    try { assertNoUpstreamFailure(quotaPayload()); } catch (e) { caught = e; }
    assert.ok(caught, 'el paquete de cuota tiene que lanzar');
    assert.equal(isRateLimitError(caught), true);
  });

  it('isRateLimitError NO se traga el WAF ni un error de negocio cualquiera', () => {
    let waf = null;
    try {
      assertNoUpstreamFailure({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::x'] });
    } catch (e) { waf = e; }
    assert.ok(waf, 'el WAF tiene que lanzar');
    assert.equal(isRateLimitError(waf), false, 'un captcha no es una cuota agotada');

    let biz = null;
    try {
      assertNoUpstreamFailure({ success: false, data: { code: 'Bad_Request', details: 'internal error' } });
    } catch (e) { biz = e; }
    assert.ok(biz);
    assert.equal(isRateLimitError(biz), false);

    // Y el desacuerdo de protocolo del gate, que ya tiene su politica de 502 deliberada.
    assert.equal(
      isRateLimitError(new UpstreamResponseError('x', 'upstream_agent_turn_incomplete')),
      false
    );
    assert.equal(isRateLimitError(null), false);
    assert.equal(isRateLimitError(new Error('boom')), false);
  });

  it('clasifica por el texto aunque el code venga vacio', () => {
    // El upstream no siempre pone `data.code`; el texto ingles es el que vio el usuario.
    assert.equal(isRateLimitError(new UpstreamResponseError(QUOTA_MESSAGE, 'upstream_business_error')), true);
  });

  it('Retry-After: null cuando el upstream no dio ninguna espera', () => {
    let caught = null;
    try { assertNoUpstreamFailure(quotaPayload()); } catch (e) { caught = e; }
    assert.equal(rateLimitRetryAfterSeconds(caught), null, 'sin dato real no se inventa una espera');
  });

  it('Retry-After: convierte a segundos las horas que SI mando el upstream', () => {
    let caught = null;
    try { assertNoUpstreamFailure(quotaPayload({ num: 2 })); } catch (e) { caught = e; }
    assert.equal(rateLimitRetryAfterSeconds(caught), 7200, '2 h == 7200 s');
  });

  it('Retry-After: una espera basura no produce cabecera', () => {
    for (const num of [0, -1, 'pronto', null, NaN, Infinity]) {
      let caught = null;
      try { assertNoUpstreamFailure(quotaPayload({ num })); } catch (e) { caught = e; }
      assert.equal(rateLimitRetryAfterSeconds(caught), null, `num=${String(num)} no es una espera`);
    }
  });
});

// ===================================================================================
describe('/v1/messages: la cuota agotada sale como 429 rate_limit_error', () => {
  it('no-streaming: HTTP 429 con la forma nativa de Anthropic', async () => {
    upstreamFactory = () => streamOf([quotaFrame()]);
    const res = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, res);

    assert.equal(res.statusCode, 429, 'la cuota agotada NO es un 500 api_error');
    assert.equal(res.body?.type, 'error');
    assert.equal(res.body?.error?.type, 'rate_limit_error');
    assert.match(String(res.body?.error?.message), /upper limit for today/i);
  });

  it('no-streaming: Retry-After solo cuando el upstream dio la espera', async () => {
    upstreamFactory = () => streamOf([quotaFrame({ num: 3 })]);
    const withWait = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, withWait);
    assert.equal(withWait.statusCode, 429);
    assert.equal(String(withWait.headers['Retry-After']), '10800', '3 h == 10800 s');

    upstreamFactory = () => streamOf([quotaFrame()]);
    const noWait = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, noWait);
    assert.equal(noWait.statusCode, 429);
    assert.equal(noWait.headers['Retry-After'], undefined, 'sin dato real, sin cabecera');
  });

  it('streaming: a media transmision sale el EVENTO de error, no un cierre pelado', async () => {
    // Aqui las cabeceras ya salieron (message_start se escribe antes de consumir el
    // upstream), asi que el status HTTP ya no se puede cambiar: el unico canal que le
    // queda al cliente para distinguir cuota de averia es el `type` del evento.
    upstreamFactory = () => streamOf([answerFrame('Voy a mirar'), quotaFrame()]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hola' }] }
    }, res);

    const events = sseEvents(res.output);
    const err = events.filter(e => e.event === 'error');
    assert.equal(err.length, 1, 'tiene que salir exactamente un evento de error');
    assert.equal(err[0].data?.error?.type, 'rate_limit_error', 'api_error miente: no es una averia');
    assert.match(String(err[0].data?.error?.message), /upper limit for today/i);
    assert.equal(res.writableEnded, true, 'el stream se cierra despues del evento');
  });

  it('regresion: un error que NO es de cuota sigue siendo 500 api_error', async () => {
    upstreamFactory = () => streamOf([
      frame({ success: false, data: { code: 'Bad_Request', details: 'algo se rompio' } })
    ]);
    const res = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.error?.type, 'api_error');
    assert.equal(res.headers['Retry-After'], undefined);
  });
});

// ===================================================================================
describe('/v1/chat/completions: la cuota agotada sale como 429 insufficient_quota', () => {
  it('no-streaming: HTTP 429 con la forma nativa de OpenAI', async () => {
    const res = jsonRes();
    await handleNonStreamResponse(
      res,
      streamOf([quotaFrame()]),
      false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] },
      {}
    );

    assert.equal(res.statusCode, 429, 'la cuota agotada NO es un 502 upstream_error');
    assert.equal(res.body?.error?.type, 'insufficient_quota');
    assert.match(String(res.body?.error?.message), /upper limit for today/i);
  });

  it('no-streaming: Retry-After solo cuando el upstream dio la espera', async () => {
    const withWait = jsonRes();
    await handleNonStreamResponse(
      withWait, streamOf([quotaFrame({ num: 1 })]), false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    assert.equal(withWait.statusCode, 429);
    assert.equal(String(withWait.headers['Retry-After']), '3600');

    const noWait = jsonRes();
    await handleNonStreamResponse(
      noWait, streamOf([quotaFrame()]), false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    assert.equal(noWait.statusCode, 429);
    assert.equal(noWait.headers['Retry-After'], undefined);
  });

  it('streaming antes de la primera cabecera: HTTP 429, no 502', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([quotaFrame()]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    assert.equal(res.statusCode, 429);
    const body = JSON.parse(res.output || '{}');
    assert.equal(body?.error?.type, 'insufficient_quota');
  });

  it('streaming: a media transmision sale el FRAME de error, no un cierre pelado', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([answerFrame('Voy a mirar'), quotaFrame()]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );

    const errs = sseFrames(res.output).filter(f => f && f.error);
    assert.equal(errs.length, 1, 'tiene que salir exactamente un frame de error');
    assert.equal(errs[0].error.type, 'insufficient_quota', 'upstream_stream_error miente');
    assert.match(String(errs[0].error.message), /upper limit for today/i);
    assert.match(res.output, /data: \[DONE\]/, 'el stream se cierra con DONE, no a lo bruto');
    assert.equal(res.writableEnded, true);
  });

  // El camino que USA Claude Code en esta API es el agentico (has_tools), no el llano:
  // handleStreamResponse/handleNonStreamResponse desvian a handleOpenAIAgent* en cuanto
  // `has_tools` esta puesto. runOpenAIAgentTurn no tiene un solo catch, asi que el throw
  // de assertNoUpstreamFailure sube limpio hasta el catch del controlador.
  const AGENT_OPTS = {
    has_tools: true,
    tool_choice: 'auto',
    allowed_tool_names: ['get_time'],
    agent_turn_max_attempts: 2
  };

  it('agentico no-streaming: HTTP 429 insufficient_quota', async () => {
    const res = jsonRes();
    await handleNonStreamResponse(
      res, streamOf([quotaFrame({ num: 4 })]), false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] }, AGENT_OPTS
    );
    assert.equal(res.statusCode, 429, 'el camino agentico es el que usa Claude Code');
    assert.equal(res.body?.error?.type, 'insufficient_quota');
    assert.match(String(res.body?.error?.message), /upper limit for today/i);
    assert.equal(String(res.headers['Retry-After']), '14400', '4 h == 14400 s');
  });

  it('agentico streaming: el 429 es INALCANZABLE, y por eso el frame carga la senal', async () => {
    // handleOpenAIAgentStream escribe el delta de apertura ({role:'assistant'}, chat.js:407)
    // ANTES de consumir el upstream, asi que cuando llega el paquete de cuota la respuesta
    // ya esta comprometida con 200 y el status HTTP no se puede cambiar. En este camino
    // —el que usa un cliente agentico con tools y stream— el `type` del frame es el UNICO
    // canal que queda. De ahi que arreglar el frame sea la mitad que de verdad sostiene
    // este camino, no un extra.
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([quotaFrame()]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] }, AGENT_OPTS
    );
    assert.equal(res.headersSent, true, 'el delta de apertura ya comprometio la respuesta');
    assert.equal(res.statusCode, 200, 'no se puede reescribir un status ya enviado');

    const errs = sseFrames(res.output).filter(f => f && f.error);
    assert.equal(errs.length, 1, 'tiene que salir exactamente un frame de error');
    assert.equal(errs[0].error.type, 'insufficient_quota');
    assert.match(String(errs[0].error.message), /upper limit for today/i);
    assert.match(res.output, /data: \[DONE\]/, 'cierre limpio, no un socket cortado');
    assert.equal(res.writableEnded, true);
  });

  it('regresion: el agotamiento de protocolo del gate sigue en 502, nunca 429', async () => {
    // Politica deliberada de openai-agent-runtime#exhaustedError, pinchada tambien en
    // tests/openai-agent-gate-429.test.js: un desacuerdo de protocolo no es un rate limit,
    // y anunciarlo como tal hace que el cliente reintente el turno entero.
    const res = streamRes();
    await handleStreamResponse(
      res,
      streamOf([answerFrame('Looks good.'), frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      false, false,
      { messages: [{ role: 'user', content: 'hola' }] },
      { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'], agent_turn_max_attempts: 2 }
    );
    assert.notEqual(res.statusCode, 429, 'un fallo de protocolo jamas se anuncia como rate limit');
  });

  it('regresion: un error que NO es de cuota sigue siendo 502 upstream_error', async () => {
    const res = jsonRes();
    await handleNonStreamResponse(
      res,
      streamOf([frame({ success: false, data: { code: 'Bad_Request', details: 'algo se rompio' } })]),
      false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body?.error?.type, 'upstream_error');
    assert.equal(res.headers['Retry-After'], undefined);
  });
});
