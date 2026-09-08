// Incidente 2026-09-06 (Claude Code via /v1/messages, staging 619aebf, transcript
// d711478c-…, msg_ee68f65f5f4141b0b40eebf9 y msg_3b3d5ad5ef4648b5811bbfb6): el modelo
// cierra UN nivel de mas tras el payload balanceado:
//   [TOOL CALL]\n{"name":"Bash","arguments":{…}}}\n[END TOOL CALL]
// Antes del fix: la llamada resolvia sin closer, el '}' sobrante salia como text_delta
// DELANTE del tool_use y el [END TOOL CALL] posterior, ya huerfano, salia como texto.
// Cero WARN. Claude Code mostraba "}" y "[END TOOL CALL]" en la conversacion.
// Ahora consumeTrailingCloser / consumeMandatoryBracketCloser saltan un residuo de
// cierre acotado (TRAILING_DEBRIS_MAX) entre el punto de balance y el closer.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { parseToolCallsFromText, createToolCallStreamParser } = require('../src/utils/tool-prompt.js');
const { handleAnthropicStream } = require('../src/controllers/anthropic.js');

const ALLOWED = ['Bash', 'Read'];
const SCHEMAS = {
  Bash: {
    type: 'object',
    properties: { command: { type: 'string' }, description: { type: 'string' }, timeout: { type: 'number' } },
    required: ['command']
  },
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
};
const OPTS = { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS };

const INCIDENT_CMD = 'uv run --no-cache "/Users/pedro/Documents/git/Prueba/payroll/_bmad/scripts/render_skill.py" --project-root "/Users/pedro/Documents/git/Prueba/payroll" --skill "/Users/pedro/Documents/git/Prueba/payroll/.claude/skills/bmad-build"';
const payload = (command = 'ls') => JSON.stringify({ name: 'Bash', arguments: { command } });
// Byte a byte la forma del incidente: payload balanceado + '}' extra + newline + closer.
const INCIDENT = `[TOOL CALL]\n${payload(INCIDENT_CMD)}}\n[END TOOL CALL]`;
const CHUNKS = [1, 7, 40, Infinity];

const streamAll = (text, chunk) => {
  const parser = createToolCallStreamParser(OPTS);
  let visible = '';
  const calls = [];
  const step = chunk === Infinity ? text.length : chunk;
  for (let i = 0; i < text.length; i += step) {
    const out = parser.push(text.slice(i, i + step));
    visible += out.textDelta;
    calls.push(...out.completedCalls);
  }
  const tail = parser.flush();
  visible += tail.textDelta;
  calls.push(...tail.completedCalls);
  return { parser, visible, calls };
};

const nameOf = (call) => call.function.name;
const argsOf = (call) => {
  const raw = call.function.arguments;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};

const assertSingleCleanCall = ({ parser, visible, calls }, command, label) => {
  assert.equal(visible, '', `${label}: nothing visible`);
  assert.deepEqual(calls.map(nameOf), ['Bash'], `${label}: exactly one Bash call`);
  assert.equal(argsOf(calls[0]).command, command, `${label}: exact command`);
  assert.deepEqual(parser.getWarnings(), [], `${label}: no warnings`);
  assert.equal(parser.hasParseError(), false, `${label}: no parse error`);
};

describe('extra closing brace between a balanced payload and its closer (incident 2026-09-06)', () => {
  for (const chunk of CHUNKS) {
    it(`stream chunk=${chunk}: no "}" text, no orphan closer, one Bash call, zero warnings`, () => {
      assertSingleCleanCall(streamAll(INCIDENT, chunk), INCIDENT_CMD, `chunk=${chunk}`);
    });
  }

  it('whole-text parity: cleanedText empty, one call, no errors', () => {
    const result = parseToolCallsFromText(INCIDENT, OPTS);
    assert.equal(result.cleanedText, '');
    assert.deepEqual(result.toolCalls.map(nameOf), ['Bash']);
    assert.equal(argsOf(result.toolCalls[0]).command, INCIDENT_CMD);
    assert.deepEqual(result.errors, []);
  });
});

describe('closing-debris shapes', () => {
  const shapes = {
    'brace on its own line': `[TOOL CALL]\n${payload()}\n}\n[END TOOL CALL]`,
    '"]}" debris': `[TOOL CALL]\n${payload()}]}\n[END TOOL CALL]`,
    'debris then a duplicated closer': `[TOOL CALL]\n${payload()}}\n[END TOOL CALL]\n[END TOOL CALL]`,
    'synthetic opening (no trigger) + debris + closer': `${payload()}}\n[END TOOL CALL]`
  };
  for (const [label, text] of Object.entries(shapes)) {
    for (const chunk of CHUNKS) {
      it(`${label} (chunk=${chunk})`, () => {
        assertSingleCleanCall(streamAll(text, chunk), 'ls', `${label} chunk=${chunk}`);
      });
    }
    it(`${label} (whole-text)`, () => {
      const result = parseToolCallsFromText(text, OPTS);
      assert.equal(result.cleanedText, '');
      assert.deepEqual(result.toolCalls.map(nameOf), ['Bash']);
      assert.deepEqual(result.errors, []);
    });
  }

  it('debris at EOF without any closer: call emitted, the "}" never reaches the text channel', () => {
    for (const chunk of CHUNKS) {
      const { visible, calls, parser } = streamAll(`[TOOL CALL]\n${payload()}}\n`, chunk);
      assert.deepEqual(calls.map(nameOf), ['Bash'], `chunk=${chunk}`);
      assert.equal(visible.trim(), '', `chunk=${chunk}: only whitespace may remain`);
      assert.equal(parser.hasParseError(), false);
    }
  });

  it('debris followed by real prose (no closer): "}" dropped, prose delivered intact', () => {
    for (const chunk of CHUNKS) {
      const { visible, calls } = streamAll(`[TOOL CALL]\n${payload()}}\nListo.`, chunk);
      assert.deepEqual(calls.map(nameOf), ['Bash'], `chunk=${chunk}`);
      assert.equal(visible.trim(), 'Listo.', `chunk=${chunk}`);
      assert.doesNotMatch(visible, /\}/, `chunk=${chunk}: no brace leaks`);
    }
  });

  it('debris beyond TRAILING_DEBRIS_MAX (9 braces) is NOT treated as residue: status quo pinned', () => {
    const text = `[TOOL CALL]\n${payload()}${'}'.repeat(9)}\n[END TOOL CALL]`;
    const { visible, calls } = streamAll(text, 7);
    assert.deepEqual(calls.map(nameOf), ['Bash']);
    assert.match(visible, /^\}{9}/, 'a wall of braces is not residue — it is released as prose');
  });

  it('a clean call (no debris) is unchanged: nothing visible, one call', () => {
    assertSingleCleanCall(streamAll(`[TOOL CALL]\n${payload()}\n[END TOOL CALL]`, 7), 'ls', 'clean');
  });
});

// ---------------------------------------------------------------------------
// End-to-end on the wire: /v1/messages streaming with the incident turn.
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

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;
const thinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`;
const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const chunkedTurn = (text, chunk = 7, lead = []) => () => {
  const frames = [...lead];
  for (let i = 0; i < text.length; i += chunk) frames.push(answerFrame(text.slice(i, i + chunk)));
  return Readable.from([...frames, STOP]);
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

const runStream = (upstream, sendRequest) => {
  const res = createMockStreamResponse();
  const ctx = {
    message_id: 'msg_extrabrace',
    model: 'qwen-test',
    hasTools: true,
    toolChoice: 'auto',
    allowedToolNames: ALLOWED,
    toolSchemas: SCHEMAS,
    requestBody: { messages: [] },
    sendRequest
  };
  return handleAnthropicStream(res, ctx, upstream()).then(() => res);
};

const toolUseNames = (output) =>
  [...output.matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]*)"/g)].map(m => m[1]);
const visibleTextOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"text_delta","text":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1])).join('');
const toolArgsOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"input_json_delta","partial_json":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1])).join('');

describe('wire replay of the incident turn (thinking + call with extra brace)', () => {
  for (const chunk of [1, 7, 40]) {
    it(`chunk=${chunk}: one tool_use, no text block at all, no closer bytes, stop_reason tool_use`, async () => {
      const sender = scriptedSender();
      const res = await runStream(chunkedTurn(INCIDENT, chunk, [thinkFrame('preparando entorno')]), sender);

      assert.equal(sender.calls.length, 0, 'no retry burned');
      assert.deepEqual(toolUseNames(res.output), ['Bash']);
      assert.equal(JSON.parse(toolArgsOf(res.output)).command, INCIDENT_CMD);
      assert.equal(visibleTextOf(res.output), '', 'zero visible text — the "}" never reaches Claude Code');
      assert.doesNotMatch(res.output, /"content_block_start".*"type":"text"/, 'no text block opened');
      assert.doesNotMatch(res.output, /END TOOL CALL/i, 'zero closer bytes on the wire');
      assert.match(res.output, /"stop_reason":"tool_use"/);
      assert.doesNotMatch(res.output, /"type":"error"/);
    });
  }
});
