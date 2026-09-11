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
/** La cuenta que el upstream dice haber usado. Sin esto no hay a quien culpar del gasto. */
let upstreamAccount = null;
requestModule.sendChatRequest = async () => (upstreamFactory
  ? { status: true, response: upstreamFactory(), currentAccount: upstreamAccount }
  : { status: false });

const {
  UpstreamResponseError,
  assertNoUpstreamFailure,
  isRateLimitError,
  rateLimitRetryAfterSeconds
} = require('../src/utils/upstream-error.js');
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js');
const { handleStreamResponse, handleNonStreamResponse } = require('../src/controllers/chat.js');
const accountManager = require('../src/utils/account.js');
const AccountRotator = require('../src/utils/account-rotator.js');

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

  // OJO CON LA ATRIBUCION: Claude Code NO usa esta API. Habla /v1/messages (Anthropic);
  // las 149 negativas de cuota observadas en los logs del usuario salen todas de ahi.
  // Lo agentico de aqui es el camino de CUALQUIER cliente con tools sobre /v1/chat/
  // completions: handleStreamResponse/handleNonStreamResponse desvian a
  // handleOpenAIAgent* en cuanto `has_tools` esta puesto. runOpenAIAgentTurn no tiene
  // un solo catch, asi que el throw de assertNoUpstreamFailure sube limpio hasta el
  // catch del controlador.
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
    assert.equal(res.statusCode, 429, 'sin cabeceras enviadas, el status SI se puede fijar');
    assert.equal(res.body?.error?.type, 'insufficient_quota');
    assert.match(String(res.body?.error?.message), /upper limit for today/i);
    assert.equal(String(res.headers['Retry-After']), '14400', '4 h == 14400 s');
  });

  it('agentico streaming: el 429 es INALCANZABLE, y por eso el frame carga la senal', async () => {
    // handleOpenAIAgentStream escribe el delta de apertura ({role:'assistant'}, chat.js:407)
    // ANTES de consumir el upstream, asi que cuando llega el paquete de cuota la respuesta
    // ya esta comprometida con 200 y el status HTTP no se puede cambiar. Para un cliente
    // agentico con tools y stream el `type` del frame es el UNICO canal que queda. De ahi
    // que arreglar el frame sea la mitad que de verdad sostiene este camino, no un extra.
    // El gemelo de /v1/messages tiene la misma inalcanzabilidad, y por la misma razon:
    // ver 'MATRIZ DE ALCANZABILIDAD' mas abajo.
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

// ===================================================================================
// MATRIZ DE ALCANZABILIDAD — lo que el cliente recibe DE VERDAD, por camino y por fase.
//
// El commit original se titulaba "map ... to 429 on both API paths". Es falso para el
// unico modo que el usuario ejecuta. Claude Code habla /v1/messages con `stream: true`,
// y las 149 negativas de cuota de sus logs son TODAS "mid-stream". En ese modo el 429
// no existe: handleAnthropicStream fija las cabeceras (anthropic.js:1203) y escribe
// message_start (:1211) ANTES de leer un solo byte del upstream, asi que cuando el
// paquete de cuota llega `res.headersSent` ya es true y el catch del controlador
// (:2659) solo puede tomar la rama del evento.
//
//   camino                         fase                     status   senal
//   /v1/messages       stream:false  cabeceras aun libres    429      body.error.type
//   /v1/messages       stream:true   SIEMPRE comprometida    200      evento error.type
//   /v1/chat/... llano stream:false  cabeceras aun libres    429      body.error.type
//   /v1/chat/... llano stream:true   libre hasta el 1er byte 429      body.error.type
//   /v1/chat/... agente stream:true  SIEMPRE comprometida    200      frame error.type
//
// Estos casos clavan la fila que la frase original negaba. Que el 429 sea inalcanzable
// no es un defecto a tapar: adelantar las cabeceras es lo que permite mandar `ping`
// dentro del protocolo (anthropic.js:1156-1160), que es como se elimino el falso
// "stream muerto" del puente ccproxy. Lo que SI era un defecto es que, sin cabecera,
// la espera se perdia — eso se arregla abajo.
describe('/v1/messages en streaming: el 429 es inalcanzable y el evento es todo el canal', () => {
  it('con tools y la cuota como PRIMER frame: 200 comprometido, evento rate_limit_error', async () => {
    upstreamFactory = () => streamOf([quotaFrame()]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: {
        model: 'qwen3-max',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hola' }],
        tools: [{ name: 'get_time', description: 't', input_schema: { type: 'object', properties: {} } }]
      }
    }, res);

    assert.equal(res.headersSent, true, 'message_start ya comprometio la respuesta');
    assert.equal(res.statusCode, 200, 'el 429 NO es alcanzable en el modo que usa Claude Code');

    const events = sseEvents(res.output);
    assert.equal(events[0]?.event, 'message_start', 'las cabeceras salen antes que el upstream');
    const err = events.filter(e => e.event === 'error');
    assert.equal(err.length, 1);
    assert.equal(err[0].data?.error?.type, 'rate_limit_error', 'el type es el unico canal que queda');
    assert.equal(res.headers['Retry-After'], undefined, 'ya no hay cabecera que poner');
  });

  it('la espera del upstream viaja DENTRO del evento, que es donde el cliente puede verla', async () => {
    // Si el evento es el unico canal, tiene que cargar todo lo que la cabecera ya no
    // puede llevar. `data.num` viene en HORAS (misma lectura que chat.image.video.js:88).
    upstreamFactory = () => streamOf([quotaFrame({ num: 3 })]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hola' }] }
    }, res);

    const err = sseEvents(res.output).filter(e => e.event === 'error');
    assert.equal(err.length, 1);
    assert.equal(err[0].data?.error?.retry_after, 10800, '3 h == 10800 s, dentro del evento');
  });

  it('sin espera real el evento no se inventa ninguna', async () => {
    upstreamFactory = () => streamOf([quotaFrame()]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hola' }] }
    }, res);

    const err = sseEvents(res.output).filter(e => e.event === 'error');
    assert.equal(err.length, 1);
    assert.equal('retry_after' in (err[0].data?.error || {}), false, 'sin dato real, sin campo');
  });

  it('un fallo que NO es de cuota jamas lleva retry_after en el evento', async () => {
    upstreamFactory = () => streamOf([
      answerFrame('Voy a mirar'),
      frame({ success: false, data: { code: 'Bad_Request', details: 'algo se rompio', num: 9 } })
    ]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hola' }] }
    }, res);

    const err = sseEvents(res.output).filter(e => e.event === 'error');
    assert.equal(err.length, 1);
    assert.equal(err[0].data?.error?.type, 'api_error');
    assert.equal('retry_after' in (err[0].data?.error || {}), false, 'una averia no se espera, se reintenta');
  });
});

// ===================================================================================
describe('/v1/chat/completions en streaming: el frame carga la misma espera (gemelo)', () => {
  it('llano: el frame de error lleva retry_after cuando el upstream dio la espera', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([answerFrame('Voy a mirar'), quotaFrame({ num: 2 })]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    const errs = sseFrames(res.output).filter(f => f && f.error);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].error.retry_after, 7200, '2 h == 7200 s, dentro del frame');
  });

  it('agentico: el frame de error lleva retry_after — aqui el 429 no existe', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([quotaFrame({ num: 5 })]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] },
      { has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'], agent_turn_max_attempts: 2 }
    );
    assert.equal(res.statusCode, 200, 'el delta de apertura ya comprometio la respuesta');
    const errs = sseFrames(res.output).filter(f => f && f.error);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].error.retry_after, 18000, '5 h == 18000 s');
  });

  it('un fallo que NO es de cuota no lleva retry_after en el frame', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([answerFrame('Voy a mirar'), frame({ success: false, data: { code: 'Bad_Request', details: 'roto', num: 9 } })]),
      false, false, { messages: [{ role: 'user', content: 'hola' }] }, {}
    );
    const errs = sseFrames(res.output).filter(f => f && f.error);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].error.type, 'upstream_stream_error');
    assert.equal('retry_after' in errs[0].error, false);
  });
});

// ===================================================================================
// EL BUCLE QUE QUEMA EL POOL. El commit original se justificaba diciendo que sin 429
// "el cliente reintenta contra un muro y quema otra cuenta del pool en cada vuelta",
// y despues no tocaba nada del lado del servidor: los HTTP 4xx/5xx van a recordError
// (account-rotator.js:125-128), que por diseno NO enfria. La cuota agotada no es un
// fallo de transporte ni un rechazo puntual: esa cuenta esta muerta hasta que Qwen
// reinicie el dia, y volver a elegirla es gastar una vuelta entera para nada.
describe('el pool: una cuenta sin cuota sale del sorteo', () => {
  const accounts = [
    { email: 'a@x.io', token: 'ta' },
    { email: 'b@x.io', token: 'tb' }
  ];

  it('recordQuotaExhausted saca la cuenta del sorteo; recordError no lo hacia', () => {
    const rot = new AccountRotator();
    rot.setAccounts(accounts);

    rot.recordError('a@x.io', 429);
    assert.equal(rot.getStats().available, 2, 'recordError no enfria — politica deliberada, sin cambios');

    rot.recordQuotaExhausted('a@x.io', null);
    assert.equal(rot.getStats().available, 1, 'la cuenta sin cuota ya no cuenta como disponible');
    for (let i = 0; i < 6; i++) {
      assert.equal(rot.getNextAccount().email, 'b@x.io', 'el sorteo no vuelve a la cuenta muerta');
    }
  });

  it('la espera real del upstream fija el final del enfriamiento', () => {
    const rot = new AccountRotator();
    rot.setAccounts(accounts);
    const before = Date.now();
    rot.recordQuotaExhausted('a@x.io', 3600);
    const ends = rot.getStats().usageStats['a@x.io'].quotaCooldownEndsAt;
    assert.ok(ends >= before + 3600 * 1000, 'una hora de espera == una hora fuera');
    assert.ok(ends <= Date.now() + 3600 * 1000 + 5000);
  });

  it('sin espera del upstream se usa el enfriamiento por defecto, no cero', () => {
    const rot = new AccountRotator();
    rot.setAccounts(accounts);
    rot.recordQuotaExhausted('a@x.io', null);
    const ends = rot.getStats().usageStats['a@x.io'].quotaCooldownEndsAt;
    assert.ok(ends > Date.now() + 60 * 1000, 'un defecto de segundos volveria al bucle enseguida');
  });

  it('el enfriamiento caduca solo: pasada la espera la cuenta vuelve', () => {
    const rot = new AccountRotator();
    rot.setAccounts(accounts);
    rot.quotaCooldownPeriod = 5;
    rot.recordQuotaExhausted('a@x.io', null);
    assert.equal(rot.getStats().available, 1);
    return new Promise(resolve => setTimeout(() => {
      assert.equal(rot.getStats().available, 2, 'la cuota vuelve; el destierro no es permanente');
      resolve();
    }, 25));
  });

  it('el refresco periodico de token NO revive una cuenta sin cuota', () => {
    // account.js:516 llama resetFailures en CADA refresco exitoso, para todas las cuentas
    // y por temporizador. Si eso limpiara el enfriamiento de cuota, el destierro duraria
    // hasta el siguiente tic y el bucle volveria solo.
    const rot = new AccountRotator();
    rot.setAccounts(accounts);
    rot.recordQuotaExhausted('a@x.io', null);
    rot.resetFailures('a@x.io');
    assert.equal(rot.getStats().available, 1, 'la cuota no se arregla reseteando contadores');
  });

  it('el dashboard no puede pintar como activa una cuenta que el sorteo esta ignorando', () => {
    // getAccountCliState deriva `kind` de cooldownEndsAt, que solo lo pone el contador de
    // fallos. Sin esto una cuenta desterrada por cuota sale como `warn` 15 minutos y
    // `active` despues, mientras la rotacion lleva una hora saltandosela: el operador ve
    // un pool sano y una capacidad que no existe.
    const { getAccountCliState } = require('../src/utils/cli-support.js');
    const now = Date.now();
    const state = getAccountCliState(
      { email: 'a@x.io' },
      { quotaCooldownEndsAt: now + 3600 * 1000, lastErrorAt: now, lastErrorCode: 'RateLimited' },
      now
    );
    assert.equal(state.status.kind, 'cooldown', 'esta fuera del sorteo: dilo');
    assert.equal(state.status.cooldownEndsAt, now + 3600 * 1000, 'y con la cuenta atras de verdad');

    // El enfriamiento por fallos manda si termina mas tarde que el de cuota.
    const later = getAccountCliState(
      { email: 'a@x.io' },
      { quotaCooldownEndsAt: now + 1000, cooldownEndsAt: now + 60000 },
      now
    );
    assert.equal(later.status.cooldownEndsAt, now + 60000, 'gana el que libera mas tarde');
  });

  it('reset() y el borrado de cuentas limpian tambien el estado de cuota', () => {
    const rot = new AccountRotator();
    rot.setAccounts(accounts);
    rot.recordQuotaExhausted('a@x.io', null);
    rot.reset();
    assert.equal(rot.getStats().available, 2);

    rot.recordQuotaExhausted('a@x.io', null);
    rot.setAccounts([{ email: 'b@x.io', token: 'tb' }]);
    rot.setAccounts(accounts);
    assert.equal(rot.getStats().available, 2, 'el registro de una cuenta que se fue no puede sobrevivir');
  });
});

// ===================================================================================
describe('el pool: los dos controladores denuncian la cuenta que se quedo sin cuota', () => {
  let seen = [];
  const original = accountManager.recordAccountQuotaExhausted;

  test.beforeEach(() => {
    seen = [];
    accountManager.recordAccountQuotaExhausted = (email, secs) => { seen.push({ email, secs }); };
  });
  test.afterEach(() => {
    accountManager.recordAccountQuotaExhausted = original;
    upstreamAccount = null;
  });

  it('/v1/messages en streaming: la cuenta gastada queda marcada', async () => {
    upstreamAccount = { email: 'burned@x.io', token: 't' };
    upstreamFactory = () => streamOf([quotaFrame({ num: 2 })]);
    const res = streamRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hola' }] }
    }, res);
    assert.deepEqual(seen, [{ email: 'burned@x.io', secs: 7200 }]);
  });

  it('/v1/messages sin streaming: mismo aviso', async () => {
    upstreamAccount = { email: 'burned@x.io', token: 't' };
    upstreamFactory = () => streamOf([quotaFrame()]);
    const res = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, res);
    assert.deepEqual(seen, [{ email: 'burned@x.io', secs: null }]);
  });

  it('/v1/chat/completions en streaming: gemelo', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([quotaFrame({ num: 1 })]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] },
      { currentAccount: { email: 'burned@x.io', token: 't' } }
    );
    assert.deepEqual(seen, [{ email: 'burned@x.io', secs: 3600 }]);
  });

  it('/v1/chat/completions agentico en streaming: gemelo', async () => {
    const res = streamRes();
    await handleStreamResponse(
      res, streamOf([quotaFrame()]), false, false,
      { messages: [{ role: 'user', content: 'hola' }] },
      {
        currentAccount: { email: 'burned@x.io', token: 't' },
        has_tools: true, tool_choice: 'auto', allowed_tool_names: ['get_time'], agent_turn_max_attempts: 2
      }
    );
    assert.deepEqual(seen, [{ email: 'burned@x.io', secs: null }]);
  });

  it('/v1/chat/completions sin streaming: gemelo', async () => {
    const res = jsonRes();
    await handleNonStreamResponse(
      res, streamOf([quotaFrame()]), false, false, 'qwen3-max',
      { messages: [{ role: 'user', content: 'hola' }] },
      { currentAccount: { email: 'burned@x.io', token: 't' } }
    );
    assert.deepEqual(seen, [{ email: 'burned@x.io', secs: null }]);
  });

  it('un fallo que NO es de cuota no marca a nadie', async () => {
    upstreamAccount = { email: 'innocent@x.io', token: 't' };
    upstreamFactory = () => streamOf([frame({ success: false, data: { code: 'Bad_Request', details: 'roto' } })]);
    const res = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(seen, [], 'una averia del upstream no deja sin cuota a la cuenta');
  });

  it('sin cuenta conocida no se marca nada, y no se rompe nada', async () => {
    upstreamAccount = null;
    upstreamFactory = () => streamOf([quotaFrame()]);
    const res = jsonRes();
    await handleAnthropicMessages({
      body: { model: 'qwen3-max', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hola' }] }
    }, res);
    assert.equal(res.statusCode, 429, 'la respuesta al cliente no depende de conocer la cuenta');
    assert.deepEqual(seen, []);
  });
});

// ===================================================================================
// MATERIAL REAL. Las cuatro cadenas de abajo son las unicas cuatro clases de
// "Upstream error" que aparecen en los transcripts del usuario, contadas asi:
//   grep -rhon "Upstream error" ~/.claude/projects | ... | sort | uniq -c
//     149  Upstream error mid-stream: N You've reached the upper limit for today's usage.
//      53  ... 上游连续返回残缺、非法或不存在的工具调用
//      32  ... Qwen 网页上游触发 WAF/captcha
//      28  ... 上游连续返回未声明完成状态的文本
// Una sola es cuota. Si el clasificador se ensancha y se traga otra, el cliente
// dejaria de reintentar un fallo que SI se arregla reintentando.
describe('material real: las 4 clases de fallo de los logs del usuario', () => {
  const REAL = {
    quota: "You've reached the upper limit for today's usage.",
    tools: '上游连续返回残缺、非法或不存在的工具调用，已阻止交付',
    waf: 'Qwen 网页上游触发 WAF/captcha；Agent 上下文可能过大或账号需要验证',
    unfinished: '上游连续返回未声明完成状态的文本，已阻止 Agent 将其当成答案交付'
  };

  it('solo la linea de cuota clasifica como cuota', () => {
    assert.equal(isRateLimitError(new UpstreamResponseError(REAL.quota, 'upstream_business_error')), true);
    for (const [name, text] of Object.entries(REAL)) {
      if (name === 'quota') continue;
      assert.equal(
        isRateLimitError(new UpstreamResponseError(text, 'upstream_agent_turn_incomplete')),
        false,
        `${name} no es cuota: reintentar SI lo arregla`
      );
    }
  });

  it('los dos canales del paquete real llevan a la misma clasificacion', () => {
    // Canal A: `data.code`. Canal B: solo el texto (el code no siempre viene).
    let byCode = null;
    try { assertNoUpstreamFailure({ success: false, data: { code: 'RateLimited', details: 'otro texto' } }); } catch (e) { byCode = e; }
    assert.equal(isRateLimitError(byCode), true, 'canal A: data.code');

    let byText = null;
    try { assertNoUpstreamFailure({ success: false, data: { details: REAL.quota } }); } catch (e) { byText = e; }
    assert.equal(isRateLimitError(byText), true, 'canal B: el texto que vio el usuario');
  });
});
