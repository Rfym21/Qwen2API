// Spec narrated-toolcall-and-inner-quote-repair (2026-09-02): las llamadas NARRADAS
// llegan al cliente. Reproduccion del incidente de la sesion de Claude Code del
// 2026-09-02 (5 llamadas por el canal de texto, solo Read#1 ejecutada): la puerta de
// POSICION del parser compartido tiraba cualquier `[TOOL CALL]…[END TOOL CALL]`
// precedido de prosa, un payload sin opener rechazado envenenaba el resto del lote, y
// la cadena de reparacion no sabia escapar comillas internas. Aqui se pina el wire
// Anthropic de punta a punta: tool_use tras prosa, el lote del incidente (fixture en
// disco, chunks de 9 bytes), y que ningun caso "sin retry" toque al sender.
//
// Harness: los mismos helpers de anthropic-native-toolcall.test.js (runStream,
// toolUsesOf, visibleTextOf), copiados — cada archivo de test corre en su proceso.
//
// Set before anything pulls in config/index.js, which snapshots env at load.
// node --test runs each file in its own process, so this cannot leak.
process.env.AGENT_TURN_MAX_ATTEMPTS = '3';

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');

// Sin red en tests: mismos parches de require-cache que anthropic-native-toolcall.test.js.
const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };
const requestModule = require('../src/utils/request.js');
requestModule.sendChatRequest = async () => ({ status: false });

const { handleAnthropicStream, handleAnthropicNonStream } = require('../src/controllers/anthropic.js');
const { logger } = require('../src/utils/logger.js');

test.after(() => {
  require('../src/utils/account.js').destroy();
});

const createMockStreamResponse = () => ({
  output: '',
  headers: {},
  writableEnded: false,
  destroyed: false,
  set(headers) { Object.assign(this.headers, headers); return this; },
  status() { return this; },
  write(chunk) { this.output += String(chunk); return true; },
  end(chunk = '') { this.output += String(chunk); this.writableEnded = true; }
});

const createMockJsonResponse = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  set(headers) { Object.assign(this.headers, headers); return this; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; }
});

/** Spy sobre logger.warn (el metodo REAL — logger.warning no existe en el singleton). */
const captureWarns = async (fn) => {
  const saved = logger.warn;
  const lines = [];
  logger.warn = (message) => { lines.push(String(message)); };
  try {
    await fn();
  } finally {
    logger.warn = saved;
  }
  return lines;
};

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;

const thinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`;

const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** One upstream turn from raw SSE frames, then a clean stop. */
const turnOf = (...frames) => () => Readable.from([...frames, STOP]);

/** El texto entero en frames de `chunk` bytes — la forma del incidente en el wire. */
const chunkFrames = (text, chunk = 9) => {
  const frames = [];
  for (let i = 0; i < text.length; i += chunk) frames.push(answerFrame(text.slice(i, i + chunk)));
  return frames;
};
const chunkedTurn = (text, chunk = 9) => () => Readable.from([...chunkFrames(text, chunk), STOP]);

/**
 * Upstream que registra cada frame que el consumidor le PIDE. Se entrega el generador
 * crudo (consumeSSEStream solo necesita Symbol.asyncIterator): Readable.from
 * pre-cargaria hasta highWaterMark objetos y served[] mentiria — un corte no se puede
 * probar con chunkedTurn. Variante generador: frames + STOP, bajo demanda.
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
  const queue = [...turns];
  const fn = async (body) => {
    fn.calls.push(body);
    const next = queue.shift();
    return next ? { status: true, response: next() } : { status: false };
  };
  fn.calls = [];
  return fn;
};

// Herramientas del fixture (spec, Code Map): Read requiere file_path, Bash requiere
// command (description opcional).
const ALLOWED = ['Read', 'Bash', 'Edit', 'Write', 'Glob', 'Grep'];
const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Bash: {
    type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' } },
    required: ['command']
  },
  Edit: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Write: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Glob: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  Grep: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
};

const baseCtx = (sendRequest, overrides) => ({
  message_id: 'msg_narrated',
  model: 'qwen-test',
  hasTools: true,
  toolChoice: 'auto',
  allowedToolNames: ALLOWED,
  toolSchemas: SCHEMAS,
  requestBody: { messages: [] },
  sendRequest,
  ...overrides
});

const runStream = (upstream, sendRequest, overrides = {}) => {
  const res = createMockStreamResponse();
  return handleAnthropicStream(res, baseCtx(sendRequest, overrides), upstream()).then(() => res);
};

const runNonStream = (upstream, sendRequest, overrides = {}) => {
  const res = createMockJsonResponse();
  return handleAnthropicNonStream(res, baseCtx(sendRequest, overrides), upstream()).then(() => res);
};

/** Eventos Anthropic del wire, en orden. */
const eventsOf = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
  .filter(Boolean)
  .map(line => JSON.parse(line.slice(6)));

/** Bloques tool_use reconstruidos (nombre + arguments concatenados por indice). */
const toolUsesOf = (output) => {
  const blocks = new Map();
  for (const event of eventsOf(output)) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, args: '' });
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const block = blocks.get(event.index);
      if (block) block.args += event.delta.partial_json;
    }
  }
  return [...blocks.values()];
};

const toolUseNames = (output) => toolUsesOf(output).map(block => block.name);

/** Texto visible por bloque de texto (indice → texto), para afirmar sobre CADA bloque. */
const textBlocksOf = (output) => {
  const blocks = new Map();
  for (const event of eventsOf(output)) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      blocks.set(event.index, '');
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      blocks.set(event.index, (blocks.get(event.index) || '') + event.delta.text);
    }
  }
  return [...blocks.values()];
};

const visibleTextOf = (output) => eventsOf(output)
  .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
  .map(event => event.delta.text)
  .join('');

const stopReasonOf = (output) => eventsOf(output).find(event => event.type === 'message_delta')?.delta?.stop_reason;

const thinkingTextOf = (output) => eventsOf(output)
  .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta')
  .map(event => event.delta.thinking)
  .join('');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'incident-2026-09-02-narrated-batch.txt'),
  'utf8'
);
const EXPECTED_BASH_COMMANDS = [
  'cd "/work/payroll" && ls -la node_modules/.bin/tsc 2>/dev/null || echo "no tsc"',
  'cd "/work/payroll" && ls -la node_modules/.bin/ 2>/dev/null | head -20',
  'cd "/work/payroll" && cat package.json | head -30'
];

const GOOD_READ_CALL = '[TOOL CALL]{"name":"Read","arguments":{"file_path":"a"}}[END TOOL CALL]';

describe('narrated tool calls reach the client (spec 2026-09-02)', () => {
  it('AC2: prose + canonical call → text block with only the prose, then ONE tool_use, stop_reason tool_use, zero retries', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(chunkedTurn(
      'Let me check.\n\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"package.json"}}\n[END TOOL CALL]'
    ), sender);

    assert.equal(sender.calls.length, 0, 'a narrated call must burn no retry');
    const uses = toolUsesOf(res.output);
    assert.deepEqual(uses.map(u => u.name), ['Read']);
    assert.deepEqual(JSON.parse(uses[0].args), { file_path: 'package.json' });
    assert.deepEqual(textBlocksOf(res.output).map(t => t.trim()), ['Let me check.'], 'exactly one text block, only the prose');
    const events = eventsOf(res.output);
    const textStart = events.findIndex(e => e.type === 'content_block_start' && e.content_block?.type === 'text');
    const toolStart = events.findIndex(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(textStart !== -1 && toolStart > textStart, 'the tool_use block follows the prose block');
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'zero protocol bytes on the wire');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('AC1: the incident fixture in 9-byte chunks → 5 tool_use in order, exact Bash commands, no [END in any text block, no retry', async () => {
    assert.doesNotMatch(FIXTURE, /\/Users\//, 'the fixture must carry no personal paths');
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(chunkedTurn(FIXTURE, 9), sender);

    assert.equal(sender.calls.length, 0, 'the batch must burn no retry');
    const uses = toolUsesOf(res.output);
    assert.deepEqual(uses.map(u => u.name), ['Read', 'Bash', 'Read', 'Bash', 'Bash']);
    assert.deepEqual(
      uses.filter(u => u.name === 'Bash').map(u => JSON.parse(u.args).command),
      EXPECTED_BASH_COMMANDS,
      'inner quotes must survive the repair byte-for-byte'
    );
    assert.deepEqual(
      uses.filter(u => u.name === 'Read').map(u => JSON.parse(u.args).file_path),
      ['/work/payroll/package.json', '/work/payroll/scripts/verify-story-1-5.ts']
    );
    for (const block of textBlocksOf(res.output)) {
      assert.doesNotMatch(block, /\[END/, 'no text block may carry a closer');
      assert.equal(block.trim(), '', 'the batch has no prose');
    }
    assert.doesNotMatch(res.output, /TOOL_?CALL/i, 'zero protocol bytes on the wire');
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('after-prose call that fails the semantic gate: no tool_use, prose delivered, span consumed, NO retry (sender never called)', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    // "Note:" no matchea looksLikeUnexecutedToolAction: la unica razon de retry posible
    // seria un error o un residuo, y el spec prohibe ambos para fallos tras prosa.
    const res = await runStream(chunkedTurn('Note:\n[TOOL CALL]{"name":"Bash","arguments":{}}[END TOOL CALL]'), sender);

    assert.equal(sender.calls.length, 0, 'an after-prose gate failure must never be coaxed into a retry');
    assert.deepEqual(toolUseNames(res.output), []);
    assert.equal(visibleTextOf(res.output).trim(), 'Note:');
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'the span is consumed, never delivered');
    assert.equal(stopReasonOf(res.output), 'end_turn');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('after-prose opener-less payload failing the gate: payload stays visible, closer consumed, NO retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const res = await runStream(chunkedTurn('Note:\n{"name":"Bash","arguments":{}}\n[END TOOL CALL]'), sender);

    assert.equal(sender.calls.length, 0, 'a visible orphan closer would fire malformed_protocol — it must be consumed');
    assert.deepEqual(toolUseNames(res.output), []);
    const visible = visibleTextOf(res.output);
    assert.match(visible, /"name":"Bash"/, 'the rejected payload may BE the answer: it is delivered');
    assert.doesNotMatch(res.output, /\[END/, 'the closer bytes are consumed');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('after-prose opener-less payload + closer that passes the gate (G5) → tool_use, prose delivered, no retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(chunkedTurn('Reading:\n{"name":"Read","arguments":{"file_path":"a"}}\n[END TOOL CALL]'), sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(visibleTextOf(res.output).trim(), 'Reading:');
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('a first-position {"name":"X",…}\\n[END TOOL CALL] inside a THINK frame (X unknown) is unknown_tool evidence → thought_tool_call retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const res = await runStream(turnOf(
      thinkFrame('{"name":"NotATool","arguments":{}}\n[END TOOL CALL]'),
      answerFrame('Done.')
    ), sender);

    assert.equal(sender.calls.length, 1, 'the leaked call in reasoning is evidence: exactly one retry');
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /inside your hidden reasoning/, 'the retry reason must be thought_tool_call');
    assert.deepEqual(toolUseNames(res.output), ['Read'], 'the retry\'s call is forwarded');
    // El razonamiento se streamea en vivo como thinking_delta (comportamiento de hoy);
    // lo que no puede pasar es que el payload se ejecute o llegue como TEXTO.
    assert.doesNotMatch(visibleTextOf(res.output), /NotATool/, 'the leaked payload never reaches a text block');
    assert.doesNotMatch(res.output, /"name":"NotATool","input"/, 'the leaked payload is never promoted');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  // ── Pines del review loop 2 ──

  it('P8: narrated call + DOUBLED closer → one tool_use, prose delivered, no [END on the wire, NO retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(chunkedTurn(
      'Let me check.\n\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"a"}}[END TOOL CALL]\n[END TOOL CALL]'
    ), sender);

    assert.equal(sender.calls.length, 0, 'a doubled closer after a narrated call must burn no retry');
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.deepEqual(textBlocksOf(res.output).map(t => t.trim()), ['Let me check.']);
    assert.doesNotMatch(res.output, /\[END/, 'the duplicate closer is consumed, never streamed');
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P8: after-prose gate failure + DOUBLED closer → span and both closers consumed, prose delivered, NO retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const res = await runStream(chunkedTurn('Note:\n[TOOL CALL]{"name":"Bash","arguments":{}}[END TOOL CALL]\n[END TOOL CALL]'), sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), []);
    assert.equal(visibleTextOf(res.output).trim(), 'Note:');
    assert.doesNotMatch(res.output, /\[END/);
    assert.equal(stopReasonOf(res.output), 'end_turn');
  });

  it('P6: first-position hard rejection with a DOUBLED closer (leak-sample-#2 shape) → tool_error retry, and no [END byte ever reaches the wire', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const res = await runStream(chunkedTurn('{"name":"NotATool","arguments":{}}\n[END TOOL CALL]\n[END TOOL CALL]'), sender);

    assert.equal(sender.calls.length, 1, 'unknown_tool at first position is tool_error evidence: one retry');
    assert.deepEqual(toolUseNames(res.output), ['Read'], 'the retry\'s call is forwarded');
    assert.doesNotMatch(res.output, /\[END/, 'the duplicate closer used to reach the wire as text');
    assert.doesNotMatch(res.output, /NotATool/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('P10: after-prose unbalanced payload cut at a closer → debris visible, closer consumed, NO malformed_protocol retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const res = await runStream(chunkedTurn('Note:\n{"name":"Bash","arguments":{"command":"echo {"}\n[END TOOL CALL]\nMore.'), sender);

    assert.equal(sender.calls.length, 0, 'a visible orphan closer would have fired malformed_protocol after prose');
    assert.deepEqual(toolUseNames(res.output), []);
    const visible = visibleTextOf(res.output);
    assert.match(visible, /^Note:\n/);
    assert.match(visible, /More\.$/);
    assert.doesNotMatch(res.output, /\[END/, 'the closer bytes are consumed');
    assert.equal(stopReasonOf(res.output), 'end_turn');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });
});

// ── Spec agent-turn-cutoff-text-channel (2026-09-05) ──
// Prod 2026-09-03..06: tras escribir un [TOOL_CALL] narrado el modelo seguia generando —
// la misma llamada repetida cientos de veces o una sesion agentica entera alucinada
// (respuestas con 245/437/531 tool_use consecutivos que Claude Code ejecuto en bypass;
// streams de 6-60 min). Solo los lotes NATIVOS cortaban el upstream. Aqui se pina el
// espejo para el canal de texto: admitida una llamada en un push ANTERIOR, la primera
// senal de descontrol (duplicado / rechazo / prosa o thinking / la N-esima llamada) corta
// el upstream y entrega lo admitido con stop_reason tool_use. `served.length` sobre el
// generador crudo prueba el corte; el warn de corte nombra la regla.

const CUT_RE = /提前终止上游/;
const cutLinesOf = (warns) => warns.filter(line => CUT_RE.test(line));
const callFrame = (name, args) => answerFrame(`[TOOL CALL]${JSON.stringify({ name, arguments: args })}[END TOOL CALL]`);
const readCall = (file) => callFrame('Read', { file_path: file });
const REJECTED_CALL_FRAME = answerFrame('[TOOL_CALL]{"name":"WebSearch","arguments":{"query":"x"}}[END TOOL CALL]');

// Frames nativos byte-fieles a la captura foreign (copiados de anthropic-native-toolcall.test.js):
// llamada del cliente por la via nativa (snapshot acumulativo, sin function_id) y el lookup
// `role:function` que la cierra.
const nativeCallFrame = (name, snapshot) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      role: 'assistant',
      content: '',
      phase: 'answer',
      status: 'typing',
      function_call: { name, arguments: snapshot },
      extra: { display_position: 'answer' }
    },
    finish_reason: null
  }]
})}\n\n`;
const notExistsFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', content: `Tool ${name} does not exists.`, phase: 'answer', status: 'typing', name },
    finish_reason: null
  }]
})}\n\n`;

const runStreamRecorded = async (frames, sender, overrides) => {
  const { served, stream } = recordingUpstream(frames);
  let res;
  const warns = await captureWarns(async () => {
    res = await runStream(() => stream, sender, overrides);
  });
  return { res, served, warns };
};

const runNonStreamRecorded = async (frames, sender, overrides) => {
  const { served, stream } = recordingUpstream(frames);
  let res;
  const warns = await captureWarns(async () => {
    res = await runNonStream(() => stream, sender, overrides);
  });
  return { res, served, warns };
};

const bodyToolUses = (res) => (res.body?.content || []).filter(block => block.type === 'tool_use');
const bodyTextBlocks = (res) => (res.body?.content || []).filter(block => block.type === 'text').map(block => block.text);

describe('text-channel runaway cut-off (spec agent-turn-cutoff-text-channel, stream)', () => {
  it('legit parallel batch: 5 distinct calls separated by \\n\\n → 5 tool_use in order, tool_use stop, whole stream consumed, no cut', async () => {
    const sender = scriptedSender();
    const frames = ['a', 'b', 'c', 'd', 'e'].map((file, i) =>
      answerFrame(`${i ? '\n\n' : ''}[TOOL CALL]{"name":"Read","arguments":{"file_path":"${file}"}}[END TOOL CALL]`));
    const { res, served, warns } = await runStreamRecorded([...frames, STOP], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUsesOf(res.output).map(u => JSON.parse(u.args).file_path), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.equal(served.length, frames.length + 1, 'the whole stream (STOP included) is consumed');
    assert.deepEqual(cutLinesOf(warns), [], 'whitespace between back-to-back calls never cuts');
    assert.equal(visibleTextOf(res.output).trim(), '');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('prose then first call in ONE push → text block + 1 tool_use, no cut', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      answerFrame('Let me look.\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"a"}}[END TOOL CALL]'),
      STOP
    ], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(textBlocksOf(res.output).map(t => t.trim()), ['Let me look.']);
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(served.length, 2, 'nothing to cut: the STOP is pulled');
    assert.deepEqual(cutLinesOf(warns), []);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('repeat loop: call A, later push repeats A byte-identical → 1 tool_use, cut on the duplicate frame, 重复 warn + one cut warn naming duplicate', async () => {
    const sender = scriptedSender();
    const A = readCall('a');
    const { res, served, warns } = await runStreamRecorded([A, A, A, A, STOP], sender);

    assert.equal(sender.calls.length, 0, 'a cut turn never retries');
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(served.length, 2, 'the third repeat is never pulled from upstream');
    assert.ok(warns.some(line => /重复/.test(line)), `expected the duplicate line, got:\n${warns.join('\n')}`);
    const cuts = cutLinesOf(warns);
    assert.equal(cuts.length, 1, 'exactly one cut line');
    assert.match(cuts[0], /duplicate/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('repeat loop in 9-byte chunks (the wire shape of prod deltas): 1 tool_use, cut before the second repeat finishes streaming', async () => {
    const sender = scriptedSender();
    const A = '[TOOL CALL]{"name":"Read","arguments":{"file_path":"a"}}[END TOOL CALL]';
    const frames = chunkFrames(`${A}\n${A}\n${A}`, 9);
    const { res, served, warns } = await runStreamRecorded([...frames, STOP], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.ok(served.length < frames.length, `cut mid-stream: served ${served.length} of ${frames.length + 1}`);
    assert.match(cutLinesOf(warns).join('\n'), /duplicate/);
    assert.equal(visibleTextOf(res.output).trim(), '', 'the whitespace between repeats never becomes prose');
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('rejected after admitted: call A, later push a [TOOL_CALL] to a tool not in the allowlist → 1 tool_use, cut on that frame, no retry, no 502, zero protocol bytes', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'), REJECTED_CALL_FRAME, answerFrame('and then more'), STOP
    ], sender);

    assert.equal(sender.calls.length, 0, 'the rejected call after an admitted one is a runaway signal, not a tool_error retry');
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(served.length, 2, 'cut on the rejected frame');
    assert.match(cutLinesOf(warns).join('\n'), /rejected/);
    assert.doesNotMatch(res.output, /TOOL.?CALL/i, 'the rejected span is stripped: zero protocol bytes on the wire');
    assert.doesNotMatch(res.output, /WebSearch/);
    assert.doesNotMatch(res.output, /"type":"error"/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('prose after call: call A, later push "Now I will…", then a think frame → 1 tool_use, cut on the prose frame, visible text and thinking both empty', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'), answerFrame('Now I will run the tests.'), thinkFrame('let me think'), STOP
    ], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(visibleTextOf(res.output), '');
    assert.equal(thinkingTextOf(res.output), '');
    assert.equal(served.length, 2, 'served frames end at the prose frame');
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('think after call: call A, later push phase think → cut, no thinking block after the tool_use', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'), thinkFrame('second thoughts'), answerFrame('Done.'), STOP
    ], sender);

    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(thinkingTextOf(res.output), '');
    assert.equal(
      eventsOf(res.output).some(e => e.type === 'content_block_start' && e.content_block?.type === 'thinking'),
      false,
      'no thinking block is ever opened after the tool_use'
    );
    assert.equal(served.length, 2, 'cut on the think frame');
    assert.match(cutLinesOf(warns).join('\n'), /think/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('cap: 30 distinct calls back-to-back → exactly 24 tool_use, cut right after the 24th, warn names the cap', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`));
    const { res, served, warns } = await runStreamRecorded([...frames, STOP], sender);

    const files = toolUsesOf(res.output).map(u => JSON.parse(u.args).file_path);
    assert.equal(files.length, 24);
    assert.deepEqual(files, Array.from({ length: 24 }, (_, i) => `f${i}`), 'the first 24 in order, the 24th delivered');
    assert.equal(served.length, 24, 'the 25th call is never pulled from upstream');
    const cuts = cutLinesOf(warns);
    assert.equal(cuts.length, 1);
    assert.match(cuts[0], /cap/);
    assert.match(cuts[0], /24\/24/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('cross-channel copy: native Bash + the same Bash narrated → 1 tool_use, no cut (the ledger drop is not a runaway signal)', async () => {
    const sender = scriptedSender();
    const { res, warns } = await runStreamRecorded([
      nativeCallFrame('Bash', ''),
      nativeCallFrame('Bash', '{"command": "git status"}'),
      nativeCallFrame('Bash', '{"command": "git status"}'),
      callFrame('Bash', { command: 'git status' }),
      notExistsFrame('Bash'),
      STOP
    ], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), ['Bash']);
    assert.ok(warns.some(line => /跨通道/.test(line)), 'the narrated copy was dropped by the shared ledger');
    assert.deepEqual(cutLinesOf(warns), [], 'a cross-channel duplicate never cuts');
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('fresh per attempt: a tool_error retry after a rejected first attempt starts with an empty flag/counter/ledger and still cuts on its own duplicate', async () => {
    const A = readCall('a');
    const retry = recordingUpstream([A, A, A, STOP]);
    const sender = scriptedSender(() => retry.stream);
    const { res, warns } = await runStreamRecorded([
      answerFrame('[TOOL CALL]{"name":"NotATool","arguments":{}}[END TOOL CALL]'), STOP
    ], sender);

    assert.equal(sender.calls.length, 1, 'first-position unknown_tool → one tool_error retry');
    assert.deepEqual(toolUseNames(res.output), ['Read'], 'the retry\'s first call is delivered once');
    assert.equal(retry.served.length, 2, 'the retry attempt is cut on its own duplicate frame');
    assert.equal(cutLinesOf(warns).length, 1);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });
});

describe('text-channel runaway cut-off (non-stream twin)', () => {
  it('legit parallel batch → 5 tool_use, whole stream consumed, no cut', async () => {
    const sender = scriptedSender();
    const frames = ['a', 'b', 'c', 'd', 'e'].map((file, i) =>
      answerFrame(`${i ? '\n\n' : ''}[TOOL CALL]{"name":"Read","arguments":{"file_path":"${file}"}}[END TOOL CALL]`));
    const { res, served, warns } = await runNonStreamRecorded([...frames, STOP], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(served.length, frames.length + 1);
    assert.deepEqual(cutLinesOf(warns), []);
  });

  it('repeat loop → 1 tool_use, cut on the duplicate frame, 重复 + cut warn', async () => {
    const sender = scriptedSender();
    const A = readCall('a');
    const { res, served, warns } = await runNonStreamRecorded([A, A, A, STOP], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.equal(sender.calls.length, 0);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Read']);
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(served.length, 2);
    assert.ok(warns.some(line => /重复/.test(line)));
    assert.match(cutLinesOf(warns).join('\n'), /duplicate/);
  });

  it('rejected after admitted → 1 tool_use, no text block, no 502, no retry, zero protocol bytes in the body', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const { res, served, warns } = await runNonStreamRecorded([
      readCall('a'), REJECTED_CALL_FRAME, answerFrame('and then more'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.equal(sender.calls.length, 0);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Read']);
    assert.deepEqual(bodyTextBlocks(res), [], 'answerContent ends at the cut: no text block at all');
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /rejected/);
    assert.doesNotMatch(JSON.stringify(res.body), /TOOL.?CALL|WebSearch/i);
  });

  it('prose after call → 1 tool_use, the prose never enters the content, cut on the prose frame', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runNonStreamRecorded([
      readCall('a'), answerFrame('Now I will run the tests.'), thinkFrame('let me think'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual((res.body?.content || []).map(b => b.type), ['tool_use'], 'no text block, no thinking block');
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
  });

  it('cap → exactly 24 tool_use, cut right after the 24th', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`));
    const { res, served, warns } = await runNonStreamRecorded([...frames, STOP], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), Array.from({ length: 24 }, (_, i) => `f${i}`));
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(served.length, 24);
    assert.match(cutLinesOf(warns).join('\n'), /cap/);
  });

  it('fresh per attempt: the retry after a tool_error first attempt gets its own guard and is cut on its own duplicate', async () => {
    const A = readCall('a');
    const retry = recordingUpstream([A, A, A, STOP]);
    const sender = scriptedSender(() => retry.stream);
    const { res, warns } = await runNonStreamRecorded([
      answerFrame('[TOOL CALL]{"name":"NotATool","arguments":{}}[END TOOL CALL]'), STOP
    ], sender);

    assert.equal(sender.calls.length, 1);
    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Read']);
    assert.equal(retry.served.length, 2, 'the retry stream is cut on its duplicate frame');
    assert.equal(cutLinesOf(warns).length, 1);
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});

describe('AGENT_TURN_MAX_TOOL_CALLS config knob', () => {
  // config/index.js snapshots env at load, so each value is read in a child process.
  const capWith = (value) => {
    // '' en vez de borrar la clave: dotenv nunca sobreescribe una clave existente, asi que
    // un .env local que fije AGENT_TURN_MAX_TOOL_CALLS no puede romper "unset → 24"
    // (parseInt('') → NaN → 24).
    const env = { ...process.env, AGENT_TURN_MAX_TOOL_CALLS: value === undefined ? '' : value };
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(require("./src/config/index.js").agentTurnMaxToolCalls))'],
      { cwd: path.join(__dirname, '..'), env }
    );
    return Number(out.toString());
  };

  it('unset → 24; outside 4..256 is clamped; non-numeric → 24', () => {
    assert.equal(capWith(undefined), 24);
    assert.equal(capWith('100'), 100);
    assert.equal(capWith('1000'), 256);
    assert.equal(capWith('1'), 4);
    assert.equal(capWith('0'), 4);
    assert.equal(capWith('abc'), 24);
  });
});

// ── Pines del review loop 1 (2026-09-05, tres revisores) ──

const config = require('../src/config/index.js');
const THIRTY_CALLS_ONE_PUSH = answerFrame(
  Array.from({ length: 30 }, (_, i) => `[TOOL CALL]{"name":"Read","arguments":{"file_path":"f${i}"}}[END TOOL CALL]`).join('\n')
);
const TWENTY_FOUR_FILES = Array.from({ length: 24 }, (_, i) => `f${i}`);
// Rule (b), warning arm: tras prosa, un Read sin file_path falla la puerta semantica →
// solo un warning `triggered_unrecovered` con reason `after prose: …` (ni error ni recoveredText).
const ARMED_AFTER_PROSE = answerFrame('Let me look.\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"a"}}[END TOOL CALL]');
const SCHEMA_REJECTED_AFTER_PROSE = answerFrame('\n[TOOL CALL]{"name":"Read","arguments":{}}[END TOOL CALL]');
// Rule (f): prosa + llamada en el MISMO push tras armar → la llamada se entrega y el push corta.
const SAME_PUSH_PROSE_AND_CALL = answerFrame('Now b:\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"b"}}[END TOOL CALL]');
const withToolCallCap = async (cap, fn) => {
  const saved = config.agentTurnMaxToolCalls;
  config.agentTurnMaxToolCalls = cap;
  try {
    return await fn();
  } finally {
    config.agentTurnMaxToolCalls = saved;
  }
};
// Frame de resultado de web_search (role function, plataforma): `webSearchInfo` se captura
// ANTES del normalizador, que lo tira (no es herramienta del cliente → no cuenta como
// interceptacion).
const webSearchFrame = (sites) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', name: 'web_search', phase: 'answer', content: '', extra: { web_search_info: sites } },
    finish_reason: null
  }]
})}\n\n`;
const SITES = [{ title: 'Doc', url: 'https://example.test/doc', hostname: 'example.test' }];

describe('review loop 1 pins (stream)', () => {
  it('P1: one push with 30 complete distinct calls → exactly 24 tool_use, cut warn names cap (no arming gate for the cap)', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([THIRTY_CALLS_ONE_PUSH, STOP], sender);

    assert.deepEqual(toolUsesOf(res.output).map(u => JSON.parse(u.args).file_path), TWENTY_FOUR_FILES);
    assert.equal(served.length, 1, 'cut inside the first push: the STOP is never pulled');
    const cuts = cutLinesOf(warns);
    assert.equal(cuts.length, 1);
    assert.match(cuts[0], /cap/);
    assert.match(cuts[0], /24\/24/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('P2: cut on prose with a closer-less call pending in the SAME push → no flush: exactly one tool_use, no truncated_tool_call / 工具协议出错 lines', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'),
      answerFrame('Now I will\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"b"}}'),
      answerFrame('[END TOOL CALL]'),
      STOP
    ], sender);

    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(toolUsesOf(res.output).length, 1, 'the pending call is never flushed into a second tool_use');
    assert.equal(served.length, 2);
    assert.equal(visibleTextOf(res.output), '');
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
    assert.equal(warns.some(line => /truncated_tool_call|工具协议出错|解析 tool_call 负载失败/.test(line)), false,
      `a cut must not convict its own leftover:\n${warns.join('\n')}`);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P2 (unbalanced variant): the half-streamed payload left by the cut is not convicted as truncated_tool_call', async () => {
    const sender = scriptedSender();
    const { res, warns } = await runStreamRecorded([
      readCall('a'),
      answerFrame('Now I will\n[TOOL CALL]{"name":"Read","arguments":{"file_path":"b"'),
      answerFrame('}}[END TOOL CALL]'),
      STOP
    ], sender);

    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(warns.some(line => /truncated_tool_call|工具协议出错|解析 tool_call 负载失败/.test(line)), false,
      `self-inflicted truncation must not be logged:\n${warns.join('\n')}`);
    assert.doesNotMatch(res.output, /"type":"error"/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P4: whitespace-only think delta after arming opens no thinking block; the next non-whitespace think cuts', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'), thinkFrame('\n'), thinkFrame('more'), STOP
    ], sender);

    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.equal(
      eventsOf(res.output).some(e => e.type === 'content_block_start' && e.content_block?.type === 'thinking'),
      false,
      'no thinking block behind the tool_use'
    );
    assert.equal(served.length, 3, 'cut on the non-whitespace think frame');
    assert.match(cutLinesOf(warns).join('\n'), /think/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P6c: a non-default cap reaches the handler: agentTurnMaxToolCalls=5, 30 calls → 5 tool_use, served 5, warn 5/5', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`));
    const { res, served, warns } = await withToolCallCap(5, () => runStreamRecorded([...frames, STOP], sender));

    assert.equal(toolUsesOf(res.output).length, 5);
    assert.equal(served.length, 5);
    assert.match(cutLinesOf(warns).join('\n'), /5\/5/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P6d: rule (b) warning arm — a schema-rejected call after prose (triggered_unrecovered "after prose: …", no error) cuts as rejected', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const { res, served, warns } = await runStreamRecorded([
      ARMED_AFTER_PROSE, SCHEMA_REJECTED_AFTER_PROSE, answerFrame('tail'), STOP
    ], sender);

    assert.equal(sender.calls.length, 0);
    assert.deepEqual(toolUseNames(res.output), ['Read']);
    assert.deepEqual(textBlocksOf(res.output).map(t => t.trim()), ['Let me look.']);
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /rejected/);
    assert.doesNotMatch(res.output, /TOOL CALL/i);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P6f: same-push prose + call after arming → the call is delivered AND the push cuts with prose', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runStreamRecorded([
      readCall('a'), SAME_PUSH_PROSE_AND_CALL, answerFrame('tail'), STOP
    ], sender);

    assert.deepEqual(toolUsesOf(res.output).map(u => JSON.parse(u.args).file_path), ['a', 'b']);
    assert.equal(visibleTextOf(res.output), '', 'the prose of the triggering push never reaches the wire');
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('P7: the cut warn prints N/max only for cap; other rules print the count alone', async () => {
    const sender = scriptedSender();
    const { warns } = await runStreamRecorded([readCall('a'), answerFrame('Now more.'), STOP], sender);
    const cut = cutLinesOf(warns)[0];
    assert.match(cut, /已放行 1 个/);
    assert.doesNotMatch(cut, /\d+\/\d+/);
  });
});

describe('review loop 1 pins (non-stream twin)', () => {
  it('P1: one push with 30 complete distinct calls → exactly 24 tool_use, cut warn names cap', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runNonStreamRecorded([THIRTY_CALLS_ONE_PUSH, STOP], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), TWENTY_FOUR_FILES);
    assert.equal(served.length, 1);
    assert.match(cutLinesOf(warns).join('\n'), /cap/);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('P3: protocol debris released as text BEFORE an admitted call is stripped at delivery on a cut round', async () => {
    // El unico camino que suelta debris por textDelta con registro (channel text) en modo push
    // es el payload sintetico de primera posicion que nunca balancea y desborda
    // TOOL_CALL_SPAN_MAX (1 MiB): el parser lo suelta como debris registrado, reteniendo solo
    // los ultimos TOOL_CALL_TRIGGER_MAX (16) bytes, que salen como prosa.
    // Texto con espacios, no una sola "palabra" de 1 MiB: el estimador local de usage
    // (tiktoken, wasm) revienta con `unreachable` sobre un token de 1 MiB — hallazgo
    // preexistente, registrado en deferred-work, fuera de este spec.
    const debris = `{"name":"Read","arguments":{"file_path":"DEBRIS_MARKER ${'word '.repeat(220 * 1024)}`;
    const sender = scriptedSender();
    const { res, served, warns } = await runNonStreamRecorded([
      answerFrame(debris), readCall('a'), answerFrame('Now more.'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), ['a']);
    assert.equal(served.length, 3, 'cut on the prose frame');
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
    const body = JSON.stringify(res.body);
    assert.doesNotMatch(body, /DEBRIS_MARKER/, 'the registered debris never reaches the client');
    const text = bodyTextBlocks(res).join('');
    assert.ok(text.length <= 16, `only the parser's unregistered 16-byte tail may remain, got ${text.length} chars`);
    assert.ok(warns.some(line => /按登记位置剥离协议残渣/.test(line)), 'delivery-time stripping ran on the cut round');
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('P6a: think after call → cut, content is only the tool_use, served 2, warn think', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runNonStreamRecorded([
      readCall('a'), thinkFrame('second thoughts'), answerFrame('Done.'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual((res.body?.content || []).map(b => b.type), ['tool_use']);
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /think/);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('P6b: cross-channel copy (native Bash + the same Bash narrated) → 1 tool_use, no cut', async () => {
    const sender = scriptedSender();
    const { res, warns } = await runNonStreamRecorded([
      nativeCallFrame('Bash', ''),
      nativeCallFrame('Bash', '{"command": "git status"}'),
      nativeCallFrame('Bash', '{"command": "git status"}'),
      callFrame('Bash', { command: 'git status' }),
      notExistsFrame('Bash'),
      STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Bash']);
    assert.deepEqual(cutLinesOf(warns), []);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('P6c: agentTurnMaxToolCalls=5 reaches the non-stream handler: 30 calls → 5 tool_use, served 5', async () => {
    const sender = scriptedSender();
    const frames = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`));
    const { res, served, warns } = await withToolCallCap(5, () => runNonStreamRecorded([...frames, STOP], sender));

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.equal(bodyToolUses(res).length, 5);
    assert.equal(served.length, 5);
    assert.match(cutLinesOf(warns).join('\n'), /5\/5/);
  });

  it('P6d: rule (b) warning arm on the non-stream twin → cut rejected, served 2, one tool_use, prose delivered', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GOOD_READ_CALL)));
    const { res, served, warns } = await runNonStreamRecorded([
      ARMED_AFTER_PROSE, SCHEMA_REJECTED_AFTER_PROSE, answerFrame('tail'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.equal(sender.calls.length, 0);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Read']);
    assert.deepEqual(bodyTextBlocks(res).map(t => t.trim()), ['Let me look.']);
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /rejected/);
    assert.doesNotMatch(JSON.stringify(res.body), /TOOL CALL/i);
  });

  it('P6e: retry-round settlement — tool_error first attempt, then 30 calls on the retry → 24 tool_use, retry served 24', async () => {
    const frames = Array.from({ length: 30 }, (_, i) => readCall(`f${i}`));
    const retry = recordingUpstream([...frames, STOP]);
    const sender = scriptedSender(() => retry.stream);
    const { res } = await runNonStreamRecorded([
      answerFrame('[TOOL CALL]{"name":"NotATool","arguments":{}}[END TOOL CALL]'), STOP
    ], sender);

    assert.equal(sender.calls.length, 1);
    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), TWENTY_FOUR_FILES, 'reparsing the cut answerContent would yield 23');
    assert.equal(retry.served.length, 24);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('P6f: same-push prose + call after arming → both calls in content, no text block, cut prose', async () => {
    const sender = scriptedSender();
    const { res, served, warns } = await runNonStreamRecorded([
      readCall('a'), SAME_PUSH_PROSE_AND_CALL, answerFrame('tail'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.input.file_path), ['a', 'b']);
    assert.deepEqual(bodyTextBlocks(res), [], 'the prose of the triggering push never enters the content');
    assert.equal(served.length, 2);
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
  });

  it('P6g: search table on a cut round → the table is delivered in the text block ahead of the tool_use', async () => {
    const sender = scriptedSender();
    const { res, warns } = await runNonStreamRecorded([
      webSearchFrame(SITES), readCall('a'), answerFrame('Now more.'), STOP
    ], sender);

    assert.equal(res.statusCode, 200, `expected delivery, got ${JSON.stringify(res.body?.error || null)}`);
    assert.deepEqual(bodyToolUses(res).map(b => b.name), ['Read']);
    assert.match(cutLinesOf(warns).join('\n'), /prose/);
    const text = bodyTextBlocks(res).join('');
    assert.match(text, /\[1\] \[Doc\]\(https:\/\/example\.test\/doc\)/, 'the search table survives the cut');
    assert.doesNotMatch(text, /Now more/);
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});
