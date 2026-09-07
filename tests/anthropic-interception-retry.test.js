// La defensa contra la interceptacion de plataforma: el modelo regresa por habito RL a la
// forma nativa, la plataforma se la come server-side y le inyecta "Tool <name> does not
// exists"; el turno llega como prosa valida y ningun retry disparaba. La unica evidencia
// que el gateway ve en vivo son los drops role:function del normalizador (Defect A) —
// aqui se pina que esa evidencia dispara exactamente UN retry con el hint canonico.
//
// Set before anything pulls in config/index.js, which snapshots env at load.
// node --test runs each file in its own process, so this cannot leak.
// The config clamps this to [2, 6]; 3 keeps the cap-mutation tests short.
process.env.AGENT_TURN_MAX_ATTEMPTS = '3';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { handleAnthropicStream, handleAnthropicNonStream } = require('../src/controllers/anthropic.js');
const { logger } = require('../src/utils/logger.js');

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

const createMockStreamResponse = () => ({
  output: '',
  headers: {},
  writableEnded: false,
  destroyed: false,
  set(headers) {
    Object.assign(this.headers, headers);
    return this;
  },
  status() {
    return this;
  },
  write(chunk) {
    this.output += String(chunk);
    return true;
  },
  end(chunk = '') {
    this.output += String(chunk);
    this.writableEnded = true;
  }
});

const createMockJsonResponse = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  set(headers) {
    Object.assign(this.headers, headers);
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  }
});

const answerFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'answer', content }, finish_reason: null }]
})}\n\n`;

const thinkFrame = (content) => `data: ${JSON.stringify({
  choices: [{ delta: { phase: 'think', content }, finish_reason: null }]
})}\n\n`;

// Forma exacta del incidente 2026-08-31 08:33: la plataforma consumio el tool call nativo
// del modelo y reinyecto su lookup de registry como frame role:function. Defect A lo
// dropea del stream; interceptedToolNames es la huella que queda.
const interceptionFrame = (name) => `data: ${JSON.stringify({
  choices: [{
    delta: { role: 'function', phase: 'answer', name, content: `Tool ${name} does not exists` },
    finish_reason: null
  }]
})}\n\n`;

const STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** One upstream turn from raw SSE frames, then a clean stop. */
const turnOf = (...frames) => () => Readable.from([...frames, STOP]);

// La narracion NO debe matchear looksLikeUnexecutedToolAction ("I'll run..."): si lo
// hiciera, missing_tool taparia al branch intercepted y la mutacion que lo borra
// pasaria desapercibida.
const NARRATION = 'The Bash tool seems unavailable in this environment, so the task cannot continue.';
const BRACKET_CALL = '[TOOL CALL]{"name":"read_file","arguments":{"path":"a.txt"}}[END TOOL CALL]';

// Leak real #1 (sesion del usuario, 2026-08-31): payload + closer, SIN opener.
// Probable mecanica: el modelo emitio el opener nativo por habito RL, la plataforma
// se lo comio server-side, y el resto se filtro como texto visible.
const LEAK_PAYLOAD_CLOSER = [
  '{"name": "Bash", "arguments": {"command": "find . -type f 2>/dev/null", "description": "Check existing bmad-output docs"}}',
  '[END TOOL CALL]',
  '{"name": "Bash", "arguments": {"command": "ls"}}',
  '[END TOOL CALL]'
].join('\n');

// Leak real #2: JSON COMPLETO y valido al inicio de la respuesta (arrays/objetos
// anidados) y closers DOBLADOS. La deteccion (b) debe disparar exactamente aqui.
const LEAK_VALID_JSON_DOUBLE_CLOSER = [
  '{"name": "AskUserQuestion", "arguments": {"questions": [{"question": "Deploy to which environment?", "header": "Env", "options": [{"label": "dev", "description": "staging first"}, {"label": "prod", "description": "straight to production"}], "multiSelect": false}]}}',
  '[END TOOL CALL]',
  '[END TOOL CALL]'
].join('\n');

// Leak real #3 (live-verified 2026-08-31 10:12–10:17): payload MCP de context7 +
// [END TOOL CALL], sin opener, entregado como texto con CERO lineas de retry en logs.
const LEAK_MCP_CONTEXT7 = [
  '{"name": "mcp__context7__resolve-library-id", "arguments": {"libraryName": "heroui", "query": "table component"}}',
  '[END TOOL CALL]'
].join('\n');

// Leak SIN closer: payload pelado al inicio de la respuesta. Es RESIDUO (forma de leak,
// isLeakedToolPayloadShape) pero no protocolo demostrable → sigue disparando
// malformed_protocol. Desde el spec narrated-toolcall (2026-09-02) los leaks CON closer y
// nombre no declarado son errores DUROS (unknown_tool → retry tool_error), asi que los
// tests que pinean la defensa malformed_protocol usan esta forma.
const LEAK_PAYLOAD_NO_CLOSER = '{"name": "Bash", "arguments": {"command": "find . -type f 2>/dev/null"}}';

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
  message_id: 'msg_intercept',
  model: 'qwen-test',
  hasTools: true,
  toolChoice: 'auto',
  allowedToolNames: ['read_file'],
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

describe('interception-aware retry (stream)', () => {
  it('recovers the turn: one retry with the canonical hint, tool_use after the narration', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 1, 'the interception must trigger exactly one retry');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);

    const retryBody = JSON.stringify(sender.calls[0]);
    assert.match(retryBody, /did not reach the client/, 'hint must say the call was lost, nothing more');
    assert.ok(retryBody.includes('[TOOL CALL]'), 'hint must teach the canonical bracket marker');
    assert.doesNotMatch(retryBody, /<tool_call/i, 'hint must never re-seed the native form');

    // tool_use despues de la narracion ya streameada: mejor que una sesion muerta.
    const narrationAt = res.output.indexOf('unavailable');
    const toolUseAt = res.output.indexOf('"type":"tool_use"');
    assert.ok(narrationAt !== -1 && toolUseAt > narrationAt, 'tool_use must follow the streamed narration');
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('two consecutive interceptions: exactly one retry, closes without error events', async () => {
    const sender = scriptedSender(
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)),
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION))
    );
    const res = await runStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 1, 'second interception must deliver as-is, no loop');
    assert.doesNotMatch(res.output, /"type":"error"/);
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('the cap is the interception cap itself, not the after-prose guard', async () => {
    // Sin narracion no hay texto visible, asi que la concesion "una compensacion tras
    // prosa" nunca se activa: solo el tope dedicado puede parar el loop. Con
    // AGENT_TURN_MAX_ATTEMPTS=3, quitar el tope daria 2 retries, no 1.
    const sender = scriptedSender(
      turnOf(interceptionFrame('read_file')),
      turnOf(interceptionFrame('read_file')),
      turnOf(interceptionFrame('read_file'))
    );
    await runStream(turnOf(interceptionFrame('read_file')), sender);

    assert.equal(sender.calls.length, 1, 'exactly ONE interception retry per request');
  });

  it('benign speculative drop: drops alongside an accepted call never retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(interceptionFrame('read_file'), answerFrame(BRACKET_CALL)), sender);

    assert.equal(sender.calls.length, 0, 'an accepted bracket call means the turn is fine');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('no tools in play: drops on a prose-only request never retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runStream(
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)),
      sender,
      { hasTools: false, allowedToolNames: [] }
    );

    assert.equal(sender.calls.length, 0);
    assert.match(res.output, /"type":"message_stop"/);
  });
});

describe('interception-aware retry (non-stream)', () => {
  it('clean retry: nothing was sent yet, tool_use lands in the response', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /did not reach the client/);
    assert.equal(res.statusCode, 200);
    const toolBlocks = (res.body?.content || []).filter(block => block.type === 'tool_use');
    assert.deepEqual(toolBlocks.map(block => block.name), ['read_file']);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('same one-shot cap: a second interception delivers the prose, not a 502', async () => {
    // Este loop no tiene guard de texto-ya-enviado (nada salio al cliente), asi que sin
    // el tope dedicado reintentaria hasta maxAttempts: 2 retries en vez de 1.
    const sender = scriptedSender(
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)),
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION))
    );
    const res = await runNonStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 1, 'exactly ONE interception retry per request');
    assert.equal(res.statusCode, 200, 'deliver as-is, not an error');
    const text = (res.body?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    assert.match(text, /unavailable/, 'the narration is the answer the client gets');
    assert.equal(res.body.stop_reason, 'end_turn');
  });

  it('an empty retry after interception delivers the narration, never a 502 (finding 2)', async () => {
    // attempt 1 = drops + narracion → retry de interceptacion; attempt 2 = vacio.
    // El rebuild del retry descarta el cleanedText del attempt 1; sin el fallback,
    // el handler caia en el 502 de "!cleanedText.trim()" y cambiaba narracion por error.
    const sender = scriptedSender(turnOf());
    const res = await runNonStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(res.statusCode, 200, 'the narration must beat a 502');
    const text = (res.body?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    assert.match(text, /unavailable/, 'the intercepted attempt narration is the fallback answer');
    assert.equal(res.body.stop_reason, 'end_turn');
    assert.equal(sender.calls.length, 2, 'interception retry + the empty-reason retry that failed');
  });

  it('the per-attempt drop reset lets later retries succeed (finding 7)', async () => {
    // turn 1 = interceptacion + narracion, turn 2 = vacio, turn 3 = bracket call.
    // Sin la linea `normalizeDelta.interceptedToolNames.length = 0`, los drops del
    // attempt 1 siguen vivos en el attempt 2 → segunda "interceptacion" fantasma →
    // el tope corta el loop y la respuesta se degrada (1 retry, sin tool_use).
    const sender = scriptedSender(turnOf(), turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 2, 'interception retry then empty retry');
    assert.equal(res.statusCode, 200);
    const toolBlocks = (res.body?.content || []).filter(block => block.type === 'tool_use');
    assert.deepEqual(toolBlocks.map(block => block.name), ['read_file']);
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('benign speculative drop: an accepted call alongside drops never retries', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(interceptionFrame('read_file'), answerFrame(BRACKET_CALL)), sender);

    assert.equal(sender.calls.length, 0);
    const toolBlocks = (res.body?.content || []).filter(block => block.type === 'tool_use');
    assert.deepEqual(toolBlocks.map(block => block.name), ['read_file']);
  });

  it('no tools in play: drops on a prose-only request never retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runNonStream(
      turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)),
      sender,
      { hasTools: false, allowedToolNames: [] }
    );

    assert.equal(sender.calls.length, 0);
    assert.equal(res.statusCode, 200);
    const text = (res.body?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    assert.match(text, /unavailable/);
  });
});

describe('interception observability (finding 3)', () => {
  it('a masking reason still logs the dropped names', async () => {
    // tool_choice=required gana el slot de razon, pero el log DEBE decir que ademas
    // hubo drops: en produccion esa linea junto al burst de UPSTREAM_NORMALIZER es
    // la unica evidencia de que la interceptacion ocurrio bajo otra razon.
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    let hint;
    const warns = await captureWarns(async () => {
      await runStream(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)), sender, { toolChoice: 'required' });
      hint = JSON.stringify(sender.calls[0]);
    });

    assert.ok(
      warns.some(line => /required; dropped: read_file/.test(line)),
      `expected a "required; dropped: read_file" warn, got:\n${warns.join('\n')}`
    );
    // finding 4 para la razon required: el hint lleva el dato clave ademas del suyo.
    assert.match(hint, /You did not call any tool/);
    assert.match(hint, /did not reach the client/);
  });

  it('the give-up on a second interception is logged with the names', async () => {
    const sender = scriptedSender(turnOf(interceptionFrame('read_file')), turnOf(interceptionFrame('read_file')));
    const warns = await captureWarns(async () => {
      await runStream(turnOf(interceptionFrame('read_file')), sender);
    });

    assert.equal(sender.calls.length, 1);
    assert.ok(
      warns.some(line => /协议恢复重试已用完/.test(line) && /dropped: read_file/.test(line)),
      `expected a give-up warn with the dropped names, got:\n${warns.join('\n')}`
    );
  });
});

describe('intercepted outranks missing_tool (finding 4)', () => {
  it('action-flavored narration after an interception still gets the intercepted hint', async () => {
    // "I'll run..." matchea looksLikeUnexecutedToolAction. Con el orden correcto la
    // razon es intercepted y el hint es SOLO el canonico; con el orden invertido la
    // razon seria missing_tool y su texto base ("described an action") apareceria en
    // el hint (via el append enmascarado) — esta prueba falla bajo ese swap.
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(
      turnOf(interceptionFrame('read_file'), answerFrame("I'll run the Bash command again.")),
      sender
    );

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /did not reach the client/);
    assert.doesNotMatch(hint, /described an action/, 'missing_tool won the slot: precedence regressed');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
  });
});

describe('documented limitation: the after-prose allowance is shared (finding 8)', () => {
  it('a prior prose retry exhausts the allowance a later interception needs', async () => {
    // attempt 1: prosa missing_tool consume retriedAfterVisibleText → retry 1.
    // attempt 2: interceptacion + narracion — el tope compartido de protocolo esta
    // libre, pero la guarda de texto-ya-enviado corta el loop → entrega tal cual.
    const sender = scriptedSender(turnOf(interceptionFrame('read_file'), answerFrame(NARRATION)));
    const res = await runStream(turnOf(answerFrame('I will run the build now.')), sender);

    assert.equal(sender.calls.length, 1, 'only the missing_tool retry fired');
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /described an action/);
    assert.doesNotMatch(hint, /did not reach the client/, 'no drops existed on attempt 1');
    assert.match(res.output, /"type":"message_stop"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });
});

describe('malformed bracket protocol (finding 10)', () => {
  it('payload with no opener and no closer: retry carries the malformed hint and recovers', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(answerFrame(LEAK_PAYLOAD_NO_CLOSER)), sender);

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /was NOT executed/, 'must say the call was malformed and not executed');
    assert.ok(hint.includes('[TOOL CALL]'), 'must teach the canonical opener');
    assert.doesNotMatch(hint, /<tool_call/i);
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('payload + closer with no opener and an UNDECLARED name is provable protocol (spec narrated-toolcall): tool_error retry names the allowed tools and recovers', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(answerFrame(LEAK_PAYLOAD_CLOSER)), sender);

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /invalid, truncated, or unknown tool call/, 'the reason is tool_error, not malformed_protocol');
    assert.match(hint, /Bash do not exist/, 'the hint names the bad tool');
    assert.match(hint, /Use ONLY these exact tool names: read_file/);
    assert.ok(hint.includes('[TOOL CALL]'), 'must teach the canonical opener');
    assert.doesNotMatch(hint, /<tool_call/i);
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.doesNotMatch(res.output, /"type":"error"/);
    assert.doesNotMatch(res.output, /find \. -type f/, 'the condemned payload never reaches the wire');
  });

  it('a complete valid JSON payload with doubled closers and an undeclared name is a tool_error too (leak sample #2)', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(answerFrame(LEAK_VALID_JSON_DOUBLE_CLOSER)), sender);

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /AskUserQuestion do not exist/);
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('an orphan closer alone in prose fires the defense', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(answerFrame('I ran the command.\n[END TOOL CALL]')), sender);

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /was NOT executed/);
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
  });

  it('answer-start JSON without an "arguments" key does NOT fire', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(turnOf(answerFrame('{"name": "results", "count": 3}')), sender);

    assert.equal(sender.calls.length, 0, 'ordinary JSON answers must not be mistaken for leaks');
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('intercepted and malformed share ONE recovery slot per request (cap sharing)', async () => {
    // attempt 1: interceptacion sin narracion (cero texto visible — la guarda de
    // prosa nunca se activa). attempt 2: leak malformado. Solo el tope COMPARTIDO
    // puede parar aqui; con topes separados habria un segundo retry.
    const sender = scriptedSender(
      turnOf(answerFrame(LEAK_PAYLOAD_NO_CLOSER)),
      turnOf(answerFrame(BRACKET_CALL))
    );
    const res = await runStream(turnOf(interceptionFrame('read_file')), sender);

    assert.equal(sender.calls.length, 1, 'one protocol-recovery retry TOTAL, not one per reason');
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('non-stream: the leak shape (no closer) retries once and recovers tool_use', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(answerFrame(LEAK_PAYLOAD_NO_CLOSER)), sender);

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /was NOT executed/);
    assert.equal(res.statusCode, 200);
    const toolBlocks = (res.body?.content || []).filter(block => block.type === 'tool_use');
    assert.deepEqual(toolBlocks.map(block => block.name), ['read_file']);
  });
});

// ── Salvage de aperturas ausentes (spec toolcall-salvage) ──
// Los mismos leaks, pero con el nombre DECLARADO por el cliente: ya no son residuo
// que reintentar sino la llamada que el modelo intento emitir. Cero retries, cero
// texto de payload en el wire, tool_use directo. (Arriba, los mismos fixtures con
// nombres NO permitidos siguen probando la ruta de retry: la puerta de nombres es
// exactamente lo que separa ambos destinos.)

const SALVAGE_TOOLS = ['read_file', 'Bash', 'AskUserQuestion', 'mcp__context7__resolve-library-id'];

/** Todo el texto visible (text_delta) que llego al cliente, sin escapes SSE. */
const textDeltasOf = (output) =>
  [...output.matchAll(/"delta":\{"type":"text_delta","text":("(?:[^"\\]|\\.)*")\}/g)]
    .map(m => JSON.parse(m[1]))
    .join('');

describe('opener-less salvage: los tres leaks reales se vuelven tool_use', () => {
  const CASES = [
    ['leak #1: dos payloads Bash con closers', LEAK_PAYLOAD_CLOSER, ['Bash', 'Bash']],
    ['leak #2: AskUserQuestion con closers doblados', LEAK_VALID_JSON_DOUBLE_CLOSER, ['AskUserQuestion']],
    ['leak #3: payload MCP context7', LEAK_MCP_CONTEXT7, ['mcp__context7__resolve-library-id']]
  ];

  for (const [label, leak, names] of CASES) {
    it(`stream: ${label}`, async () => {
      const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
      const res = await runStream(turnOf(answerFrame(leak)), sender, { allowedToolNames: SALVAGE_TOOLS });

      assert.equal(sender.calls.length, 0, 'la llamada rescatada no debe gastar ningun retry');
      assert.deepEqual(toolUseNames(res.output), names);
      assert.equal(textDeltasOf(res.output).trim(), '', 'texto del payload llego al cliente');
      assert.match(res.output, /"stop_reason":"tool_use"/);
      assert.doesNotMatch(res.output, /"type":"error"/);
    });

    it(`non-stream: ${label}`, async () => {
      const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
      const res = await runNonStream(turnOf(answerFrame(leak)), sender, { allowedToolNames: SALVAGE_TOOLS });

      assert.equal(sender.calls.length, 0);
      assert.equal(res.statusCode, 200);
      const blocks = res.body?.content || [];
      assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), names);
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      assert.equal(text.trim(), '', 'texto del payload llego al cliente');
      assert.equal(res.body.stop_reason, 'tool_use');
    });
  }

  it('stream: los argumentos del payload rescatado llegan enteros al tool_use', async () => {
    const res = await runStream(turnOf(answerFrame(LEAK_PAYLOAD_CLOSER)), scriptedSender(), { allowedToolNames: SALVAGE_TOOLS });
    assert.match(res.output, /find \. -type f/, 'los arguments del primer payload se perdieron');
    assert.match(res.output, /"input_json_delta"/);
  });

  it('stream: el leak partido en la frontera del chunk se rescata igual (payload y closer en deltas distintos)', async () => {
    const [payloadLine, closerLine] = LEAK_MCP_CONTEXT7.split('\n');
    const res = await runStream(
      turnOf(answerFrame(payloadLine.slice(0, 40)), answerFrame(payloadLine.slice(40) + '\n'), answerFrame(closerLine)),
      scriptedSender(),
      { allowedToolNames: SALVAGE_TOOLS }
    );
    assert.deepEqual(toolUseNames(res.output), ['mcp__context7__resolve-library-id']);
    assert.equal(textDeltasOf(res.output).trim(), '');
  });
});

// ── Filtro de nombres de cliente sobre la evidencia de interceptacion ──
// La plataforma dropea sus PROPIOS frames role:function (web_search, web_extractor,
// sin nombre) en turnos de prosa normales. Antes contaban como evidencia de
// interceptacion: retry 'intercepted' falso + el cupo compartido de recuperacion
// quemado. Solo los nombres que el cliente declaro como tools son evidencia.

describe('platform-internal drops are not interception evidence (clientToolNames filter)', () => {
  it('web_search drops on a prose turn: no retry, slot preserved, drop still logged', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(interceptionFrame('web_search'), answerFrame(NARRATION)), sender);
    });

    assert.equal(sender.calls.length, 0, 'un drop de web_search disparo un retry intercepted falso');
    assert.match(res.output, /"type":"message_stop"/);
    assert.ok(
      warns.some(line => /Dropped upstream role:function/.test(line) && /web_search/.test(line)),
      `el drop debe seguir logueandose aunque no cuente como evidencia:\n${warns.join('\n')}`
    );
  });

  it('a no-name platform frame is filtered the same way', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const noNameFrame = `data: ${JSON.stringify({
      choices: [{ delta: { role: 'function', phase: 'answer', content: 'internal lookup' }, finish_reason: null }]
    })}\n\n`;
    const res = await runStream(turnOf(noNameFrame, answerFrame(NARRATION)), sender);

    assert.equal(sender.calls.length, 0);
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('P11: a clean retry answer is not re-condemned by the previous attempt leak', async () => {
    // attempt 1 filtra residuo (leak con nombre NO permitido) → retry malformed_protocol;
    // attempt 2 responde prosa limpia. La clasificacion lee el texto DEL INTENTO:
    // con el acumulado, el residuo del attempt 1 volveria a condenar al attempt 2 y
    // apareceria el warn de give-up (协议恢复重试已用完) sin motivo.
    const sender = scriptedSender(turnOf(answerFrame('Listo: no hay nada que ejecutar.')));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(answerFrame(LEAK_PAYLOAD_NO_CLOSER)), sender);
    });

    assert.equal(sender.calls.length, 1, 'attempt 1 debe reintentar por malformed_protocol');
    assert.ok(warns.some(line => /malformed_protocol/.test(line)), `falta el rechazo del attempt 1:\n${warns.join('\n')}`);
    assert.ok(
      !warns.some(line => /协议恢复重试已用完/.test(line)),
      `el texto acumulado condeno al attempt 2 limpio:\n${warns.join('\n')}`
    );
    assert.match(res.output, /Listo: no hay nada que ejecutar\./);
    assert.match(res.output, /"type":"message_stop"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('non-stream: web_search drops do not burn the shared recovery slot', async () => {
    // El slot queda libre: un leak malformado en el retry posterior AUN puede usarlo.
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(
      turnOf(interceptionFrame('web_search'), answerFrame(LEAK_PAYLOAD_NO_CLOSER)),
      sender
    );

    assert.equal(sender.calls.length, 1, 'el retry malformed_protocol debia disparar con el slot libre');
    assert.match(JSON.stringify(sender.calls[0]), /was NOT executed/);
    const toolBlocks = (res.body?.content || []).filter(block => block.type === 'tool_use');
    assert.deepEqual(toolBlocks.map(block => block.name), ['read_file']);
  });
});

// ── Leak de tool calls en el think phase (spec toolcall-salvage-2) ──
// Verificado en vivo 2026-08-31 ~14:08: el modelo emitio el payload [TOOL_CALL]
// completo DENTRO del think phase y luego narro exito en el answer. Loop B streamea
// el think verbatim (emitThinkingDelta, sin parser): la llamada llego al bloque
// thinking del cliente, nunca se ejecuto, no alimento ningun retry, y la narracion
// "ya escribi el archivo" quedo como respuesta — una escritura alucinada. Loop A ya
// defiende esta superficie (openai-agent-runtime.js:232-243); aqui se lleva B y C a
// esa paridad: promocion bajo las guardas de A MAS dos conjuntos mas estrictos que A
// no tiene (allowlist no vacia fail-closed; cero tool errors del lado answer) y la
// disciplina terminal-finish, y si no, evidencia de emision → una razon one-shot
// `thought_tool_call` que comparte el cupo de recuperacion de protocolo con
// intercepted/malformed_protocol.

// Reconstruccion del leak de las 14:08: [TOOL_CALL] + JSON truncado a mitad de un
// string + cola XML ajena (</parameter></function>). Nunca es promovible (el parse
// da error truncated_tool_call); es pura evidencia de emision.
const THINK_LEAK_TRUNCATED = [
  '[TOOL_CALL]',
  '{"name":"Write","arguments":{"file_path":"notes.md","content":"# Findings',
  '</parameter>',
  '</function>'
].join('\n');

// La narracion de exito de las 14:08. NO matchea looksLikeUnexecutedToolAction
// (no empieza con "I'll/Let me") ni el residuo de protocolo: sin la nueva razon,
// el attempt se acepta tal cual.
const SUCCESS_NARRATION = 'The file notes.md was written with all the findings. Task complete.';

describe('think-phase tool-call leak (loop B stream)', () => {
  it('the 14:08 leak: think call + success narration fires ONE thought_tool_call retry and recovers', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)), sender);
    });

    assert.equal(sender.calls.length, 1, 'the think-phase leak must trigger exactly one retry');
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /emitted inside your hidden reasoning/, 'hint must say the call sat inside reasoning');
    assert.match(hint, /never executed/, 'hint must say the call was not executed');
    assert.ok(hint.includes('[TOOL CALL]'), 'hint must teach the canonical bracket marker');
    assert.doesNotMatch(hint, /<tool_call/i, 'hint must never re-seed the native form');
    assert.ok(warns.some(line => /thought_tool_call/.test(line)), `expected a thought_tool_call rejection warn:\n${warns.join('\n')}`);

    // La narracion ya streameo; el tool_use recuperado llega despues — mejor que una sesion muerta.
    assert.match(res.output, /"type":"thinking_delta"/, 'thinking must still stream (containment is deferred)');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.doesNotMatch(res.output, /"name":"Write"/, 'the truncated think call must never be promoted');
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('think-only standalone call: promoted to tool_use without burning any retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(turnOf(thinkFrame(BRACKET_CALL)), sender);

    assert.equal(sender.calls.length, 0, 'a pure standalone think call must not burn a retry');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('a think call split across deltas still promotes (accumulator, not per-chunk parse)', async () => {
    const res = await runStream(
      turnOf(thinkFrame(BRACKET_CALL.slice(0, 23)), thinkFrame(BRACKET_CALL.slice(23))),
      scriptedSender()
    );
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.match(res.output, /"stop_reason":"tool_use"/);
  });

  it('think call truncated by the XML tail with an empty answer: retries with the thought hint, never promotes', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED)), sender);

    assert.equal(sender.calls.length, 1, 'think-parse errors are emission evidence');
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/, 'must use the thought_tool_call hint, not the empty one');
    assert.doesNotMatch(res.output, /"name":"Write"/, 'a truncated call must never be promoted');
    assert.deepEqual(toolUseNames(res.output), ['read_file'], 'the recovery turn call must land');
    assert.match(res.output, /"stop_reason":"tool_use"/);
  });

  it('a VALID think call behind a prose answer is never promoted — one thought retry instead', async () => {
    // Guardia A-parity "answer visible text vacio": la narracion ya conto la historia,
    // asi que el call del think es evidencia para UN retry, jamas ejecucion directa.
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(thinkFrame(BRACKET_CALL), answerFrame(SUCCESS_NARRATION)), sender);

    assert.equal(sender.calls.length, 1, 'must retry, not promote past a non-empty answer');
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/);
    assert.deepEqual(toolUseNames(res.output), ['read_file'], 'only the recovery turn call executes');
  });

  it('a think call flanked by deliberation prose is not promoted — evidence retry instead', async () => {
    // Guardia A-parity "think cleanedText vacio": un call con prosa alrededor es
    // deliberacion, no una accion decidida (misma doctrina que el pin del loop A).
    const sender = scriptedSender(turnOf(answerFrame('Nothing to execute after all.')));
    const res = await runStream(
      turnOf(thinkFrame(`${BRACKET_CALL} but maybe I should reconsider first`)),
      sender
    );

    assert.equal(sender.calls.length, 1, 'must retry on emission evidence, not promote');
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/);
    assert.deepEqual(toolUseNames(res.output), [], 'the deliberated call must never execute');
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('meta-discussion about the marker in think does not fire (no calls, no errors)', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runStream(
      turnOf(
        thinkFrame('The [TOOL CALL] syntax expects a JSON payload, but here prose is enough.'),
        answerFrame('No action is needed; everything is already configured.')
      ),
      sender
    );

    assert.equal(sender.calls.length, 0, 'reasoning ABOUT the syntax must not be treated as emission');
    assert.match(res.output, /"type":"message_stop"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('two consecutive think-leaks: exactly one retry, delivered as-is with a give-up warn', async () => {
    const sender = scriptedSender(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)), sender);
    });

    assert.equal(sender.calls.length, 1, 'second think-leak must deliver as-is, no loop');
    assert.doesNotMatch(res.output, /"type":"error"/);
    assert.match(res.output, /"type":"message_stop"/);
    assert.ok(
      warns.some(line => /协议恢复重试已用完/.test(line) && /thought_tool_call/.test(line)),
      `expected the give-up warn naming thought_tool_call, got:\n${warns.join('\n')}`
    );
  });

  it('empty-answer think-leaks stop at the single shared slot, not at maxAttempts', async () => {
    // Sin narracion no hay texto visible: la guarda after-prose nunca se activa y solo
    // el cupo compartido puede parar el loop. Con AGENT_TURN_MAX_ATTEMPTS=3, sacar
    // thought_tool_call del cupo daria 2 retries.
    const sender = scriptedSender(
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(answerFrame(BRACKET_CALL))
    );
    await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED)), sender);

    assert.equal(sender.calls.length, 1, 'exactly ONE thought_tool_call retry per request');
  });

  it('thought_tool_call shares the ONE recovery slot with intercepted', async () => {
    // attempt 1: interceptacion sin narracion quema el cupo; attempt 2: think-leak.
    // Con cupos separados el think-leak dispararia un segundo retry.
    const sender = scriptedSender(
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(answerFrame(BRACKET_CALL))
    );
    await runStream(turnOf(interceptionFrame('read_file')), sender);

    assert.equal(sender.calls.length, 1, 'one protocol-recovery retry TOTAL, not one per reason');
  });

  it('tool_choice required is satisfied by a promoted think call', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runStream(turnOf(thinkFrame(BRACKET_CALL)), sender, { toolChoice: 'required' });

    assert.equal(sender.calls.length, 0, 'promotion must satisfy the required contract without a retry');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.match(res.output, /"stop_reason":"tool_use"/);
  });
});

describe('think-phase tool-call leak (loop C non-stream)', () => {
  it('promotion: a think-only standalone call becomes tool_use in the response', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runNonStream(turnOf(thinkFrame(BRACKET_CALL)), sender);

    assert.equal(sender.calls.length, 0);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    // R10: al promover, el thinking entregado es el cleanedText del parse — el payload
    // crudo jamas viaja en el bloque thinking (aqui el think era SOLO la llamada, asi
    // que no queda bloque thinking en absoluto).
    const thinkingText = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
    assert.doesNotMatch(thinkingText, /TOOL CALL/, 'el payload promovido viajo en el thinking');
    assert.equal(res.body.stop_reason, 'tool_use');
  });

  it('the 14:08 leak retries once with the thought hint and recovers (clean retry, nothing sent yet)', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)), sender);

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});

describe('control-char payload repair (the 13:36 invalid_json class)', () => {
  const CONTROL_CHAR_CALL = '[TOOL CALL]{"name":"read_file","arguments":{"path":"a.txt","note":"line1\nline2\tend"}}[END TOOL CALL]';

  it('stream: a payload with raw newlines inside a JSON string executes without any retry', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(turnOf(answerFrame(CONTROL_CHAR_CALL)), sender);

    assert.equal(sender.calls.length, 0, 'the repaired payload must not burn a retry');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.match(res.output, /"stop_reason":"tool_use"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });

  it('non-stream: same payload, same repair', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runNonStream(turnOf(answerFrame(CONTROL_CHAR_CALL)), sender);

    assert.equal(sender.calls.length, 0);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});

// ── Endurecimiento post-review adversarial (R1-R13) ──

// Frame nativo con nombre de tool NO declarado: unica via en C de tener toolErrors
// con cero texto visible (los spans de error del parser de texto viajan como debris
// visible en cleanedText).
const nativeUnknownFrame = () => `data: ${JSON.stringify({
  choices: [{
    delta: { phase: 'answer', tool_calls: [{ index: 0, type: 'function', function: { name: 'nope', arguments: '{}' } }] },
    finish_reason: null
  }]
})}\n\n`;

const CONTENT_FILTER_STOP = 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n';

describe('fail closed: empty allowlist never promotes (R2)', () => {
  it('stream: hasTools + empty allowlist + standalone think call → one thought retry, zero promotion', async () => {
    const sender = scriptedSender(turnOf(answerFrame('No tools were actually declared.')));
    const res = await runStream(turnOf(thinkFrame(BRACKET_CALL)), sender, { allowedToolNames: [] });

    assert.equal(sender.calls.length, 1, 'must retry, never promote without a whitelist');
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/);
    assert.deepEqual(toolUseNames(res.output), [], 'promotion fired without a whitelist');
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('non-stream: same fail-closed discipline', async () => {
    const sender = scriptedSender(turnOf(answerFrame('No tools were actually declared.')));
    const res = await runNonStream(turnOf(thinkFrame(BRACKET_CALL)), sender, { allowedToolNames: [] });

    assert.equal(sender.calls.length, 1);
    assert.match(JSON.stringify(sender.calls[0]), /emitted inside your hidden reasoning/);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), []);
  });
});

describe('loop C shares the single protocol-recovery slot (R3)', () => {
  it('two consecutive non-stream think-leaks: one retry, narration delivered, give-up warn', async () => {
    const sender = scriptedSender(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)));
    let res;
    const warns = await captureWarns(async () => {
      res = await runNonStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)), sender);
    });

    assert.equal(sender.calls.length, 1, 'second think-leak must deliver as-is, no loop');
    assert.equal(res.statusCode, 200);
    const text = (res.body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /written with all the findings/);
    assert.ok(
      warns.some(line => /协议恢复重试已用完/.test(line) && /thought_tool_call/.test(line)),
      `expected the C give-up warn naming thought_tool_call, got:\n${warns.join('\n')}`
    );
  });

  it('empty-answer non-stream think-leaks stop at the shared slot, not maxAttempts', async () => {
    const sender = scriptedSender(
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(answerFrame(BRACKET_CALL))
    );
    await runNonStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED)), sender);

    assert.equal(sender.calls.length, 1, 'exactly ONE thought_tool_call retry per request (C)');
  });

  it('non-stream: thought_tool_call shares the ONE slot with intercepted', async () => {
    const sender = scriptedSender(
      turnOf(thinkFrame(THINK_LEAK_TRUNCATED)),
      turnOf(answerFrame(BRACKET_CALL))
    );
    await runNonStream(turnOf(interceptionFrame('read_file')), sender);

    assert.equal(sender.calls.length, 1, 'one protocol-recovery retry TOTAL, not one per reason (C)');
  });
});

describe('thought_tool_call outranks missing_tool (R4)', () => {
  const ACTION_NARRATION = "I'll run the command now to finish this.";

  it('stream: action-flavored narration after a think leak still gets the thought hint', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(ACTION_NARRATION)), sender);
    });

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /emitted inside your hidden reasoning/);
    assert.doesNotMatch(hint, /described an action/, 'missing_tool won the slot: precedence regressed');
    assert.ok(warns.some(line => /thought_tool_call/.test(line)), 'the shared slot must be consumed under the thought reason');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
  });

  it('non-stream: same precedence', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(ACTION_NARRATION)), sender);

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /emitted inside your hidden reasoning/);
    assert.doesNotMatch(hint, /described an action/);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
  });
});

describe('answer-side tool errors block promotion (R5) and the hint carries the thought appendix (R6)', () => {
  it('stream: truncated answer payload + valid think call → tool_error retry with appendix, no promotion', async () => {
    const TRUNCATED_ANSWER = '[TOOL CALL]{"name":"read_file","arguments":{';
    const sender = scriptedSender(turnOf(answerFrame('Nothing further to run.')));
    const res = await runStream(turnOf(thinkFrame(BRACKET_CALL), answerFrame(TRUNCATED_ANSWER)), sender);

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /invalid, truncated, or unknown tool call/, 'tool_error must keep the reason slot');
    assert.match(hint, /emitted inside your hidden reasoning/, 'R6: the masked think evidence must ride along');
    assert.deepEqual(toolUseNames(res.output), [], 'the think call must not promote past answer-side errors');
    assert.match(res.output, /"type":"message_stop"/);
  });

  it('non-stream: native unknown-tool error + valid think call → tool_error retry with appendix, no promotion', async () => {
    const sender = scriptedSender(turnOf(answerFrame('Nothing further to run.')));
    const res = await runNonStream(turnOf(nativeUnknownFrame(), thinkFrame(BRACKET_CALL)), sender);

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /invalid, truncated, or unknown tool call/);
    assert.match(hint, /emitted inside your hidden reasoning/);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), []);
  });

  it('stream: required masks the think evidence but the hint carries the appendix (R6)', async () => {
    const sender = scriptedSender(turnOf(answerFrame(BRACKET_CALL)));
    const res = await runStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED)), sender, { toolChoice: 'required' });

    assert.equal(sender.calls.length, 1);
    const hint = JSON.stringify(sender.calls[0]);
    assert.match(hint, /You did not call any tool/, 'required must keep the reason slot');
    assert.match(hint, /emitted inside your hidden reasoning/, 'R6: the masked think evidence must ride along');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
  });
});

describe('terminal finish blocks promotion and retry (R7)', () => {
  it('stream: standalone think call + content_filter → no promotion, no retry, refusal', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runStream(() => Readable.from([thinkFrame(BRACKET_CALL), CONTENT_FILTER_STOP]), sender);

    assert.equal(sender.calls.length, 0, 'terminal discipline: no retry');
    assert.deepEqual(toolUseNames(res.output), [], 'terminal discipline: no promotion, no execution');
    assert.match(res.output, /"stop_reason":"refusal"/);
  });

  it('non-stream: same discipline', async () => {
    const sender = scriptedSender(turnOf(answerFrame('unused')));
    const res = await runNonStream(() => Readable.from([thinkFrame(BRACKET_CALL), CONTENT_FILTER_STOP]), sender);

    assert.equal(sender.calls.length, 0);
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), []);
    assert.equal(res.body.stop_reason, 'refusal');
  });
});

describe('exhaustion observability (R8)', () => {
  it('stream: a neutral exhaustion warn, no delivery claim', async () => {
    const sender = scriptedSender(turnOf(), turnOf());
    const warns = await captureWarns(async () => {
      await runStream(turnOf(), sender);
    });

    assert.equal(sender.calls.length, 2, 'empty retries burn up to maxAttempts');
    const line = warns.find(l => /尝试次数用尽（3\/3）/.test(l));
    assert.ok(line, `expected the stream exhaustion warn, got:\n${warns.join('\n')}`);
    assert.match(line, /最后一轮仍被拒绝 \(empty\)/);
    assert.doesNotMatch(line, /按原样交付/, 'the warn must not assert a delivery that may not happen');
  });

  it('non-stream: exhaustion + protocol-failure warns and the 502 body (R8a + R11b)', async () => {
    const sender = scriptedSender(turnOf(nativeUnknownFrame()), turnOf(nativeUnknownFrame()));
    let res;
    const warns = await captureWarns(async () => {
      res = await runNonStream(turnOf(nativeUnknownFrame()), sender);
    });

    assert.equal(sender.calls.length, 2);
    assert.ok(
      warns.some(l => /非流式 Agent 尝试次数用尽（3\/3）/.test(l) && /tool_error/.test(l)),
      `expected the C exhaustion warn, got:\n${warns.join('\n')}`
    );
    assert.ok(
      warns.some(l => /非流式工具协议失败，3\/3 次尝试后放弃/.test(l) && /unknown_tool: nope/.test(l)),
      `expected the protocol-failure warn with the detail, got:\n${warns.join('\n')}`
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.body?.error?.type, 'invalid_tool_call_error');
    assert.match(res.body?.error?.message || '', /unknown_tool: nope/);
  });
});

describe('narration fallback covers thought_tool_call (R9)', () => {
  it('non-stream 14:08 shape: an empty thought retry delivers the narration, never a 502', async () => {
    // attempt 1: think leak + narracion → thought retry (narracion respaldada);
    // attempt 2: vacio → empty retry; sender agotado → break. Sin el fallback,
    // cleanedText quedo vacio y el turno moria en 502.
    const sender = scriptedSender(turnOf());
    const res = await runNonStream(turnOf(thinkFrame(THINK_LEAK_TRUNCATED), answerFrame(SUCCESS_NARRATION)), sender);

    assert.equal(res.statusCode, 200, 'the narration must beat a 502');
    const text = (res.body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    assert.match(text, /written with all the findings/, 'the think-leak attempt narration is the fallback answer');
    assert.equal(res.body.stop_reason, 'end_turn');
    assert.equal(sender.calls.length, 2, 'thought retry + the empty-reason retry that found no sender turn');
  });
});

describe('promoted thinking is contained in loop C (R10)', () => {
  it('deliberation survives, the promoted payload does not', async () => {
    // attempt 1: think deliberativo + answer vacio → empty retry; attempt 2 (retry):
    // think = SOLO la llamada → promocion. El thinking entregado conserva la
    // deliberacion del attempt 1 y NO el payload promovido del attempt 2.
    const sender = scriptedSender(turnOf(thinkFrame(BRACKET_CALL)));
    const res = await runNonStream(turnOf(thinkFrame('planning the read step first')), sender);

    assert.equal(sender.calls.length, 1, 'the empty retry, nothing more');
    assert.equal(res.statusCode, 200);
    const blocks = res.body?.content || [];
    assert.deepEqual(blocks.filter(b => b.type === 'tool_use').map(b => b.name), ['read_file']);
    const thinkingText = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
    assert.match(thinkingText, /planning the read step first/, 'prior deliberation must survive');
    assert.doesNotMatch(thinkingText, /TOOL CALL/, 'the promoted payload leaked into thinking');
    assert.doesNotMatch(thinkingText, /read_file/, 'the promoted payload leaked into thinking');
    assert.equal(res.body.stop_reason, 'tool_use');
  });
});

describe('give-up and degraded-delivery paths actually log (R11)', () => {
  // salvage-3 cambio este contrato: tool_error tras prosa ya no rompe en seco —
  // consume el MISMO cupo retriedAfterVisibleText con un retry de texto suprimido
  // (solo tool_use del retry llega al cliente; su texto jamas pisa el wire).
  it('stream: tool_error after streamed prose → one text-suppressed retry, retry text never on the wire', async () => {
    const sender = scriptedSender(turnOf(answerFrame('retry narration that must stay off the wire')));
    let res;
    const warns = await captureWarns(async () => {
      res = await runStream(
        turnOf(answerFrame('Working on it.\n'), answerFrame('[TOOL CALL]{"name":"read_file","arguments":{')),
        sender
      );
    });

    assert.equal(sender.calls.length, 1, 'tool_error after prose consumes the single compensation slot');
    assert.ok(
      warns.some(l => /已见正文后本轮 tool_error，消耗补偿名额做文本抑制重试/.test(l)),
      `expected the text-suppressed-retry warn, got:\n${warns.join('\n')}`
    );
    assert.doesNotMatch(res.output, /retry narration that must stay off the wire/);
    assert.match(res.output, /Working on it\./);
    assert.match(res.output, /"type":"message_stop"/);
    assert.doesNotMatch(res.output, /"type":"error"/);
  });
});

describe('searchTable injection never poisons the think settle (R12)', () => {
  it('stream: web_search table streams into thinking, promotion still fires', async () => {
    const webSearchFrame = `data: ${JSON.stringify({
      choices: [{
        delta: { name: 'web_search', phase: 'answer', extra: { web_search_info: [{ title: 'Qwen docs', url: 'https://q.example', hostname: 'q.example' }] } },
        finish_reason: null
      }]
    })}\n\n`;
    const sender = scriptedSender(turnOf(answerFrame('retry would consume this')));
    const res = await runStream(() => Readable.from([webSearchFrame, thinkFrame(BRACKET_CALL), STOP]), sender);

    assert.equal(sender.calls.length, 0, 'the injected searchTable must not count as model think content');
    assert.deepEqual(toolUseNames(res.output), ['read_file']);
    assert.match(res.output, /Qwen docs/, 'the searchTable must actually have streamed into thinking');
    assert.match(res.output, /"stop_reason":"tool_use"/);
  });
});

