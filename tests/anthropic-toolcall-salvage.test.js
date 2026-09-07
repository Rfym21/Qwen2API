// salvage-3: recuperacion de leaks prose-adjacent (spec-qwen2api-toolcall-salvage-3,
// enmendado en review loop 1 — decision A). Tres capas fail-closed:
// (1) reparacion de comillas + nameHint del tail del trigger, con triple compuerta
//     (JSON.parse estricto + allowlist no vacia + schema: keys ⊆ properties Y todos
//     los required presentes) Y la compuerta de POSICION: el salvage respeta
//     emittedProse exactamente como una llamada canonica — un span malformado tras
//     prosa visible jamas es mas ejecutable que uno bien formado;
// (2) loop B: tool_error tras prosa consume el cupo retriedAfterVisibleText con un
//     retry de texto suprimido;
// (3) el residuo se pela SOLO en la entrega, por POSICION registrada (jamas un
//     indexOf del primer hit ni fallback de trim), con el texto acotado a lo
//     probadamente protocolar (sin closer ⇒ solo trigger+tail).
//
// Set before anything pulls in config/index.js, which snapshots env at load.
// node --test runs each file in its own process, so this cannot leak.
process.env.AGENT_TURN_MAX_ATTEMPTS = '3';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  parseToolCallsFromText,
  createToolCallStreamParser,
  stripToolCallResidue,
  repairLooseToolPayload
} = require('../src/utils/tool-prompt.js');
const { handleAnthropicStream, handleAnthropicNonStream } = require('../src/controllers/anthropic.js');
const { logger } = require('../src/utils/logger.js');

const ALLOWED = ['Bash', 'read_file'];
const SCHEMAS = {
  Bash: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeout: { type: 'number' }
    },
    required: ['command']
  },
  read_file: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
};

// Reconstruccion exacta del incidente 3 (2026-08-31 16:39, docker logs): el nombre
// queda FUERA del JSON, la clave va sin comillas y el valor perdio su comilla de
// apertura pero conserva la de cierre — la paridad de comillas muere y
// extractBalancedObject jamas cierra → truncated_tool_call. El span real es el
// PRIMER contenido de la respuesta (spec change log, review loop 1): el prefijo de
// prosa de la primera version del fixture era sobre-especificacion del implementador.
const INCIDENT3_CMD = 'find /Users/pedro/Documents/git/Prueba/payroll/_bmad-output/planning-artifacts/architecture-Español-2026-09-01 -type f 2>/dev/null';
const INCIDENT3_SPAN = `[TOOL_CALL]Bash{command:${INCIDENT3_CMD}", "description": "List files in architecture-Español directory"}}\n[END TOOL CALL]`;
const INCIDENT3 = `${INCIDENT3_SPAN}\n`;

const GOOD_CALL = '[TOOL CALL]{"name":"read_file","arguments":{"path":"a.txt"}}[END TOOL CALL]';
const GARBAGE_CALL = '[TOOL CALL]{"name":"garbage","arguments":{}}[END TOOL CALL]';

const streamAll = (text, options, chunk = 7) => {
  const parser = createToolCallStreamParser(options);
  let visible = '';
  let recovered = '';
  const calls = [];
  for (let i = 0; i < text.length; i += chunk) {
    const out = parser.push(text.slice(i, i + chunk));
    visible += out.textDelta;
    recovered += out.recoveredText;
    calls.push(...out.completedCalls);
  }
  const tail = parser.flush();
  visible += tail.textDelta;
  recovered += tail.recoveredText;
  calls.push(...tail.completedCalls);
  return { parser, visible, recovered, calls };
};

describe('incident-3 salvage: first-content span, name outside the JSON, broken quote parity', () => {
  it('whole-text: exact command recovered, no errors, no residue in cleanedText', () => {
    const result = parseToolCallsFromText(INCIDENT3, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'Bash');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.command, INCIDENT3_CMD, 'the command must round-trip byte-for-byte');
    assert.equal(args.description, 'List files in architecture-Español directory');
    assert.equal(result.errors.length, 0, 'salvage must run before the truncated condemnation');
    assert.equal(result.cleanedText, '');
    assert.equal(result.residueSpans.length, 0, 'a salvaged span is consumed, not condemned');
  });

  it('streaming (7-char chunks): same call at flush, recoveredText stays empty', () => {
    const { parser, visible, recovered, calls } = streamAll(INCIDENT3, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'Bash');
    assert.equal(JSON.parse(calls[0].function.arguments).command, INCIDENT3_CMD);
    assert.equal(parser.getErrors().length, 0);
    assert.equal(recovered, '', 'nothing to recover — the span became a call');
    assert.doesNotMatch(visible, /TOOL.?CALL/i, 'zero protocol bytes may reach the visible channel');
  });
});

describe('position gate on SALVAGE (decision A) survives the semantic gate: truncated spans after prose stay condemned', () => {
  const AFTER_PROSE = `Voy a listar los archivos del directorio.\n${INCIDENT3_SPAN}\n`;

  it('whole-text: a malformed span after prose is NOT salvaged; the span strips from delivery, prose survives', () => {
    const result = parseToolCallsFromText(AFTER_PROSE, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(result.toolCalls.length, 0, 'malformed must never be more executable than well-formed');
    assert.equal(result.errors[0]?.type, 'truncated_tool_call');
    assert.match(result.cleanedText, /Voy a listar los archivos/);
    // La entrega (posicional) quita el span condenado y conserva la prosa.
    const stripped = stripToolCallResidue(result.cleanedText, result.residueSpans);
    assert.match(stripped, /Voy a listar los archivos/);
    assert.doesNotMatch(stripped, /TOOL.?CALL/i);
  });

  it('streaming: same suppression at flush — span condemned to recoveredText, no call', () => {
    const { parser, calls, recovered } = streamAll(AFTER_PROSE, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(calls.length, 0);
    assert.equal(parser.getErrors()[0]?.type, 'truncated_tool_call');
    assert.match(recovered, /TOOL_CALL/, 'the condemned span goes to the recovered channel, not the wire');
    const spans = parser.getResidueSpans();
    assert.equal(spans[0]?.channel, 'recovered');
  });

  it('canonical call after prose passes the SEMANTIC gate (spec narrated-toolcall, inverted pin): call emitted, prose delivered', () => {
    // Antes (decision A, position gate) se suprimia. Ahora la posicion no es la puerta:
    // whitelist + required lo son. El span MALFORMADO tras prosa (dos casos arriba) sigue
    // condenado — el salvage truncado conserva la puerta de posicion.
    const text = `Some prose first.\n${GOOD_CALL}`;
    const result = parseToolCallsFromText(text, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(result.toolCalls.length, 1, 'schema validity is the arbiter, not position');
    assert.equal(result.toolCalls[0].function.name, 'read_file');
    assert.equal(result.errors.length, 0);
    assert.equal(result.cleanedText, 'Some prose first.');
    assert.ok(!result.warnings.some(w => w.reason === 'not the first content of the answer'));
    const { calls, visible } = streamAll(text, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(calls.length, 1, 'streaming diverges');
    assert.equal(visible.trim(), 'Some prose first.');
  });
});

describe('no-closer truncated span: salvage rejected, trailing prose never swallowed', () => {
  const NO_CLOSER = '[TOOL_CALL]Bash{command:ls", "description":"d"}\nAhora reviso los resultados.';

  it('whole-text: no call, truncated error, and stripping removes ONLY trigger+tail', () => {
    const result = parseToolCallsFromText(NO_CLOSER, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(result.toolCalls.length, 0, 'no closer ⇒ the tail is not residue by construction');
    assert.equal(result.errors[0]?.type, 'truncated_tool_call');
    const stripped = stripToolCallResidue(result.cleanedText, result.residueSpans);
    assert.match(stripped, /Ahora reviso los resultados\./, 'trailing prose must survive delivery');
    assert.doesNotMatch(stripped, /TOOL_CALL/);
  });

  it('streaming: same rejection at flush', () => {
    const { parser, calls } = streamAll(NO_CLOSER, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(calls.length, 0);
    assert.equal(parser.getErrors()[0]?.type, 'truncated_tool_call');
    // El texto registrado se acota a trigger+tail: el resto puede ser respuesta.
    const spans = parser.getResidueSpans();
    assert.equal(spans[0]?.text, '[TOOL_CALL]Bash');
  });
});

describe('schema gate: required keys are validated, vacuous args reject', () => {
  it('Bash{} with required:[command] → salvage rejected, typed salvage_rejected', () => {
    const result = parseToolCallsFromText('[TOOL_CALL]Bash{}\n[END TOOL CALL]', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0, 'no tool_use may be emitted with missing required args');
    assert.equal(result.errors[0]?.type, 'salvage_rejected');
  });

  it('subset keys but missing required → rejected too', () => {
    const result = parseToolCallsFromText('[TOOL_CALL]Bash{description: "d"}\n[END TOOL CALL]', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors[0]?.type, 'salvage_rejected');
  });

  it('a repaired key outside input_schema.properties rejects the salvage', () => {
    const result = parseToolCallsFromText('[TOOL_CALL]Bash{command: "ls", banana: "y"}', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0, 'phantom keys must never execute');
    assert.equal(result.errors[0]?.type, 'salvage_rejected');
  });

  it('nameHint outside the allowlist rejects the salvage', () => {
    const result = parseToolCallsFromText('[TOOL_CALL]NotATool{command: "ls"}', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors[0]?.type, 'salvage_rejected');
  });
});

describe('salvage gates are fail-closed', () => {
  it('empty allowlist: no salvage, no name-prefix extraction — today\'s truncated error', () => {
    const result = parseToolCallsFromText(INCIDENT3, { allowedToolNames: [], toolSchemas: SCHEMAS });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors[0]?.type, 'truncated_tool_call');
  });

  it('allowlist without schemas: no salvage either (the schema gate is half the boundary)', () => {
    const result = parseToolCallsFromText(INCIDENT3, { allowedToolNames: ALLOWED });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors[0]?.type, 'truncated_tool_call');
  });

  it('unquoted value with internal quotes fails the strict gate and falls through', () => {
    const result = parseToolCallsFromText('[TOOL_CALL]Bash{command:echo "hi", "description": "x"}', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0, 'nothing mangled may execute');
    assert.equal(result.errors[0]?.type, 'invalid_json');
  });

  it('streaming: mid-stream over-cap span is condemned WITHOUT salvage even if flush-salvageable', () => {
    // La compuerta flushing-only: con el stream vivo, un span sobre el tope emite
    // condena inmediata — jamas un tool_use con el resto del payload aun en vuelo.
    const giant = `[TOOL_CALL]Bash{command:${'x'.repeat(1024 * 1024 + 64)}", "description":"d"}}\n[END TOOL CALL]`;
    const parser = createToolCallStreamParser({ allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    const calls = [];
    for (let i = 0; i < giant.length; i += 128 * 1024) {
      calls.push(...parser.push(giant.slice(i, i + 128 * 1024)).completedCalls);
    }
    calls.push(...parser.push('\nmas prosa despues').completedCalls);
    calls.push(...parser.flush().completedCalls);

    assert.equal(calls.length, 0, 'a half-received payload must never emit a tool_use');
    const errors = parser.getErrors();
    assert.equal(errors[0]?.type, 'truncated_tool_call');
    assert.equal(errors[0]?.reason, 'span exceeded buffer cap');
  });
});

describe('balanced unquoted payload: nameHint + quote repair on the invalid_json path', () => {
  const text = '[TOOL_CALL]Bash{command: "ls"}';

  it('whole-text: salvaged into a Bash call', () => {
    const result = parseToolCallsFromText(text, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'Bash');
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).command, 'ls');
    assert.equal(result.errors.length, 0);
  });

  it('streaming: same result', () => {
    const { calls, parser } = streamAll(text, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'Bash');
    assert.equal(parser.getErrors().length, 0);
  });
});

describe('blind-hunter edges: nameHint provenance and the envelope repair path', () => {
  it('an angle-bracket trigger yields NO nameHint — envelope-less payload stays unexecutable', () => {
    const result = parseToolCallsFromText('<tool_call>Bash{command: "ls"}', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0, 'the hint is a bracket-form exception only');
    assert.equal(result.errors[0]?.type, 'invalid_json');
  });

  it('envelope with unquoted keys goes through quote repair AND the salvage gate (positive)', () => {
    const result = parseToolCallsFromText('[TOOL CALL]{name:"Bash",arguments:{command:"ls"}}[END TOOL CALL]', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'Bash');
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).command, 'ls');
  });

  it('envelope through quote repair with off-schema args is rejected as salvage_rejected', () => {
    const result = parseToolCallsFromText('[TOOL CALL]{name:"Bash",arguments:{banana:"x"}}[END TOOL CALL]', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors[0]?.type, 'salvage_rejected');
  });
});

describe('regression pins around the salvage', () => {
  it('orphan closers register as residue, but fenced/inline-code closers never do', () => {
    // El registro de cierres huerfanos respeta el mismo code tracker que los
    // triggers: un ejemplo documentado jamas es residuo.
    const loose = parseToolCallsFromText('prosa antes\n[END TOOL CALL]\nprosa después', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(loose.residueSpans.length, 1);
    assert.equal(loose.residueSpans[0].text, '[END TOOL CALL]');
    const stripped = stripToolCallResidue(loose.cleanedText, loose.residueSpans);
    assert.match(stripped, /prosa antes/);
    assert.match(stripped, /prosa después/);
    assert.doesNotMatch(stripped, /END TOOL CALL/);

    const fenced = parseToolCallsFromText('Ejemplo:\n```\n[END TOOL CALL]\n```\nY en inline: `[END TOOL CALL]` listo.', {
      allowedToolNames: ALLOWED,
      toolSchemas: SCHEMAS
    });
    assert.equal(fenced.residueSpans.length, 0, 'code-context closers are documentation by construction');
  });

  it('code-fence immunity: a fenced incident-3 span stays documentation, no salvage, no spans', () => {
    const fenced = 'Example of the broken form:\n```\n[TOOL_CALL]Bash{command: "ls"}\n[END TOOL CALL]\n```\nDone.';
    const result = parseToolCallsFromText(fenced, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.residueSpans.length, 0, 'fence text is never a residue span by construction');
    assert.match(result.cleanedText, /\[TOOL_CALL\]Bash\{command: "ls"\}/, 'the example must survive verbatim');
    assert.equal(stripToolCallResidue(result.cleanedText, result.residueSpans), result.cleanedText);
  });
});

describe('repairLooseToolPayload invariants', () => {
  it('valid JSON is a fixed point: the repair does not run', () => {
    assert.equal(repairLooseToolPayload('{"command": "ls", "n": 1.5, "ok": true}'), null);
  });

  it('incident-3 region repairs into strict JSON with the exact command', () => {
    const region = `{command:${INCIDENT3_CMD}", "description": "d"}`;
    const repaired = repairLooseToolPayload(region);
    assert.notEqual(repaired, null);
    assert.equal(JSON.parse(repaired).command, INCIDENT3_CMD);
  });

  it('true/false/null stay literals only when followed by a delimiter', () => {
    assert.equal(JSON.parse(repairLooseToolPayload('{a:true, b:null}')).a, true);
    // `falsey` empieza con false pero NO va seguido de delimitador → string.
    assert.equal(JSON.parse(repairLooseToolPayload('{a:falsey"}')).a, 'falsey');
  });

  it('end-of-input counts as a delimiter: a truncated {a:true keeps the literal', () => {
    assert.equal(repairLooseToolPayload('{a:true'), '{"a":true');
  });

  it('backslashes in a loose value round-trip as bytes, never as escapes', () => {
    const repaired = repairLooseToolPayload('{command:dir C:\\tmp"}');
    assert.equal(JSON.parse(repaired).command, 'dir C:\\tmp');
  });

  it('numbers are consumed as whole tokens, not split at the decimal point', () => {
    assert.equal(JSON.parse(repairLooseToolPayload('{timeout: 1.5, command: "ls"}')).timeout, 1.5);
  });
});

describe('stripToolCallResidue is position-driven, never a search', () => {
  it('removes the span at its recorded offset', () => {
    assert.equal(stripToolCallResidue('X [SPAN] Y', [{ text: '[SPAN]', at: 2 }]), 'X  Y');
  });

  it('a wrong offset fails open — nothing is removed, never a first-indexOf fallback', () => {
    assert.equal(stripToolCallResidue('X [SPAN]', [{ text: '[SPAN]', at: 0 }]), 'X [SPAN]');
  });

  it('a documentation copy BEFORE the real condemned span survives (mis-strip guard)', () => {
    // Copia fenceada de los MISMOS bytes antes del span real: el parser condena
    // solo el segundo (posicion registrada); un strip por indexOf borraria el doc.
    const SPAN = '[TOOL_CALL]Bash{command:ls", "description":"d"}}\n[END TOOL CALL]';
    const text = `Ejemplo:\n\`\`\`\n${SPAN}\n\`\`\`\nY ahora en serio:\n${SPAN}`;
    const result = parseToolCallsFromText(text, { allowedToolNames: ALLOWED, toolSchemas: SCHEMAS });

    assert.equal(result.toolCalls.length, 0, 'after-prose span must not execute');
    assert.equal(result.errors[0]?.type, 'truncated_tool_call');
    const stripped = stripToolCallResidue(result.cleanedText, result.residueSpans);
    assert.match(stripped, /```\n\[TOOL_CALL\]Bash/, 'the fenced documentation copy must survive');
    assert.ok(stripped.trim().endsWith('Y ahora en serio:'), 'only the real condemned span is removed');
  });

  it('a tail-trimmed edge span is removed by prefix verification at its offset', () => {
    assert.equal(stripToolCallResidue('abc', [{ text: 'abc\n', at: 0 }]), '');
  });

  it('channel filtering keeps coordinate spaces apart', () => {
    const spans = [{ text: 'abc', at: 0, channel: 'recovered' }];
    assert.equal(stripToolCallResidue('abcdef', spans, { channel: 'text' }), 'abcdef');
    assert.equal(stripToolCallResidue('abcdef', spans, { channel: 'recovered' }), 'def');
  });

  it('without spans it is the identity — no second independent span search', () => {
    const text = `prose ${GARBAGE_CALL}`;
    assert.equal(stripToolCallResidue(text), text);
    assert.equal(stripToolCallResidue(text, []), text);
  });
});

// ---------------------------------------------------------------------------
// Loop-level fixtures (B stream / C non-stream) on the canned-upstream harness.
// ---------------------------------------------------------------------------

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

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;

const thinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`;

// Frame nativo con nombre no declarado: la unica via de tener toolErrors con
// cleanedText vacio y cero spans (los errores del parser de texto dejan debris).
const nativeUnknownFrame = () => `data: ${JSON.stringify({
  choices: [{
    delta: { phase: 'answer', tool_calls: [{ index: 0, type: 'function', function: { name: 'nope', arguments: '{}' } }] },
    finish_reason: null
  }]
})}\n\n`;

const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const turnOf = (...frames) => () => Readable.from([...frames, STOP]);

/** El texto entero en frames de ≤7 chars — la forma del incidente en el wire. */
const chunkedTurn = (text, chunk = 7) => () => {
  const frames = [];
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

const baseCtx = (sendRequest, overrides) => ({
  message_id: 'msg_salvage3',
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

const toolUseNames = (output) =>
  [...output.matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]*)"/g)].map(m => m[1]);

const visibleTextOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"text_delta","text":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1]))
    .join('');

const thinkingTextOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"thinking_delta","thinking":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1]))
    .join('');

const toolArgsOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"input_json_delta","partial_json":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1]))
    .join('');

// Turno del incidente 1: la llamada (nombre inventado, JSON valido) abre el turno y
// la narracion viene despues — unknown_tool + prosa visible en el mismo attempt.
const GARBAGE_THEN_PROSE = `${GARBAGE_CALL}\nThe tool seems broken here.`;

describe('loop B: incident-3 wire replay (first-content, matrix row 1)', () => {
  it('settles with a Bash tool_use, burns no retry, zero marker bytes anywhere in the SSE stream', async () => {
    const sender = scriptedSender();
    const res = await runStream(chunkedTurn(INCIDENT3), sender);

    assert.equal(sender.calls.length, 0, 'salvage must not burn any retry');
    assert.deepEqual(toolUseNames(res.output), ['Bash']);
    assert.equal(JSON.parse(toolArgsOf(res.output)).command, INCIDENT3_CMD, 'exact find command');
    // Criterio de aceptacion 1: cero marcadores en TODO el stream SSE.
    assert.doesNotMatch(res.output, /TOOL_CALL/i, 'zero trigger bytes anywhere on the wire');
    assert.doesNotMatch(res.output, /END TOOL CALL/i, 'zero closer bytes anywhere on the wire');
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('the same span AFTER streamed prose never becomes a tool_use (position gate on the wire)', async () => {
    const sender = scriptedSender(turnOf(answerFrame('Nada que hacer.')));
    const res = await runStream(chunkedTurn(`Voy a listar los archivos.\n${INCIDENT3_SPAN}\n`), sender);

    assert.deepEqual(toolUseNames(res.output), [], 'malformed-after-prose must not execute');
    const visible = visibleTextOf(res.output);
    assert.match(visible, /Voy a listar los archivos\./);
    assert.doesNotMatch(visible, /TOOL_CALL/i, 'the condemned span never reaches the wire as text');
    assert.doesNotMatch(res.output, /"type":"error"/, 'prose exists — no 502');
  });
});

describe('loop B: tool_error after prose → one text-suppressed retry (matrix rows on incident 1)', () => {
  it('forwards ONLY tool_use from the retry; its text and thinking never hit the wire', async () => {
    const retryTurn = turnOf(
      thinkFrame('secret retry thinking'),
      answerFrame(`${GOOD_CALL}\nDone reading now.`)
    );
    const sender = scriptedSender(retryTurn);
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(answerFrame(GARBAGE_THEN_PROSE)), sender);
    });

    assert.equal(sender.calls.length, 1, 'exactly the one compensation slot');
    assert.deepEqual(toolUseNames(res.output), ['read_file'], 'the retry\'s valid call is forwarded');
    const visible = visibleTextOf(res.output);
    assert.match(visible, /The tool seems broken here\./, 'attempt-1 prose stays');
    assert.doesNotMatch(visible, /Done reading now/, 'retry text is suppressed');
    assert.doesNotMatch(thinkingTextOf(res.output), /secret retry thinking/, 'retry thinking is suppressed');
    assert.ok(warns.some(l => /被拒绝 \(tool_error\)/.test(l)), `expected the tool_error rejection warn, got:\n${warns.join('\n')}`);
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('when the suppressed retry also fails, attempt-1 prose is delivered clean — no 502, no markers', async () => {
    const sender = scriptedSender(turnOf(answerFrame('Nope, still nothing useful.')));
    const res = await runStream(turnOf(answerFrame(GARBAGE_THEN_PROSE)), sender);

    assert.equal(sender.calls.length, 1, 'the slot is single: no second retry');
    const visible = visibleTextOf(res.output);
    assert.match(visible, /The tool seems broken here\./);
    assert.doesNotMatch(visible, /Nope, still nothing useful/, 'failed retry text never reaches the client');
    assert.doesNotMatch(visible, /TOOL.?CALL/i, 'zero protocol bytes on the wire');
    assert.doesNotMatch(res.output, /"type":"error"/, 'prose exists — no 502');
    assert.match(res.output, /"type":"message_stop"/);
  });
});

describe('loop B: delivery strips recorded residue from recoveredBuffer (layer 3)', () => {
  it('slot already burned by missing_tool → tool_error round delivers as-is, but residue-free, with both warns', async () => {
    // attempt 1: prosa de accion (missing_tool consume el cupo). attempt 2 (retry,
    // sin suprimir): llamada con nombre inventado + prosa → tool_error con cupo
    // agotado → break → entrega. El span condenado esta en recoveredBuffer; la
    // entrega lo pela por posicion registrada. Sin la llamada a stripToolCallResidue
    // en la entrega de recoveredBuffer este test falla (mutation check, capa 3 B).
    const retryTurn = turnOf(answerFrame(`${GARBAGE_CALL}\nExtra follow-up prose.`));
    const sender = scriptedSender(retryTurn);
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(answerFrame('I will run the build now.')), sender);
    });

    assert.equal(sender.calls.length, 1);
    const visible = visibleTextOf(res.output);
    assert.match(visible, /I will run the build now\./);
    assert.match(visible, /Extra follow-up prose\./);
    assert.doesNotMatch(visible, /TOOL.?CALL/i, 'the condemned span must be stripped at delivery');
    assert.doesNotMatch(visible, /garbage/, 'no payload bytes either');
    assert.ok(warns.some(l => /工具协议出错但已产出内容/.test(l)), 'degraded-delivery warn kept');
    assert.ok(warns.some(l => /剥离协议残渣/.test(l)), 'the strip leaves a log trace');
    assert.ok(
      warns.some(l => /再次 tool_error，补偿名额已用/.test(l)),
      `the burned-slot give-up must log, got:\n${warns.join('\n')}`
    );
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('a failed suppressed retry still delivers attempt-1 recovered text (residue-stripped), not an empty bucket', async () => {
    // Span sin closer en attempt 1: la parte payload+prosa NO es residuo por
    // construccion y pre-diff llegaba al cliente — el banco la conserva aunque el
    // retry suprimido fracase. Solo el trigger+tail (probadamente protocolo) se pela.
    const NO_CLOSER_AFTER_PROSE = 'Working on it.\n[TOOL_CALL]Bash{command:ls", "description":"d"}\nAhora reviso los resultados.';
    const sender = scriptedSender(turnOf(answerFrame('retry prose that stays off the wire')));
    const res = await runStream(chunkedTurn(NO_CLOSER_AFTER_PROSE), sender);

    assert.equal(sender.calls.length, 1, 'tool_error after prose consumes the single slot');
    assert.deepEqual(toolUseNames(res.output), []);
    const visible = visibleTextOf(res.output);
    assert.match(visible, /Working on it\./);
    assert.match(visible, /Ahora reviso los resultados\./, 'attempt-1 recovered tail is delivered from the bank');
    assert.doesNotMatch(visible, /TOOL_CALL/, 'trigger bytes are stripped');
    assert.doesNotMatch(visible, /retry prose that stays off the wire/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });
});

describe('loop B: required unfulfilled after streamed prose', () => {
  it('closes with end_turn + warn instead of a 502 after streamed prose', async () => {
    const sender = scriptedSender(turnOf(answerFrame('Second prose, still no tool.')));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(
        turnOf(answerFrame('Cannot pick a tool, sorry.')),
        sender,
        { toolChoice: 'required' }
      );
    });

    assert.equal(sender.calls.length, 1, 'the single after-prose compensation retry');
    assert.doesNotMatch(res.output, /"type":"error"/, 'a half-delivered message plus error is worse than an unmet required');
    assert.match(res.output, /"stop_reason":"end_turn"/);
    assert.ok(warns.some(l => /required 未兑现/.test(l)), `expected the required-downgrade warn, got:\n${warns.join('\n')}`);
  });
});

describe('loop B: emptiness judged on debris-stripped text (502 discipline)', () => {
  it('a debris-only turn under required still 502s even though text deltas were written', async () => {
    // Payload sintetico DESBALANCEADO (releaseDebris → textDelta): residuo real en
    // el wire. La mutacion `strippedVisibleText = visibleText` sobrevive sin este
    // test — el debris visible bloquearia el brazo required del 502.
    const DEBRIS_TURN = '{"name":"Bash","arguments":{"command":"ls"';
    const sender = scriptedSender(turnOf(answerFrame(DEBRIS_TURN)), turnOf(answerFrame(DEBRIS_TURN)));
    const res = await runStream(turnOf(answerFrame(DEBRIS_TURN)), sender, { toolChoice: 'required' });

    assert.notEqual(visibleTextOf(res.output), '', 'the debris DID stream as visible text');
    assert.match(res.output, /invalid_tool_call_error/, 'a residue-only turn is not an answer');
  });

  it('a first-content payload + closer with an unknown name is provable protocol: recovered channel, tool_error retries, never visible', async () => {
    // Spec narrated-toolcall (defecto 2): antes era un rechazo blando visible (y su
    // emittedProse envenenaba el resto del lote). Ahora sigue la disciplina de GARBAGE_CALL.
    const HARD_TURN = '{"name":"nope","arguments":{}}\n[END TOOL CALL]';
    const sender = scriptedSender(turnOf(answerFrame(HARD_TURN)), turnOf(answerFrame(HARD_TURN)));
    const res = await runStream(turnOf(answerFrame(HARD_TURN)), sender);

    assert.equal(sender.calls.length, 2, 'tool_error retries run to the cap');
    assert.match(JSON.stringify(sender.calls[0]), /nope do not exist/, 'the tool_error hint names the bad tool');
    assert.match(res.output, /invalid_tool_call_error/);
    assert.equal(visibleTextOf(res.output), '', 'the condemned span never reaches the wire as text');
  });

  it('a soft-REJECTED synthetic payload (no closer) is never 502-voided — it may BE the answer', async () => {
    // Payload balanceado SIN closer (releaseRejectedSpan): por doctrina puede ser la
    // respuesta; no entra al registro y no puede vaciar el turno a 502.
    const REJECTED_TURN = '{"name":"nope","arguments":{}}';
    const sender = scriptedSender(turnOf(answerFrame(REJECTED_TURN)));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(answerFrame(REJECTED_TURN)), sender, { toolChoice: 'required' });
    });

    assert.doesNotMatch(res.output, /"type":"error"/, 'an answer-shaped payload must not be voided');
    assert.match(res.output, /"stop_reason":"end_turn"/);
    assert.match(visibleTextOf(res.output), /"name":"nope"/, 'the payload is delivered as the answer');
    assert.ok(warns.some(l => /required 未兑现/.test(l)));
  });

  it('P9 (loop 2): multi-line, closer-less, anchor-less first-content payload cut by finish_reason=length → residue-only 502, body lines never delivered as prose', async () => {
    // Sin ancla (ni closer, ni trigger, ni candidato) nada de lo que sigue puede ser una
    // llamada: el residuo cubre HASTA EL FINAL, no solo la primera linea. Antes del loop 2
    // las lineas del cuerpo salian como bloque de texto con 200.
    const LENGTH_STOP = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    const cutByLength = (...frames) => () => Readable.from([...frames, LENGTH_STOP]);
    const MULTI = '{"name":"Bash","arguments":{"command":"echo hi\nline two\nline three';
    const sender = scriptedSender(cutByLength(answerFrame(MULTI)), cutByLength(answerFrame(MULTI)));
    const res = await runNonStream(cutByLength(answerFrame(MULTI)), sender);

    assert.equal(res.statusCode, 502, 'a residue-only turn has no deliverable content');
    assert.equal(res.body?.error?.type, 'invalid_tool_call_error');
    assert.doesNotMatch(JSON.stringify(res.body), /line two/, 'the body lines are residue, not an answer');
  });

  it('residue-only turn (recovered channel), retries exhausted → 502 as today, nothing visible', async () => {
    const sender = scriptedSender(turnOf(answerFrame(GARBAGE_CALL)), turnOf(answerFrame(GARBAGE_CALL)));
    const res = await runStream(turnOf(answerFrame(GARBAGE_CALL)), sender);

    assert.equal(sender.calls.length, 2, 'no prose on the wire → retries run to the cap');
    assert.match(res.output, /invalid_tool_call_error/);
    assert.equal(visibleTextOf(res.output), '');
  });
});

describe('loop C: delivery strip is span-gated and round-consistent', () => {
  it('good call + condemned span in one turn: delivered without the span, warn kept', async () => {
    // Hay tool_use (no hay 502) y hay residuo registrado → la entrega pela el span
    // condenado por posicion. Sin la llamada a stripToolCallResidue en la entrega
    // de C este test falla (mutation check, capa 3 C).
    const sender = scriptedSender();
    let res;
    const warns = await captureWarns(async () => {
      res = await runNonStream(turnOf(answerFrame(`${GOOD_CALL}\n${GARBAGE_CALL}\nAquí está el resultado.`)), sender);
    });

    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /Aquí está el resultado\./, 'real prose survives the strip');
    assert.doesNotMatch(text, /TOOL.?CALL/i, 'the condemned span must not be delivered');
    assert.doesNotMatch(text, /garbage/);
    assert.ok(warns.some(l => /剥离协议残渣/.test(l)), `expected the strip warn, got:\n${warns.join('\n')}`);
  });

  it('multi-round: the delivered round\'s spans are the ones used (cross-round consistency)', async () => {
    // round 1: error nativo puro (cero texto, cero spans) → tool_error retry.
    // round 2: llamada buena + span condenado + prosa → entrega. Si el cambio de
    // ronda no actualizara roundResidueSpans, la entrega usaria los spans vacios
    // de la ronda 1 y el residuo saldria integro (mutation check, condena cruzada).
    const round2 = turnOf(answerFrame(`${GOOD_CALL}\n${GARBAGE_CALL}\nAquí está el resultado.`));
    const sender = scriptedSender(round2);
    const res = await runNonStream(turnOf(nativeUnknownFrame()), sender);

    assert.equal(sender.calls.length, 1);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /Aquí está el resultado\./);
    assert.doesNotMatch(text, /TOOL.?CALL/i, 'round-2 residue must strip with round-2 spans');
  });

  it('agent-tagged prose before the condemned span: strip-before-tags keeps offsets honest', async () => {
    // El span se registra contra el texto CRUDO del parser; la entrega pela primero
    // el residuo (posiciones validas) y despues los agent tags — el orden inverso
    // desplazaria los offsets y el residuo sobreviviria.
    const TAGGED = `${GOOD_CALL}\n<agent_final>Listo el reporte.</agent_final>\n[TOOL_CALL]Bash{command:ls", "description":"d"}}\n[END TOOL CALL]`;
    const sender = scriptedSender();
    const res = await runNonStream(turnOf(answerFrame(TAGGED)), sender);

    assert.equal(res.statusCode, 200);
    const text = (res.body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /Listo el reporte\./);
    assert.doesNotMatch(text, /agent_final/, 'tags stripped');
    assert.doesNotMatch(text, /TOOL_CALL/i, 'residue stripped despite the tag shift');
  });

  it('a debris-only turn strips to empty and 502s — never an empty-content message', async () => {
    // Repro del corner item-9 (review loop 2, verificado por ejecucion): payload
    // sin sobre, desbalanceado y con forma de leak → debris REGISTRADO con cero
    // toolErrors → malformed_protocol agota su retry → sin este fix la entrega
    // pelaba el residuo DESPUES del juicio de vacio y salia content: [] con 200.
    // El juicio de residue-only de C corre sobre el texto YA pelado — el mismo
    // que iria a los content blocks — y toma el 502 de clase invalid_tool_call.
    const DEBRIS = '{"name": "Bash", "arguments": {"command": "ls"';
    const sender = scriptedSender(turnOf(answerFrame(DEBRIS)));
    const res = await runNonStream(turnOf(answerFrame(DEBRIS)), sender);

    assert.equal(sender.calls.length, 1, 'one malformed_protocol retry, then give up');
    assert.equal(res.statusCode, 502, 'an all-residue turn has no deliverable content');
    assert.equal(res.body?.error?.type, 'invalid_tool_call_error');
    assert.notEqual(
      Array.isArray(res.body?.content) && res.body.content.length === 0 && res.statusCode === 200,
      true,
      'an empty content array with 200 breaks the client parse'
    );
  });

  it('an orphan-closer-only turn 502s — the raw closer never reaches the client', async () => {
    // `[END TOOL CALL]` solo no enciende ningun trigger (el regex no reconoce
    // `[END`): cruzaba el fast path como texto y se ENTREGABA crudo tras agotar
    // malformed_protocol (verificado pre-fix: 200 + content=[{text:"[END TOOL
    // CALL]"}]). El cierre huerfano es residuo inequivoco: se registra en el
    // ledger, la entrega lo pela, y un turno que era 100% cierre queda vacio →
    // 502 invalid_tool_call_error.
    const sender = scriptedSender(turnOf(answerFrame('[END TOOL CALL]')));
    const res = await runNonStream(turnOf(answerFrame('[END TOOL CALL]')), sender);

    assert.equal(res.statusCode, 502, 'a closer-only turn has no deliverable content');
    assert.equal(res.body?.error?.type, 'invalid_tool_call_error');
    const text = (res.body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    assert.doesNotMatch(text, /END TOOL CALL/, 'raw protocol never reaches a client under any outcome');
  });

  it('prose + trailing orphan closer delivers the prose with the closer removed — never a 502', async () => {
    // La linea que NO se puede cruzar en la otra direccion: prosa real + un
    // cierre extraviado sigue siendo una respuesta. Se pela el cierre, se
    // entrega la prosa, status 200 — containsOrphanProtocolResidue sigue
    // encendiendo el retry (detECCION intacta), pero agotado el retry la
    // entrega jamas convierte prosa en 502.
    const PROSE_PLUS_CLOSER = 'El reporte quedó guardado en disco.\n[END TOOL CALL]';
    const sender = scriptedSender(turnOf(answerFrame(PROSE_PLUS_CLOSER)));
    const res = await runNonStream(turnOf(answerFrame(PROSE_PLUS_CLOSER)), sender);

    assert.equal(res.statusCode, 200, 'prose must never be upgraded into a 502');
    const text = (res.body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /El reporte quedó guardado en disco\./);
    assert.doesNotMatch(text, /END TOOL CALL/, 'the stray closer is stripped at delivery');
    assert.equal(res.body.stop_reason, 'end_turn');
  });

  it('C incident-3 non-stream (first-content): the whole-text path salvages the same call', async () => {
    const sender = scriptedSender();
    const res = await runNonStream(turnOf(answerFrame(INCIDENT3)), sender);

    assert.equal(res.statusCode, 200);
    assert.equal(sender.calls.length, 0, 'no retry burned');
    const blocks = res.body?.content || [];
    const uses = blocks.filter(b => b.type === 'tool_use');
    assert.equal(uses.length, 1);
    assert.equal(uses[0].name, 'Bash');
    assert.equal(uses[0].input.command, INCIDENT3_CMD);
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});
