// El cap del canal de texto manda TAMBIEN mientras se drena el push que disparo un corte
// por otra regla (duplicate / rejected / prose / think).
//
// El agujero: la guarda compartida (src/utils/agent-turn.js#inspectCall) deja de devolver
// reglas —— 'cap' incluida —— en cuanto `cutRule` esta puesto, y los llamadores solo hacen
// `break` con 'cap'. Asi que un SOLO delta que trae la llamada duplicada (que corta) seguida
// de 40 llamadas distintas las admitia y emitia todas: 41 bloques tool_use contra un cap de
// 24. En esta rama de streaming `emitToolUse` escribe el bloque en el cable al instante, de
// modo que el exceso ya no se puede recuperar —— es el caso peor de los tres llamadores.
//
// Se encontro portando el mismo fallo desde el camino OpenAI
// (tests/openai-agent-turn-cutoff.test.js, hallazgo P2 de la revision).
//
// Harness: los mismos helpers de tests/anthropic-narrated-toolcall.test.js, copiados ——
// cada archivo de test corre en su propio proceso.

// Set before anything pulls in config/index.js, which snapshots env at load.
process.env.AGENT_TURN_MAX_ATTEMPTS = '2';

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');

// Sin red en tests: los parches de require-cache van ANTES de requerir el controller
// (anthropic.js captura sendChatRequest por destructuring en su primer require).
const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };
const requestModule = require('../src/utils/request.js');
let upstreamFactory = null;
requestModule.sendChatRequest = async () => (upstreamFactory
  ? { status: true, response: upstreamFactory(), currentAccount: null }
  : { status: false });

const { handleAnthropicStream, handleAnthropicMessages } = require('../src/controllers/anthropic.js');
const config = require('../src/config/index.js');
const { logger } = require('../src/utils/logger.js');

test.after(() => {
  require('../src/utils/account.js').destroy();
});

const createMockStreamResponse = () => ({
  output: '',
  headers: {},
  writableEnded: false,
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

/** Spy sobre logger.warn; registra tambien el modulo (el tag es parametro de la guarda). */
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

const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** Generador crudo: Readable.from precargaria frames y un corte no se podria observar. */
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

const scriptedSender = () => {
  const fn = async (body) => { fn.calls.push(body); return { status: false }; };
  fn.calls = [];
  return fn;
};

const eventsOf = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
  .filter(Boolean)
  .map(line => JSON.parse(line.slice(6)));

const toolUsesOf = (output) => {
  const blocks = new Map();
  for (const event of eventsOf(output)) {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      blocks.set(event.index, { name: event.content_block.name, args: '' });
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const block = blocks.get(event.index);
      if (block) block.args += event.delta.partial_json;
    }
  }
  return [...blocks.values()];
};

const stopReasonOf = (output) => eventsOf(output).find(e => e.type === 'message_delta')?.delta?.stop_reason;

const cutWarns = (warns) => warns.filter(entry => /失控信号/.test(entry.message));
const ruleOf = (warns) => {
  const entry = cutWarns(warns)[0];
  const matched = entry && entry.message.match(/失控信号 \(([a-z]+)\)/);
  return matched ? matched[1] : null;
};

const ALLOWED = ['Read'];
const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
};
const READ_SCHEMA_ANTHROPIC = {
  name: 'Read',
  description: 'read a file',
  input_schema: SCHEMAS.Read
};

const readCall = (file) =>
  `[TOOL CALL]${JSON.stringify({ name: 'Read', arguments: { file_path: file } })}[END TOOL CALL]`;

/**
 * El delta descontrolado: la llamada duplicada (que corta por la regla (a)) seguida de 40
 * llamadas distintas, todas COMPLETAS dentro del mismo push.
 */
const RUNAWAY_PUSH = [
  readCall('a'),
  ...Array.from({ length: 40 }, (_, i) => readCall(`extra${i}`))
].join('\n\n');

const FRAMES = [answerFrame(readCall('a')), answerFrame(`\n\n${RUNAWAY_PUSH}`)];

describe('text-channel cap binds while draining the cut push (Anthropic)', () => {
  it('stream: 41 completed calls in the triggering push → at most 24 tool_use on the wire, one ANTHROPIC cut warn', async () => {
    const sender = scriptedSender();
    const { served, stream } = recordingUpstream([...FRAMES, STOP]);
    const res = createMockStreamResponse();
    const warns = await captureWarns(async () => {
      await handleAnthropicStream(res, {
        message_id: 'msg_cap_drain',
        model: 'qwen-test',
        hasTools: true,
        toolChoice: 'auto',
        allowedToolNames: ALLOWED,
        toolSchemas: SCHEMAS,
        requestBody: { messages: [] },
        sendRequest: sender
      }, stream);
    });

    const uses = toolUsesOf(res.output);
    assert.equal(config.agentTurnMaxToolCalls, 24, 'el cap por defecto es el que se prueba');
    assert.ok(uses.length <= 24, `nunca por encima del cap (emitidos: ${uses.length})`);
    assert.equal(uses.length, 24);
    assert.deepEqual(uses.map(u => u.name), Array(24).fill('Read'));
    // La primera es la del push anterior; luego se admiten las distintas del push cortado.
    assert.deepEqual(
      uses.map(u => JSON.parse(u.args).file_path),
      ['a', ...Array.from({ length: 23 }, (_, i) => `extra${i}`)]
    );

    assert.equal(cutWarns(warns).length, 1, 'exactamente un warn de corte');
    assert.equal(ruleOf(warns), 'duplicate');
    assert.equal(cutWarns(warns)[0].module, 'ANTHROPIC');
    assert.equal(stopReasonOf(res.output), 'tool_use');
    assert.equal(sender.calls.length, 0, 'ningun reintento');
    assert.ok(served.length < FRAMES.length + 1, 'el upstream se corta');
    assert.doesNotMatch(res.output, /TOOL CALL/i, 'cero bytes de protocolo en el cable');
  });

  it('non-stream twin via handleAnthropicMessages: at most 24 tool_use blocks in the body', async () => {
    upstreamFactory = () => recordingUpstream([...FRAMES, STOP]).stream;
    try {
      const res = createMockJsonResponse();
      const warns = await captureWarns(async () => {
        await handleAnthropicMessages({
          body: {
            model: 'qwen3-max',
            max_tokens: 1024,
            stream: false,
            messages: [{ role: 'user', content: 'read the files' }],
            tools: [READ_SCHEMA_ANTHROPIC]
          }
        }, res);
      });

      assert.equal(res.statusCode, 200);
      const uses = (res.body?.content || []).filter(block => block.type === 'tool_use');
      assert.ok(uses.length <= 24, `nunca por encima del cap (entregados: ${uses.length})`);
      assert.equal(uses.length, 24);
      assert.deepEqual(
        uses.map(u => u.input.file_path),
        ['a', ...Array.from({ length: 23 }, (_, i) => `extra${i}`)]
      );
      assert.equal(res.body.stop_reason, 'tool_use');
      assert.equal(cutWarns(warns).length, 1);
      assert.equal(ruleOf(warns), 'duplicate');
      assert.equal(cutWarns(warns)[0].module, 'ANTHROPIC');
    } finally {
      upstreamFactory = null;
    }
  });
});
