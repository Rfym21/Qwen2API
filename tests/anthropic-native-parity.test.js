// Paridad con la API nativa de Anthropic en /v1/messages.
//
// Tarea 5 del plan agentic-parity: PRECEDENCIA DE stop_reason BAJO TRUNCAMIENTO.
// `mapAnthropicStopReason` miraba `hasToolCalls` ANTES del check de length/max_tokens,
// asi que un turno que el upstream corto a mitad de emision se reportaba como
// `tool_use`. El cliente (Claude Code) lee `tool_use` como "el modelo termino de pedir
// una herramienta, ejecutala" y corre una llamada cuyos argumentos pueden estar
// truncados. La API nativa reporta `max_tokens` en ese caso: el turno NO termino.
//
// La regla es de precedencia, no de supresion: los bloques `tool_use` ya emitidos
// siguen viajando en el wire (el cliente puede verlos y decidir), solo cambia el
// `stop_reason` que los enmarca.
//
// Sin red en los tests: se parchea la require-cache ANTES de requerir el controller,
// misma disciplina que anthropic-native-toolcall.test.js / anthropic-salvage-wiring.test.js.
process.env.AGENT_TURN_MAX_ATTEMPTS = '3';

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };

const {
  handleAnthropicStream,
  handleAnthropicNonStream,
  mapAnthropicStopReason
} = require('../src/controllers/anthropic.js');

test.after(() => {
  require('../src/utils/account.js').destroy();
});

// ---------------------------------------------------------------------------
// Harness (mismas formas que anthropic-native-toolcall.test.js)
// ---------------------------------------------------------------------------

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

// Llamada nativa del cliente: sin function_id, phase answer, arguments como SNAPSHOT.
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

// Lookup del registry de la plataforma: cierra la llamada del cliente.
const notExistsFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: {
      role: 'function',
      content: `Tool ${name} does not exists.`,
      phase: 'answer',
      status: 'typing',
      name
    },
    finish_reason: null
  }]
})}\n\n`;

// Terminadores. Ambos sin `content` en el delta: un delta con contenido dispararia el
// early-stop del lote nativo y el frame de cierre jamas se leeria — el finish_reason
// quedaria en null y el test mediria otra cosa.
const terminator = (finishReason) => `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: finishReason }]
})}\n\ndata: [DONE]\n\n`;

const CLEAN_STOP = terminator('stop');
const TRUNCATED_STOP = terminator('length');

const BASH_ARGS = '{"command": "git status"}';
const BASH_SNAPSHOTS = ['', '{"command": ', '{"command": "git status"', BASH_ARGS, BASH_ARGS];

/** Un turno con UNA llamada nativa completa, cerrada, y el terminador que se le pase. */
const toolTurn = (finalFrame) => () => Readable.from([
  ...BASH_SNAPSHOTS.map(snapshot => nativeCallFrame('Bash', snapshot)),
  notExistsFrame('Bash'),
  finalFrame
]);

const scriptedSender = () => {
  const fn = async (body) => { fn.calls.push(body); return { status: false }; };
  fn.calls = [];
  return fn;
};

const ALLOWED = ['Bash'];
const SCHEMAS = {
  Bash: {
    type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' } },
    required: ['command']
  }
};

const baseCtx = (sendRequest, overrides) => ({
  message_id: 'msg_parity',
  model: 'qwen-test',
  hasTools: true,
  toolChoice: 'auto',
  allowedToolNames: ALLOWED,
  toolSchemas: SCHEMAS,
  requestBody: { messages: [] },
  sendRequest,
  ...overrides
});

const runStream = (upstream, overrides = {}) => {
  const res = createMockStreamResponse();
  return handleAnthropicStream(res, baseCtx(scriptedSender(), overrides), upstream()).then(() => res);
};

const runNonStream = (upstream, overrides = {}) => {
  const res = createMockJsonResponse();
  return handleAnthropicNonStream(res, baseCtx(scriptedSender(), overrides), upstream()).then(() => res);
};

const eventsOf = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map(chunk => chunk.split('\n').find(line => line.startsWith('data: ')))
  .filter(Boolean)
  .map(line => JSON.parse(line.slice(6)));

const stopReasonOf = (output) => eventsOf(output)
  .find(event => event.type === 'message_delta')?.delta?.stop_reason;

const toolUseNamesOf = (output) => eventsOf(output)
  .filter(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
  .map(e => e.content_block.name);

// ---------------------------------------------------------------------------
// Tarea 5: precedencia de truncamiento sobre tool_use
// ---------------------------------------------------------------------------

// Fuera de alcance a proposito: `content_filter` / `refusal` CON llamada emitida sigue
// reportando `tool_use`. Es la misma familia (terminalFinish), pero el plan acota la
// Tarea 5 a length/max_tokens y ampliarla cambiaria el contrato de clientes que hoy no
// se estan rompiendo. Se deja anotado, no arreglado a escondidas.
describe('stop_reason: truncation outranks tool_use', () => {
  it('mapAnthropicStopReason reports max_tokens when a truncated turn also emitted a tool call', () => {
    assert.equal(
      mapAnthropicStopReason('length', true, true),
      'max_tokens',
      'a turn cut off mid-emission must not tell the client the tool call is complete'
    );
    assert.equal(
      mapAnthropicStopReason('max_tokens', true, true),
      'max_tokens',
      'the upstream spelling max_tokens gets the same precedence as length'
    );
  });

  it('mapAnthropicStopReason still reports tool_use for a clean tool emission', () => {
    assert.equal(mapAnthropicStopReason('stop', true, true), 'tool_use');
    assert.equal(mapAnthropicStopReason(null, true, true), 'tool_use');
    assert.equal(mapAnthropicStopReason('end_turn', true, true), 'tool_use');
  });

  it('mapAnthropicStopReason leaves the tool-free mappings untouched', () => {
    assert.equal(mapAnthropicStopReason('length', false, true), 'max_tokens');
    assert.equal(mapAnthropicStopReason('stop', false, true), 'end_turn');
    assert.equal(mapAnthropicStopReason('stop_sequence', false, true), 'stop_sequence');
    assert.equal(mapAnthropicStopReason('content_filter', false, true), 'refusal');
    assert.equal(mapAnthropicStopReason('refusal', false, true), 'refusal');
    assert.equal(mapAnthropicStopReason(null, false, true), 'end_turn');
    assert.equal(mapAnthropicStopReason(null, false, false), null);
  });

  it('stream: a truncated turn that emitted a tool call reports max_tokens on the wire', async () => {
    const res = await runStream(toolTurn(TRUNCATED_STOP));
    assert.deepEqual(toolUseNamesOf(res.output), ['Bash'], 'the tool_use block still ships');
    assert.equal(stopReasonOf(res.output), 'max_tokens');
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('stream: a clean tool turn still reports tool_use on the wire', async () => {
    const res = await runStream(toolTurn(CLEAN_STOP));
    assert.deepEqual(toolUseNamesOf(res.output), ['Bash']);
    assert.equal(stopReasonOf(res.output), 'tool_use');
  });

  it('non-stream: a truncated turn that emitted a tool call reports max_tokens', async () => {
    const res = await runNonStream(toolTurn(TRUNCATED_STOP));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.content.filter(b => b.type === 'tool_use').map(b => b.name),
      ['Bash'],
      'the tool_use block still ships'
    );
    assert.equal(res.body.stop_reason, 'max_tokens');
  });

  it('non-stream: a clean tool turn still reports tool_use', async () => {
    const res = await runNonStream(toolTurn(CLEAN_STOP));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.content.filter(b => b.type === 'tool_use').map(b => b.name),
      ['Bash']
    );
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});
