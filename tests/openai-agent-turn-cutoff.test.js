// Spec agent-turn-cutoff-openai-parity (2026-09-06): el corte por fuga del canal de texto
// y las puertas de schema llegan a /v1/chat/completions.
//
// Antes de este spec el runtime de OpenAI bufferizaba el turno entero hasta EOF sin ninguna
// guarda: un bucle narrado de [TOOL CALL] (cientos de repeticiones, o una sesion agentica
// alucinada — streams de 6-60 min vistos en el camino Anthropic el 2026-09-03..06) se
// consumia hasta el final, el evaluador lo rechazaba porque venia prosa detras, y se
// reintentaba hasta 6 veces: nunca cortado, nunca entregado. Y como este camino jamas pasaba
// toolSchemas, la aceptacion-tras-prosa y la reparacion de comillas internas de
// tool-prompt.js eran letra muerta aqui.
//
// Aqui se pinan los dos lados: la ronda que hoy termina en reintentos/422 ahora se entrega
// como finish_reason=tool_calls, y el upstream se destruye en el frame que dispara la regla.
//
// Harness: recordingUpstream / captureWarns / scriptedSender copiados de
// tests/anthropic-narrated-toolcall.test.js — cada archivo de test corre en su propio proceso.

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Sin red en tests: mismos parches de require-cache que el resto de la suite.
const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };
const requestModule = require('../src/utils/request.js');
// chat.js captura sendChatRequest por destructuring en su primer require, asi que el parche
// va ANTES de requerirlo y se mantiene mutable: null = "sin upstream" (lo que esperan los
// tests que inyectan el handler directamente); una factoria = el upstream del test de cableado.
let wiringUpstream = null;
requestModule.sendChatRequest = async () => (wiringUpstream
  ? { status: true, response: wiringUpstream(), currentAccount: null }
  : { status: false });

const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime.js');
const {
  handleStreamResponse,
  handleNonStreamResponse,
  handleChatCompletion
} = require('../src/controllers/chat.js');
const { processRequestBody } = require('../src/middlewares/chat-middleware.js');
const config = require('../src/config/index.js');
const { logger } = require('../src/utils/logger.js');

test.after(() => {
  require('../src/utils/account.js').destroy();
});

// ─────────────────────────── harness ───────────────────────────

const createMockResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers) { Object.assign(this.headers, headers); return this; },
  setHeader(name, value) { this.headers[name] = value; },
  write(chunk) { this.headersSent = true; this.output += String(chunk); return true; },
  end(chunk = '') { if (chunk) this.write(chunk); this.writableEnded = true; },
  status(code) { this.statusCode = code; return this; },
  json(value) {
    this.headersSent = true;
    this.output += JSON.stringify(value);
    this.writableEnded = true;
    return this;
  }
});

/**
 * Spy sobre logger.warn (el metodo REAL — logger.warning no existe en el singleton).
 * Registra tambien el modulo: el tag es un parametro de la guarda compartida desde la
 * extraccion, y sin observarlo cambiarlo a 'ANTHROPIC' dejaria la suite verde.
 */
const captureWarns = async (fn) => {
  const saved = logger.warn;
  const entries = [];
  logger.warn = (message, module) => { entries.push({ message: String(message), module }); };
  try {
    await fn();
  } finally {
    logger.warn = saved;
  }
  return entries;
};

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;

const thinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`;

/** Snapshot nativo de function_call (sin function_id, answer phase = candidato de cliente). */
const nativeFrame = (name, snapshot) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      phase: 'answer',
      content: '',
      function_call: { name, arguments: snapshot },
      extra: { display_position: 'answer' }
    },
    finish_reason: null
  }]
})}\n\n`;

/** Frame de resultado del propio Qwen: cierra la llamada nativa abierta. */
const nativeResultFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', content: `Tool ${name} does not exists.`, phase: 'answer', status: 'typing', name },
    finish_reason: null
  }]
})}\n\n`;

const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/**
 * Upstream que registra cada frame que el consumidor le PIDE. Se entrega el generador crudo
 * (consumeSSEStream solo necesita Symbol.asyncIterator): Readable.from precargaria hasta
 * highWaterMark objetos y served[] mentiria — un corte no se puede probar con Readable.from.
 */
const recordingUpstream = (frames) => {
  const served = [];
  async function* gen() {
    for (const frame of frames) {
      served.push(frame);
      yield frame;
    }
  }
  return { served, stream: gen() };
};

const scriptedSender = (...turns) => {
  const fn = async (body) => {
    fn.calls.push(body);
    const next = fn.queue.shift();
    return next ? { status: true, response: next() } : { status: false };
  };
  fn.calls = [];
  fn.queue = [...turns];
  return fn;
};

const turnOf = (...frames) => () => recordingUpstream([...frames, STOP]).stream;

const ALLOWED = ['Read', 'Bash', 'Edit'];
const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  Edit: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
};

const call = (name, args) => `[TOOL CALL]${JSON.stringify({ name, arguments: args })}[END TOOL CALL]`;
const readCall = (file) => call('Read', { file_path: file });

const baseOptions = (sendChatRequest, overrides = {}) => ({
  has_tools: true,
  tool_choice: 'auto',
  allowed_tool_names: ALLOWED,
  tool_schemas: SCHEMAS,
  agent_turn_max_attempts: 3,
  upstream_request_body: { messages: [{ role: 'user', content: 'do the task' }] },
  sendChatRequest,
  ...overrides
});

/** runOpenAIAgentTurn directo, con upstream registrador y captura de warns. */
const runTurnRecorded = async (frames, sender, overrides = {}) => {
  const { served, stream } = recordingUpstream([...frames, STOP]);
  let result;
  const warns = await captureWarns(async () => {
    result = await runOpenAIAgentTurn(stream, baseOptions(sender, overrides));
  });
  return { result, served, warns, total: frames.length + 1 };
};

const cutWarns = (warns) => warns.filter(entry => /失控信号/.test(entry.message));
const ruleOf = (warns) => {
  const entry = cutWarns(warns)[0];
  const matched = entry && entry.message.match(/失控信号 \(([a-z]+)\)/);
  return matched ? matched[1] : null;
};

/** Deltas del stream OpenAI, en orden. */
const deltasOf = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map(chunk => chunk.replace(/^data: /, ''))
  .filter(payload => payload && payload !== '[DONE]')
  .map(payload => JSON.parse(payload));

const streamToolCalls = (output) => {
  const byIndex = new Map();
  for (const event of deltasOf(output)) {
    for (const piece of event.choices?.[0]?.delta?.tool_calls || []) {
      const entry = byIndex.get(piece.index) || { name: null, args: '' };
      if (piece.function?.name) entry.name = piece.function.name;
      entry.args += piece.function?.arguments || '';
      byIndex.set(piece.index, entry);
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
};

const streamFinishReason = (output) => {
  for (const event of deltasOf(output)) {
    const reason = event.choices?.[0]?.finish_reason;
    if (reason) return reason;
  }
  return null;
};

const streamContent = (output) => deltasOf(output)
  .map(event => event.choices?.[0]?.delta?.content || '')
  .join('');

const streamReasoning = (output) => deltasOf(output)
  .map(event => event.choices?.[0]?.delta?.reasoning_content || '')
  .join('');

// `enableThinking` es load-bearing: chat.js solo crea onReasoningDelta (y con el, el parser
// de streaming del canal de pensamiento) cuando el thinking esta activo.
const runStreamRecorded = async (frames, sender, overrides = {}, enableThinking = false) => {
  const { served, stream } = recordingUpstream([...frames, STOP]);
  const res = createMockResponse();
  const warns = await captureWarns(async () => {
    await handleStreamResponse(res, stream, enableThinking, false, { messages: [] }, baseOptions(sender, overrides));
  });
  return { res, served, warns, total: frames.length + 1 };
};

const runNonStreamRecorded = async (frames, sender, overrides = {}) => {
  const { served, stream } = recordingUpstream([...frames, STOP]);
  const res = createMockResponse();
  const warns = await captureWarns(async () => {
    await handleNonStreamResponse(
      res, stream, false, false, 'qwen-test', { messages: [] }, baseOptions(sender, overrides)
    );
  });
  return { res, served, warns, total: frames.length + 1 };
};

const bodyOf = (res) => JSON.parse(res.output);

// ─────────────────── matriz de la spec: reglas del corte ───────────────────

describe('OpenAI text-channel runaway cut-off (runOpenAIAgentTurn)', () => {
  it('legit parallel batch: 5 distinct calls, whole upstream consumed, no cut', async () => {
    const sender = scriptedSender();
    const frames = ['a', 'b', 'c', 'd', 'e'].map((file, i) =>
      answerFrame(`${i ? '\n\n' : ''}${readCall(file)}`));
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.attempt.toolCalls.map(c => c.function.name), Array(5).fill('Read'));
    assert.deepEqual(
      result.attempt.toolCalls.map(c => JSON.parse(c.function.arguments).file_path),
      ['a', 'b', 'c', 'd', 'e']
    );
    assert.equal(served.length, total, 'el upstream se consume entero');
    assert.deepEqual(cutWarns(warns), [], 'ningun corte');
    assert.equal(sender.calls.length, 0, 'ningun reintento');
  });

  it('repeat loop: byte-identical repeat cuts on that frame, 200 later frames never served', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 200 }, (_, i) => answerFrame(`\n\nnarration ${i}`))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1);
    assert.equal(result.attempt.toolCalls[0].function.name, 'Read');
    assert.ok(served.length < total, `el upstream se destruyo (${served.length}/${total})`);
    assert.equal(served.length, 2, 'se corta en el frame duplicado');
    assert.equal(cutWarns(warns).length, 1, 'exactamente un warn de corte');
    assert.equal(ruleOf(warns), 'duplicate');
    assert.equal(sender.calls.length, 0, 'sendChatRequest jamas se llama');
  });

  it('rejected after admitted: a not-allowed call after an admitted one cuts, no retry, no toolErrors', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame(`\n\n${call('WebSearch', { query: 'x' })}`),
      ...Array.from({ length: 20 }, () => answerFrame('\n\nmore narration'))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1);
    assert.deepEqual(result.attempt.toolErrors, [], 'el span rechazado no aporta toolErrors');
    assert.ok(served.length < total);
    assert.equal(ruleOf(warns), 'rejected');
    assert.equal(sender.calls.length, 0);
  });

  it('prose after call: cuts on the prose frame, no post-call text anywhere', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame('\n\nNow I will read the next file and summarise everything for you.'),
      thinkFrame('Let me keep going.'),
      ...Array.from({ length: 50 }, () => answerFrame('\n\nrunaway'))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1);
    assert.equal(result.attempt.visibleText.trim(), '', 'nada de prosa post-llamada');
    assert.doesNotMatch(result.attempt.visibleText, /Now I will/);
    assert.ok(served.length < total);
    assert.equal(served.length, 2);
    assert.equal(ruleOf(warns), 'prose');
  });

  it('think after call: cuts on the think frame, reasoning unchanged', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      thinkFrame('Let me now narrate a whole agentic session.'),
      ...Array.from({ length: 50 }, () => answerFrame('\n\nrunaway'))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1);
    assert.equal(result.attempt.reasoning, '', 'el think posterior no entra en reasoning');
    assert.ok(served.length < total);
    assert.equal(served.length, 2);
    assert.equal(ruleOf(warns), 'think');
  });

  it('cap: 30 distinct calls back-to-back → exactly 24 delivered, warn names the cap', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => answerFrame(`${i ? '\n\n' : ''}${readCall(`f${i}`)}`));
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 24, 'exactamente agentTurnMaxToolCalls');
    assert.equal(config.agentTurnMaxToolCalls, 24, 'el default del config es el que se prueba');
    assert.deepEqual(
      result.attempt.toolCalls.map(c => JSON.parse(c.function.arguments).file_path),
      Array.from({ length: 24 }, (_, i) => `f${i}`),
      'se entregan las 24 primeras, la que toca el cap incluida'
    );
    assert.ok(served.length < total);
    assert.equal(ruleOf(warns), 'cap');
    assert.match(cutWarns(warns)[0].message, /24\/24/);
  });

  it('cap has no arming gate: 30 complete calls inside ONE delta still deliver only 24', async () => {
    const sender = scriptedSender();
    const single = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`)).join('\n\n');
    const { result, warns } = await runTurnRecorded([answerFrame(single)], sender);

    assert.equal(result.ok, true);
    assert.equal(result.attempt.toolCalls.length, 24);
    assert.equal(ruleOf(warns), 'cap');
  });

  it('same-push text before a call is pre-call prose, not a runaway (guard arms on the NEXT push)', async () => {
    const sender = scriptedSender();
    // Prosa + llamada en el MISMO delta: sin armar todavia → no hay corte. El gate estricto
    // sigue rechazando prosa+tools (comportamiento de hoy, intacto), asi que se reintenta.
    const frames = [answerFrame(`Reading the file:\n${readCall('a')}`)];
    const { warns } = await runTurnRecorded(frames, sender);
    assert.deepEqual(cutWarns(warns), [], 'la prosa previa a la llamada no corta');
  });

  it('whitespace-only deltas between back-to-back calls never trigger a cut', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame('\n\n'),
      answerFrame(readCall('b')),
      answerFrame('   '),
      answerFrame(readCall('c'))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.attempt.toolCalls.length, 3);
    assert.deepEqual(cutWarns(warns), []);
    assert.equal(served.length, total, 'sin corte, el upstream se consume entero');
  });

  // P1 (review): una ronda cortada NO puede arrastrar errores del parser de pushes
  // ANTERIORES. evaluateOpenAIAgentAttempt mira `toolErrors.length > 0` antes que
  // `toolCalls.length > 0`, asi que un error superviviente reintentaba la ronda y relanzaba
  // la fuga que el corte acababa de detener, hasta 502. Paridad con anthropic.js:1080/:1749.
  it('an earlier parse error does NOT re-arm the retry loop on a cut round', async () => {
    const sender = scriptedSender();
    // Clave sin comillas + comillas internas: ninguna de las dos reparaciones lo salva →
    // invalid_json en el push 1 (sin armar todavia, no corta).
    const broken = '[TOOL CALL]{"name":"Bash","arguments":{command:"echo "hi" x"}}[END TOOL CALL]';
    const frames = [
      answerFrame(broken),
      answerFrame(`\n\n${readCall('a')}`),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 50 }, () => answerFrame('\n\nrunaway'))
    ];
    const { result, served, warns, total } = await runTurnRecorded(frames, sender);

    assert.equal(ruleOf(warns), 'duplicate', 'el corte si se dispara');
    assert.equal(result.ok, true, 'y la ronda se ENTREGA en vez de reintentarse');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1, 'la llamada admitida no se descarta');
    assert.deepEqual(result.attempt.toolErrors, [], 'ningun error del parser sale a flote');
    assert.equal(result.attempts, 1);
    assert.equal(sender.calls.length, 0, 'sendChatRequest jamas se llama');
    assert.ok(served.length < total);
  });

  // P2 (review): tras un corte por regla NO-cap, inspectCall deja de devolver reglas
  // (incluida 'cap'), asi que el drenaje del push disparador se saltaba el tope: un solo
  // delta con 40 llamadas mas entregaba 41 contra un cap de 24.
  it('the cap still binds while draining the push that triggered a non-cap cut', async () => {
    const sender = scriptedSender();
    const runaway = [
      readCall('a'),                                                    // duplicado → corta
      ...Array.from({ length: 40 }, (_, i) => readCall(`extra${i}`))    // drenaje del push
    ].join('\n\n');
    const frames = [answerFrame(readCall('a')), answerFrame(`\n\n${runaway}`)];
    const { result, warns } = await runTurnRecorded(frames, sender);

    assert.equal(ruleOf(warns), 'duplicate');
    assert.equal(cutWarns(warns).length, 1, 'exactamente un warn de corte');
    assert.ok(
      result.attempt.toolCalls.length <= 24,
      `nunca por encima del cap (entregadas: ${result.attempt.toolCalls.length})`
    );
    assert.equal(result.attempt.toolCalls.length, 24);
    assert.equal(result.finishReason, 'tool_calls');
  });

  // P7(b) — REVERTIDO 2026-09-06 tras incidente en qwen-next (gate estricto): la version
  // original exigia que la puerta prosa+tools siguiera rechazando la ronda cortada. En vivo
  // eso reintenta la fuga recien detenida sobre el mismo chat_id abortado → CHAT_IN_PROGRESS
  // → 502, y contradice la promesa de settledTextRound y la paridad Anthropic
  // (decideRetryReason entrega en cuanto hubo llamadas). Ahora: la prosa previa se conserva
  // en visibleText, la ronda SE ENTREGA, y con gate estricto la prosa se suprime en el wire.
  it('pre-call prose survives a cut; the strict prose-with-tools gate delivers (prose suppressed) instead of rejecting', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(`Let me check that file.\n${readCall('a')}`),
      answerFrame(`\n\n${readCall('a')}`)
    ];
    const { result, warns } = await runTurnRecorded(frames, sender, { agent_turn_max_attempts: 2 });

    assert.equal(ruleOf(warns), 'duplicate', 'el corte se dispara');
    assert.match(result.attempt.visibleText, /Let me check that file/, 'la prosa previa se conserva');
    assert.equal(result.ok, true, 'la ronda cortada con llamadas admitidas SIEMPRE se entrega');
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.suppressVisibleText, true, 'con gate estricto la prosa no viaja al cliente');
    assert.equal(result.attempt.toolCalls.length, 1);
    assert.equal(sender.calls.length, 0, 'sin reintento sobre el chat abortado');
  });

  // P7(c): el tag del warn es un parametro de la guarda compartida desde la extraccion.
  it('the cut warn is tagged AGENT, not ANTHROPIC', async () => {
    const sender = scriptedSender();
    const frames = [answerFrame(readCall('a')), answerFrame(`\n\n${readCall('a')}`)];
    const { warns } = await runTurnRecorded(frames, sender);

    const cut = cutWarns(warns);
    assert.equal(cut.length, 1);
    assert.equal(cut[0].module, 'AGENT', 'el modulo del warn de corte');
    for (const entry of warns) {
      assert.notEqual(entry.module, 'ANTHROPIC', 'ningun warn de este camino lleva el tag Anthropic');
    }
  });

  it('cross-channel copy: native Bash + the same Bash narrated → 1 tool_call, no text cut', async () => {
    const sender = scriptedSender();
    const args = JSON.stringify({ command: 'ls' });
    const frames = [
      answerFrame(call('Bash', { command: 'ls' })),
      nativeFrame('Bash', args),
      nativeResultFrame('Bash')
    ];
    const { result, warns } = await runTurnRecorded(frames, sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(result.attempt.toolCalls.length, 1, 'precedencia nativa, una sola llamada');
    assert.equal(result.attempt.nativeToolCalls.length, 1);
    assert.deepEqual(cutWarns(warns), [], 'la copia cruzada no es senal de fuga');
  });

  // P4 (review): la puerta de argumentos del acumulador NATIVO tambien vive de los schemas
  // (anthropic.js los pasa en sus tres sitios). Sin ellos, un function_call al que le falta
  // una clave required se promovia al cliente sin un solo error.
  it('native call missing a required key is NOT promoted; valid args are', async () => {
    const sender = scriptedSender();
    const bad = await runTurnRecorded(
      [nativeFrame('Read', '{"wrong_key":"x"}'), nativeResultFrame('Read')],
      sender,
      { agent_turn_max_attempts: 2 }
    );
    assert.deepEqual(bad.result.attempt.nativeToolCalls, [], 'no se promueve');
    assert.deepEqual(bad.result.attempt.toolCalls, [], 'no llega al cliente');

    const good = await runTurnRecorded(
      [nativeFrame('Read', '{"file_path":"a"}'), nativeResultFrame('Read')],
      scriptedSender()
    );
    assert.equal(good.result.ok, true);
    assert.deepEqual(good.result.attempt.toolCalls.map(c => c.function.name), ['Read']);
  });
});

// ─────────────────── aislamiento por attempt (AC de la spec) ───────────────────

// ─────────────── gate estricto: la ronda cortada se entrega igual ───────────────
// Incidente qwen-next 2026-09-06 20:29 (staging SIN AGENT_TURN_ALLOW_PROSE_WITH_TOOLS, a
// diferencia de prod): el modelo narró antes de la llamada, la guarda cortó por duplicado y
// la puerta rechazó la ronda por "prosa+tools" → reintento sobre el mismo chat_id cuya
// generación abortada seguía viva en Qwen → CHAT_IN_PROGRESS → 502. La promesa de
// settledTextRound ("una ronda cortada con llamadas admitidas SIEMPRE se entrega") tiene que
// valer con cualquier valor de la flag.
describe('cut round under strict gate (AGENT_TURN_ALLOW_PROSE_WITH_TOOLS unset)', () => {
  const withProseFlag = async (value, fn) => {
    const prev = config.agentTurnAllowProseWithTools;
    config.agentTurnAllowProseWithTools = value;
    try { return await fn(); } finally { config.agentTurnAllowProseWithTools = prev; }
  };
  const narratedDuplicate = () => [
    answerFrame(`Voy a leer el archivo primero.\n\n${readCall('a')}`),
    answerFrame(`\n\n${readCall('a')}`),
    ...Array.from({ length: 30 }, (_, i) => answerFrame(`\n\nnarration ${i}`))
  ];

  it('runtime: prose before the call + duplicate cut → tool_calls, prose suppressed, no retry', async () => {
    await withProseFlag(false, async () => {
      const sender = scriptedSender();
      const { result, served, warns } = await runTurnRecorded(narratedDuplicate(), sender);
      assert.equal(result.ok, true, JSON.stringify(result.error || null));
      assert.equal(result.finishReason, 'tool_calls');
      assert.equal(result.attempt.toolCalls.length, 1);
      assert.equal(result.attempt.textChannelCut, true);
      assert.equal(result.suppressVisibleText, true, 'con gate estricto la narración no se entrega');
      assert.equal(served.length, 2, 'se corta en el duplicado');
      assert.equal(ruleOf(warns), 'duplicate');
      assert.equal(sender.calls.length, 0, 'sin reintento: ningún segundo POST al chat abortado');
    });
  });

  it('non-stream wire: 200 with tool_calls and empty content (was 502 CHAT_IN_PROGRESS)', async () => {
    await withProseFlag(false, async () => {
      const sender = scriptedSender();
      const { res } = await runNonStreamRecorded(narratedDuplicate(), sender);
      assert.equal(res.statusCode, 200, res.output);
      const body = bodyOf(res);
      assert.equal(body.choices[0].finish_reason, 'tool_calls');
      assert.equal(body.choices[0].message.tool_calls.length, 1);
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Read');
      assert.ok(!body.choices[0].message.content, 'content vacío/null: la narración se suprime');
      assert.equal(sender.calls.length, 0);
    });
  });

  it('stream wire: tool_calls delivered, no content deltas, no retry', async () => {
    await withProseFlag(false, async () => {
      const sender = scriptedSender();
      const { res } = await runStreamRecorded(narratedDuplicate(), sender);
      assert.equal(streamFinishReason(res.output), 'tool_calls');
      assert.deepEqual(streamToolCalls(res.output).map(c => c.name), ['Read']);
      assert.equal(streamContent(res.output), '', 'sin content: la narración no viaja');
      assert.equal(sender.calls.length, 0);
    });
  });

  it('prod flag (ALLOW_PROSE=true): same round delivers prose AND the call — unchanged', async () => {
    await withProseFlag(true, async () => {
      const sender = scriptedSender();
      const { result } = await runTurnRecorded(narratedDuplicate(), sender);
      assert.equal(result.ok, true);
      assert.equal(result.finishReason, 'tool_calls');
      assert.equal(result.attempt.toolCalls.length, 1);
      assert.notEqual(result.suppressVisibleText, true);
      assert.equal(result.attempt.visibleText.trim(), 'Voy a leer el archivo primero.');
      assert.equal(sender.calls.length, 0);
    });
  });
});

describe('OpenAI runaway guard: per-attempt isolation', () => {
  it('a call admitted in attempt 1 is NOT a duplicate in attempt 2 (ledger/guard/parser are fresh)', async () => {
    // Attempt 1: prosa + llamada → el gate estricto rechaza (invalid_tool_call) y reintenta.
    // Attempt 2: la MISMA llamada, sola. Si el ledger sobreviviera, seria 'duplicate' y la
    // ronda se entregaria vacia; con estado fresco se entrega la llamada.
    const sender = scriptedSender(turnOf(answerFrame(readCall('a'))));
    const frames = [answerFrame(`I will read it now.\n${readCall('a')}`)];
    const { result, warns } = await runTurnRecorded(frames, sender);

    assert.equal(sender.calls.length, 1, 'hubo exactamente un reintento');
    assert.equal(result.ok, true);
    assert.equal(result.attempt.toolCalls.length, 1, 'la llamada del attempt 2 se entrega');
    assert.equal(result.attempts, 2);
    assert.deepEqual(cutWarns(warns), [], 'el ledger del attempt 1 no contamina el 2');
  });
});

// ─────────────────── toolSchemas en el camino OpenAI ───────────────────

describe('toolSchemas reach /v1/chat/completions', () => {
  // Fixture de tests/tool-prompt.test.js "fila 11": comillas internas + `{` en el comando
  // desbalancean el objeto; solo la cadena de reparacion (whitelist + schemas) lo salva.
  const INNER_QUOTES = '[TOOL CALL]{"name":"Bash","arguments":{"command":"awk "{print}" f"}}[END TOOL CALL]';

  it('inner-quote repair is admitted when schemas are threaded', async () => {
    const sender = scriptedSender();
    const { result } = await runTurnRecorded([answerFrame(INNER_QUOTES)], sender);

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(
      result.attempt.toolCalls.map(c => JSON.parse(c.function.arguments).command),
      ['awk "{print}" f'],
      'las comillas internas sobreviven byte a byte'
    );
    assert.deepEqual(result.attempt.toolErrors, []);
  });

  it('without schemas the same payload is still invalid_json (this is the bug being fixed)', async () => {
    const sender = scriptedSender();
    const { result } = await runTurnRecorded([answerFrame(INNER_QUOTES)], sender, { tool_schemas: null });

    assert.equal(result.ok, false, 'sin schemas la ronda muere como antes de la spec');
    assert.deepEqual(result.attempt.toolCalls, [], 'la llamada no se admite');
    assert.deepEqual(result.attempt.toolErrors.map(e => e.type), ['invalid_json']);
    assert.ok(sender.calls.length > 0, 'y se quema un reintento — el bucle que la spec elimina');
  });

  it('after-prose acceptance needs schemas: a bare payload after prose is admitted', async () => {
    const sender = scriptedSender();
    // Payload pelado (sin trigger) al inicio de linea tras prosa: solo la puerta semantica
    // (whitelist + schema + required presentes) lo acepta.
    const frames = [answerFrame(`Reading it:\n${JSON.stringify({ name: 'Read', arguments: { file_path: 'a' } })}\n[END TOOL CALL]`)];
    const { result } = await runTurnRecorded(frames, sender, { agent_turn_max_attempts: 2 });

    assert.deepEqual(result.attempt.toolCalls.map(c => c.function.name), ['Read']);
  });

  it('the 2026-09-02 incident batch in 9-byte chunks: 5 calls, exact Bash commands, no spurious cut', async () => {
    // Misma fixture que tests/anthropic-narrated-toolcall.test.js. Prueba las dos mitades a
    // la vez: los schemas rescatan las comillas internas, y trocear el lote en 9 bytes (una
    // llamada repartida entre muchos pushes) NO arma la guarda de forma espuria.
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'incident-2026-09-02-narrated-batch.txt'),
      'utf8'
    );
    const frames = [];
    for (let i = 0; i < fixture.length; i += 9) frames.push(answerFrame(fixture.slice(i, i + 9)));

    // Mismos schemas que el test Anthropic: la puerta de salvage exige que TODA clave del
    // payload este declarada (el `description` de las Bash de la fixture incluido) — un
    // schema incompleto la rechaza con salvage_rejected, en ambos caminos por igual.
    const fixtureSchemas = {
      Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      Bash: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
        required: ['command']
      }
    };
    const sender = scriptedSender();
    const { result, served, warns, total } = await runTurnRecorded(frames, sender, {
      allowed_tool_names: ['Read', 'Bash'],
      tool_schemas: fixtureSchemas
    });

    assert.equal(result.ok, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.attempt.toolCalls.map(c => c.function.name), ['Read', 'Bash', 'Read', 'Bash', 'Bash']);
    assert.deepEqual(
      result.attempt.toolCalls
        .filter(c => c.function.name === 'Bash')
        .map(c => JSON.parse(c.function.arguments).command),
      [
        'cd "/work/payroll" && ls -la node_modules/.bin/tsc 2>/dev/null || echo "no tsc"',
        'cd "/work/payroll" && ls -la node_modules/.bin/ 2>/dev/null | head -20',
        'cd "/work/payroll" && cat package.json | head -30'
      ],
      'las comillas internas sobreviven byte a byte en el camino OpenAI'
    );
    assert.equal(sender.calls.length, 0, 'el lote no quema ningun reintento');
    assert.deepEqual(cutWarns(warns), [], 'trocear en 9 bytes no dispara la guarda');
    assert.equal(served.length, total, 'el upstream se consume entero');
  });

  // P3 (review): los schemas NO llegan al canal de pensamiento — paridad exacta con
  // anthropic.js (:1201 y :1721 pasan solo allowedToolNames). Con ellos, este mismo payload
  // se rescataba desde think phase y se promovia a llamada ejecutable en OpenAI pero no en
  // Anthropic. El salvage vive en answer phase.
  it('think-phase payloads are never salvaged by schemas; the same payload in answer phase is', async () => {
    const thinkOnly = await runTurnRecorded(
      [thinkFrame(INNER_QUOTES)],
      scriptedSender(),
      { agent_turn_max_attempts: 2 }
    );
    assert.deepEqual(thinkOnly.result.attempt.toolCalls, [], 'think phase: sin rescate, cero llamadas');

    const inAnswer = await runTurnRecorded([answerFrame(INNER_QUOTES)], scriptedSender());
    assert.equal(inAnswer.result.ok, true);
    assert.deepEqual(
      inAnswer.result.attempt.toolCalls.map(c => c.function.name),
      ['Bash'],
      'answer phase: el mismo payload si se admite'
    );
  });

  // P3, otra mitad: el parser de STREAMING del canal de pensamiento tampoco lleva schemas.
  // Con ellos, un payload reparable en think phase se convierte en una llamada completada que
  // el runtime descarta (nunca lee completedCalls del parser de reasoning) y sus bytes
  // desaparecen sin dejar rastro. Sin ellos falla el parseo y el texto se entrega como
  // reasoning rescatado — que es lo que hace Anthropic.
  it('the think-phase STREAM parser has no schemas either: a repairable payload is not swallowed', async () => {
    const sender = scriptedSender();
    const frames = [thinkFrame(INNER_QUOTES), answerFrame('<agent_final>done</agent_final>')];
    const { res } = await runStreamRecorded(frames, sender, {}, true);

    assert.equal(streamFinishReason(res.output), 'stop');
    // Aqui SI esperamos ver los bytes: no son una llamada, son texto de pensamiento que el
    // cliente debe recibir en vez de perderse (lo contrario que el canal answer tras un corte).
    assert.match(streamReasoning(res.output), /\[TOOL CALL\]/, 'el payload no reparado se entrega, no se traga');
    assert.match(streamReasoning(res.output), /awk/);
    const calls = streamToolCalls(res.output);
    assert.deepEqual(calls, [], 'y jamas se convierte en una llamada ejecutable');
  });

  // P5 (review): un `parameters` ausente o que no es un objeto no vale como schema. Con
  // entrada basura, la puerta semantica leia `required` de undefined ("ninguno") y admitia
  // un payload pelado tras prosa con argumentos arbitrarios sin validar.
  it('a tool whose parameters is missing or not an object gets NO entry (fail closed)', async () => {
    const req = {
      body: {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'NoParams' } },
          { type: 'function', function: { name: 'NullParams', parameters: null } },
          { type: 'function', function: { name: 'StringParams', parameters: 'nope' } },
          { type: 'function', function: { name: 'ArrayParams', parameters: [] } },
          { type: 'function', function: { name: 'Good', parameters: SCHEMAS.Read } }
        ]
      }
    };
    await processRequestBody(req, createMockResponse(), () => {});

    for (const name of ['NoParams', 'NullParams', 'StringParams', 'ArrayParams']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(req.tool_schemas, name), false,
        `${name} no debe tener entrada`
      );
      assert.ok(req.allowed_tool_names.includes(name), `${name} sigue en la whitelist`);
    }
    assert.deepEqual(req.tool_schemas.Good, SCHEMAS.Read, 'las herramientas sanas no se ven afectadas');
  });

  it('a duplicate name cannot reclaim the slot even if the first declaration was skipped', async () => {
    const req = {
      body: {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'Read' } },                        // saltada
          { type: 'function', function: { name: 'Read', parameters: SCHEMAS.Read } } // duplicada
        ]
      }
    };
    await processRequestBody(req, createMockResponse(), () => {});
    assert.equal(Object.prototype.hasOwnProperty.call(req.tool_schemas, 'Read'), false);
  });

  it('middleware builds req.tool_schemas from tools[].function.parameters', async () => {
    const req = {
      body: {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'Read', parameters: SCHEMAS.Read } },
          { type: 'function', function: { name: 'Bash', parameters: SCHEMAS.Bash } }
        ]
      }
    };
    let nextCalled = false;
    await processRequestBody(req, createMockResponse(), () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(req.has_tools, true);
    assert.deepEqual(req.allowed_tool_names, ['Read', 'Bash']);
    assert.deepEqual(Object.keys(req.tool_schemas).sort(), ['Bash', 'Read']);
    assert.deepEqual(req.tool_schemas.Read, SCHEMAS.Read);
    assert.equal(Object.getPrototypeOf(req.tool_schemas), null, 'Object.create(null): __proto__ jamas toca el prototipo');
  });

  it('duplicate function.name is fail-closed: that name gets no schema, the others survive', async () => {
    const req = {
      body: {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'Read', parameters: SCHEMAS.Read } },
          { type: 'function', function: { name: 'Read', parameters: SCHEMAS.Bash } },
          { type: 'function', function: { name: 'Bash', parameters: SCHEMAS.Bash } }
        ]
      }
    };
    await processRequestBody(req, createMockResponse(), () => {});

    assert.equal(Object.prototype.hasOwnProperty.call(req.tool_schemas, 'Read'), false, 'el nombre duplicado se borra');
    assert.deepEqual(req.tool_schemas.Bash, SCHEMAS.Bash, 'las demas herramientas no se ven afectadas');
    assert.ok(req.allowed_tool_names.includes('Read'), 'el nombre sigue en la whitelist');
  });

  it('no tools → no schemas (today behavior preserved)', async () => {
    const req = { body: { model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] } };
    await processRequestBody(req, createMockResponse(), () => {});
    assert.equal(req.has_tools, false);
    assert.equal(req.tool_schemas, null);
  });
});

// ─────────────────── el cable: stream y no-stream ───────────────────

describe('OpenAI runaway cut-off on the wire', () => {
  it('stream: repeat loop resolves as tool_calls instead of retrying, no post-call bytes', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 100 }, (_, i) => answerFrame(`\n\nnarration ${i}`))
    ];
    const { res, served, warns, total } = await runStreamRecorded(frames, sender);

    assert.equal(res.statusCode, 200);
    assert.equal(streamFinishReason(res.output), 'tool_calls');
    const calls = streamToolCalls(res.output);
    assert.deepEqual(calls.map(c => c.name), ['Read']);
    assert.deepEqual(JSON.parse(calls[0].args), { file_path: 'a' });
    assert.equal(streamContent(res.output), '', 'ni un byte de prosa post-llamada');
    assert.doesNotMatch(res.output, /narration/);
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'cero bytes de protocolo en el cable');
    assert.ok(served.length < total, `upstream cortado (${served.length}/${total})`);
    assert.equal(ruleOf(warns), 'duplicate');
    assert.equal(sender.calls.length, 0);
  });

  it('stream: think after the call writes no reasoning delta', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      thinkFrame('Now let me pretend to run the whole session.'),
      ...Array.from({ length: 30 }, () => answerFrame('\n\nrunaway'))
    ];
    const { res, warns } = await runStreamRecorded(frames, sender);

    assert.equal(streamFinishReason(res.output), 'tool_calls');
    assert.equal(streamReasoning(res.output), '', 'ningun reasoning delta tras la llamada');
    assert.doesNotMatch(res.output, /pretend to run/);
    assert.equal(ruleOf(warns), 'think');
  });

  it('stream with LEGACY_REASONING_IN_CONTENT=true still cuts (guard is callback-independent)', async () => {
    const saved = config.legacyReasoningInContent;
    config.legacyReasoningInContent = true;
    try {
      const sender = scriptedSender();
      const frames = [
        answerFrame(readCall('a')),
        answerFrame(`\n\n${readCall('a')}`),
        ...Array.from({ length: 60 }, () => answerFrame('\n\nrunaway'))
      ];
      const { res, served, warns, total } = await runStreamRecorded(frames, sender);

      assert.equal(streamFinishReason(res.output), 'tool_calls');
      assert.deepEqual(streamToolCalls(res.output).map(c => c.name), ['Read']);
      assert.ok(served.length < total, 'se corta igual sin callbacks de delta');
      assert.equal(ruleOf(warns), 'duplicate');
    } finally {
      config.legacyReasoningInContent = saved;
    }
  });

  // P1 (review) en el cable: la ronda con un error de parseo anterior se ENTREGA con 200.
  it('stream: an earlier parse error still yields HTTP 200 + tool_calls, never a retry', async () => {
    const sender = scriptedSender();
    const broken = '[TOOL CALL]{"name":"Bash","arguments":{command:"echo "hi" x"}}[END TOOL CALL]';
    const frames = [
      answerFrame(broken),
      answerFrame(`\n\n${readCall('a')}`),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 50 }, () => answerFrame('\n\nrunaway'))
    ];
    const { res, served, warns, total } = await runStreamRecorded(frames, sender);

    assert.equal(res.statusCode, 200);
    assert.equal(streamFinishReason(res.output), 'tool_calls');
    assert.deepEqual(streamToolCalls(res.output).map(c => c.name), ['Read']);
    assert.equal(sender.calls.length, 0, 'sendChatRequest jamas se llama');
    assert.equal(ruleOf(warns), 'duplicate');
    assert.ok(served.length < total);
  });

  // P7(a) (review): sin los guardas `&& !textChannelCut` de los flush, el resto retenido del
  // push descontrolado (medio trigger) se soltaria al cliente al cerrar la ronda.
  it('no flush after a cut: a held partial trigger never reaches reasoning or content', async () => {
    const sender = scriptedSender();
    const frames = [
      // El parser de reasoning retiene "[TOOL" como posible prefijo de trigger: solo lo
      // soltaria un flush().
      thinkFrame('Plan: I will call [TOOL'),
      answerFrame(readCall('a')),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 30 }, () => answerFrame('\n\nrunaway'))
    ];
    const { res, warns } = await runStreamRecorded(frames, sender, {}, true);

    assert.equal(ruleOf(warns), 'duplicate', 'la ronda si se corta');
    assert.equal(streamFinishReason(res.output), 'tool_calls');
    assert.match(streamReasoning(res.output), /Plan: I will call/, 'el pensamiento previo si se entrega');
    assert.doesNotMatch(streamReasoning(res.output), /\[TOOL/, 'el trigger retenido nunca se suelta');
    assert.doesNotMatch(streamContent(res.output), /\[TOOL/);
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'cero bytes de protocolo en el cable');
  });

  // Complemento de P7(a): un prefijo de trigger retenido por un push que SI sobrevivio no
  // llega al cliente cuando la ronda se corta por otra regla. (El guarda del flush del
  // controlStreamParser en si no es observable hoy — ese parser solo emite dentro de un
  // cuerpo <agent_final>, y una ronda cortada con ese envoltorio la rechaza la puerta;
  // se documenta como defensa en profundidad en openai-agent-runtime.js.)
  it('a trigger prefix held by a surviving push never leaks as content on a cut round', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),  // admite y arma
      // El parser retiene TODO lo que sigue a un prefijo de trigger hasta el flush, asi que
      // "[TOOL" queda dentro de controlToolStreamParser y textDelta sale vacio (no corta).
      answerFrame('\n\n[TOOL'),
      // El corte llega por la regla (c) del canal de pensamiento, que no toca los parsers de
      // answer: el prefijo sigue retenido cuando la ronda cierra.
      thinkFrame('Let me narrate the rest of the session'),
      ...Array.from({ length: 20 }, () => answerFrame('\n\nrunaway'))
    ];
    const { res, warns } = await runStreamRecorded(frames, sender);

    assert.equal(ruleOf(warns), 'think', 'la ronda se corta');
    assert.equal(streamFinishReason(res.output), 'tool_calls');
    assert.deepEqual(streamToolCalls(res.output).map(c => c.name), ['Read']);
    assert.equal(streamContent(res.output), '', 'ni un byte de content');
    assert.doesNotMatch(res.output, /\[TOOL/, 'el prefijo retenido no se suelta');
    assert.doesNotMatch(res.output, /Now narrating/);
  });

  it('non-stream twin: one JSON body, same tool_calls count and finish_reason', async () => {
    const sender = scriptedSender();
    const frames = [
      answerFrame(readCall('a')),
      answerFrame(`\n\n${readCall('a')}`),
      ...Array.from({ length: 100 }, (_, i) => answerFrame(`\n\nnarration ${i}`))
    ];
    const { res, served, warns, total } = await runNonStreamRecorded(frames, sender);

    assert.equal(res.statusCode, 200);
    const body = bodyOf(res);
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(body.choices[0].message.tool_calls.map(c => c.function.name), ['Read']);
    assert.equal(body.choices[0].message.content, null, 'sin prosa post-llamada');
    assert.doesNotMatch(res.output, /narration/);
    assert.ok(served.length < total);
    assert.equal(ruleOf(warns), 'duplicate');
    assert.equal(sender.calls.length, 0);
  });

  it('non-stream twin: cap delivers exactly 24 tool_calls', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => answerFrame(`${i ? '\n\n' : ''}${readCall(`f${i}`)}`));
    const { res, warns } = await runNonStreamRecorded(frames, sender);

    const body = bodyOf(res);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls.length, 24);
    assert.equal(ruleOf(warns), 'cap');
  });

  it('non-stream twin: legit batch is untouched (5 calls, whole upstream consumed)', async () => {
    const sender = scriptedSender();
    const frames = ['a', 'b', 'c', 'd', 'e'].map((file, i) =>
      answerFrame(`${i ? '\n\n' : ''}${readCall(file)}`));
    const { res, served, warns, total } = await runNonStreamRecorded(frames, sender);

    const body = bodyOf(res);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls.length, 5);
    assert.equal(served.length, total);
    assert.deepEqual(cutWarns(warns), []);
  });
});

// ─────────────────── P6: cableado de produccion (req.body crudo → cliente) ───────────────────

// Las dos lineas `tool_schemas: req.tool_schemas` de chat.js (:1356 y :1372) son la UNICA
// junta entre el middleware y el runtime: borrarlas dejaba los 34 tests anteriores verdes,
// porque todos inyectan los handlers directamente. Modelado sobre
// tests/anthropic-salvage-wiring.test.js, que existe exactamente por esta razon.
describe('production wiring: raw request → processRequestBody → handleChatCompletion (e2e)', () => {
  // Sin schemas este payload muere como invalid_json (pinado arriba), asi que la llamada
  // que llega al cliente solo puede venir de la cadena completa.
  const REPAIRABLE = '[TOOL CALL]{"name":"Bash","arguments":{"command":"awk "{print}" f"}}[END TOOL CALL]';
  const OPENAI_TOOLS = [{
    type: 'function',
    function: {
      name: 'Bash',
      description: 'run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
        required: ['command']
      }
    }
  }];

  const driveChatCompletion = async (stream) => {
    wiringUpstream = () => recordingUpstream([answerFrame(REPAIRABLE), STOP]).stream;
    try {
      const req = {
        body: {
          model: 'qwen3-max',
          stream,
          messages: [{ role: 'user', content: 'print the first column of f' }],
          tools: OPENAI_TOOLS
        }
      };
      const res = createMockResponse();
      await new Promise((resolve, reject) => {
        processRequestBody(req, res, (err) => (err ? reject(err) : resolve()));
      });
      // El middleware es la fuente de los schemas; si esta junta se rompe, se rompe aqui.
      assert.deepEqual(req.allowed_tool_names, ['Bash']);
      assert.ok(req.tool_schemas && req.tool_schemas.Bash, 'el middleware produjo los schemas');
      await handleChatCompletion(req, res);
      return res;
    } finally {
      wiringUpstream = null;
    }
  };

  it('stream:true — the repaired tool_call reaches the client through the real chain', async () => {
    const res = await driveChatCompletion(true);

    assert.equal(res.statusCode, 200);
    assert.equal(streamFinishReason(res.output), 'tool_calls');
    const calls = streamToolCalls(res.output);
    assert.deepEqual(calls.map(c => c.name), ['Bash']);
    assert.equal(JSON.parse(calls[0].args).command, 'awk "{print}" f', 'comillas internas intactas');
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'cero bytes de protocolo en el cable');
  });

  it('stream:false — same chain, single JSON body', async () => {
    const res = await driveChatCompletion(false);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.output);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    const calls = body.choices[0].message.tool_calls;
    assert.deepEqual(calls.map(c => c.function.name), ['Bash']);
    assert.equal(JSON.parse(calls[0].function.arguments).command, 'awk "{print}" f');
  });
});
