// Task 7 del plan agentic-parity (2026-09-08): el camino OpenAI nunca peló el residuo de
// protocolo.
//
// Medido sobre 192 sesiones reales de Claude Code: 20 turnos entregaron un `[END TOOL CALL]`
// huérfano como texto visible del asistente. `stripToolCallResidue` tenía cuatro llamadores
// en anthropic.js y CERO en el camino OpenAI: openai-agent-runtime.js calculaba
// `residueSpans` dentro de `settledTextRound` y los tiraba al suelo — el objeto attempt no
// los exponía y ningún llamador los leía.
//
// El camino de la fuga, verificado contra el gate (no supuesto):
//   attempt 1 → containsOrphanProtocolResidue(visibleText) → retryReason 'malformed_protocol'
//   attempt 2 → protocol_recovery_used=true → el chequeo se salta → se entrega TAL CUAL.
// Ese "tal cual" es la fuga. Dos consecuencias que fijan la forma de estas pruebas:
//
//  1. El gate sólo acepta prosa envuelta en <agent_final> (agentTurnAcceptBareFinal=false por
//     defecto), así que el único residuo entregable pasa por el desenvuelto de
//     parseAgentControlText: los spans quedan registrados en coordenadas de `cleanedText`
//     (con `<agent_final>` delante) y hay que rebasarlos a `visibleText` o el pelado
//     posicional no encaja con nada.
//  2. En streaming con la config por defecto el cuerpo del <agent_final> sale EN VIVO por
//     `on_content_delta` mientras se genera, y entonces el gate corta con 422
//     (upstream_agent_stream_invalidated) sin llegar a reintentar. Ese residuo ya está en el
//     cable y ningún pelado en la entrega lo recupera — misma limitación que anthropic.js
//     ("los text deltas se emiten inline, no se pueden recoger"). El pelado en la entrega
//     cubre el buffer: no-streaming siempre, y streaming cuando no hubo canal en vivo
//     (LEGACY_REASONING_IN_CONTENT=true, que es como se ejerce aquí).
//
// Harness: copiado de tests/openai-agent-turn-cutoff.test.js (cada archivo de test corre en
// su propio proceso, así que no se comparte).

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');

// Sin red en tests: mismos parches de require-cache que el resto de la suite.
const modelsMap = require('../src/models/models-map.js');
modelsMap.getLatestModels = async () => { throw new Error('offline test: no model fetch'); };
const requestModule = require('../src/utils/request.js');
requestModule.sendChatRequest = async () => ({ status: false });

const { runOpenAIAgentTurn } = require('../src/utils/openai-agent-runtime.js');
const {
  handleStreamResponse,
  handleNonStreamResponse
} = require('../src/controllers/chat.js');
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

/** logger.warn es el método REAL del singleton (logger.warning no existe). */
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

const upstreamOf = (frames) => {
  async function* gen() {
    for (const frame of frames) yield frame;
  }
  return gen();
};

/**
 * Sender guionizado para los reintentos del gate: cada entrada es el texto completo de la
 * answer phase del siguiente intento.
 */
const scriptedSender = (...texts) => {
  const fn = async (body) => {
    fn.calls.push(body);
    const next = fn.queue.shift();
    return next === undefined
      ? { status: false }
      : { status: true, response: upstreamOf([answerFrame(next), STOP]) };
  };
  fn.calls = [];
  fn.queue = [...texts];
  return fn;
};

const ALLOWED = ['Read', 'Bash'];
const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
};

const baseOptions = (sendChatRequest, overrides = {}) => ({
  has_tools: true,
  tool_choice: 'auto',
  allowed_tool_names: ALLOWED,
  tool_schemas: SCHEMAS,
  agent_turn_max_attempts: 3,
  upstream_request_body: { messages: [{ role: 'user', content: 'revisa el archivo' }] },
  sendChatRequest,
  ...overrides
});

const deltasOf = (output) => output
  .split('\n\n')
  .filter(Boolean)
  .map(chunk => chunk.replace(/^data: /, ''))
  .filter(payload => payload && payload !== '[DONE]')
  .map(payload => JSON.parse(payload));

const streamContent = (output) => deltasOf(output)
  .map(event => event.choices?.[0]?.delta?.content || '')
  .join('');

const streamFinishReason = (output) => {
  for (const event of deltasOf(output)) {
    const reason = event.choices?.[0]?.finish_reason;
    if (reason) return reason;
  }
  return null;
};

/**
 * Streaming SIN canal de contenido en vivo (LEGACY_REASONING_IN_CONTENT=true): chat.js no
 * crea onContentDelta, así que el turno entero se entrega desde el buffer — que es
 * exactamente donde vive el pelado de esta spec.
 */
const runStreamBuffered = async (firstText, sender, overrides = {}) => {
  const saved = config.legacyReasoningInContent;
  config.legacyReasoningInContent = true;
  try {
    const res = createMockResponse();
    const warns = await captureWarns(async () => {
      await handleStreamResponse(
        res,
        upstreamOf([answerFrame(firstText), STOP]),
        false,
        false,
        { messages: [] },
        baseOptions(sender, overrides)
      );
    });
    return { res, warns, content: streamContent(res.output) };
  } finally {
    config.legacyReasoningInContent = saved;
  }
};

const runNonStream = async (firstText, sender, overrides = {}) => {
  const res = createMockResponse();
  const warns = await captureWarns(async () => {
    await handleNonStreamResponse(
      res,
      upstreamOf([answerFrame(firstText), STOP]),
      false,
      false,
      'qwen-test',
      { messages: [] },
      baseOptions(sender, overrides)
    );
  });
  const body = JSON.parse(res.output);
  return { res, warns, body, content: body?.choices?.[0]?.message?.content ?? '' };
};

// La forma real de la fuga medida: una respuesta correcta con un cierre huérfano pegado
// detrás, dentro del envoltorio que el gate exige.
const PROSE = 'Revisé el archivo y la configuración es correcta.';
const LEAK = `<agent_final>${PROSE}[END TOOL CALL]</agent_final>`;

// ─────────────── el residuo huérfano no llega al cliente ───────────────

describe('OpenAI: el residuo de protocolo se pela en la entrega', () => {
  it('no-streaming: un [END TOOL CALL] huérfano no sale como texto visible', async () => {
    const sender = scriptedSender(LEAK);
    const { content, body, warns } = await runNonStream(LEAK, sender);

    assert.equal(sender.calls.length, 1, 'el gate gastó su único reintento de recuperación');
    assert.ok(
      warns.some(entry => /协议恢复重试已用完/.test(entry.message)),
      'la ronda llega a la entrega por la vía "segunda vez, tal cual"'
    );
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.ok(!content.includes('[END TOOL CALL]'),
      `el cierre huérfano llegó al cliente: ${JSON.stringify(content)}`);
    assert.equal(content, PROSE, 'la prosa se entrega intacta');
  });

  it('streaming (buffer, sin canal en vivo): tampoco sale el cierre huérfano', async () => {
    const sender = scriptedSender(LEAK);
    const { content, res } = await runStreamBuffered(LEAK, sender);

    assert.equal(sender.calls.length, 1);
    assert.equal(streamFinishReason(res.output), 'stop');
    assert.ok(!content.includes('[END TOOL CALL]'),
      `el cierre huérfano llegó al cliente: ${JSON.stringify(content)}`);
    assert.equal(content, PROSE, 'la prosa se entrega intacta');
    assert.equal(
      (res.output.match(/Revisé el archivo/g) || []).length,
      1,
      'la respuesta se entrega una sola vez (el descuento del stream sigue cuadrando)'
    );
  });

  it('el attempt expone residueSpans en coordenadas de visibleText', async () => {
    // El pelado es POSICIONAL: si los spans se quedaran en coordenadas de cleanedText (con
    // `<agent_final>` delante) no encajarían contra visibleText y no pelarían nada. Esta
    // prueba fija el rebase, que es lo único que hace útil al resto.
    const sender = scriptedSender(LEAK);
    let result;
    await captureWarns(async () => {
      result = await runOpenAIAgentTurn(
        upstreamOf([answerFrame(LEAK), STOP]),
        baseOptions(sender)
      );
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.attempt.residueSpans), 'el objeto attempt expone residueSpans');
    assert.equal(result.attempt.residueSpans.length, 1);
    const span = result.attempt.residueSpans[0];
    assert.equal(span.text, '[END TOOL CALL]');
    assert.equal(
      result.attempt.visibleText.slice(span.at, span.at + span.text.length),
      '[END TOOL CALL]',
      'el span cae exactamente sobre el residuo dentro de visibleText'
    );
    assert.equal(
      result.attempt.visibleText,
      `${PROSE}[END TOOL CALL]`,
      'la entrada de DETECCIÓN sigue byte a byte como salió del parser'
    );
  });
});

// ─────────── mencionar el marcador no es emitirlo: cero pelado ───────────

describe('OpenAI: una mención del marcador en documentación no se toca', () => {
  // El parser ya distingue ambos casos: recordOrphanBracketClosers salta el código encercado
  // (createCodeContextTracker), así que un bloque con fences no registra ni un span. Esto fija
  // que el pelado en la entrega hereda esa distinción en vez de re-buscar el marcador por
  // texto — un strip por indexOf mordería el marcador de dentro del bloque de código.
  //
  // Nota: el DETECTOR (containsOrphanProtocolResidue) sí es ciego a los fences y gasta un
  // reintento aquí. Es comportamiento previo a esta spec y queda fijado tal cual: la spec
  // cambia lo que se entrega, no lo que se reintenta.
  const FENCED = [
    '<agent_final>El protocolo cierra cada llamada así:',
    '',
    '```',
    '[TOOL CALL]{"name":"Read","arguments":{}}[END TOOL CALL]',
    '```',
    '',
    'Ese cierre es obligatorio.</agent_final>'
  ].join('\n');

  const VISIBLE_FENCED = FENCED
    .replace('<agent_final>', '')
    .replace('</agent_final>', '');

  it('no-streaming: el bloque encercado llega entero', async () => {
    const sender = scriptedSender(FENCED);
    const { content } = await runNonStream(FENCED, sender);

    assert.equal(content, VISIBLE_FENCED, 'ni un byte movido');
    assert.ok(content.includes('[END TOOL CALL]'), 'el cierre citado sobrevive');
    assert.ok(content.includes('[TOOL CALL]'), 'el disparador citado sobrevive');
  });

  it('streaming (buffer, sin canal en vivo): el bloque encercado llega entero', async () => {
    const sender = scriptedSender(FENCED);
    const { content } = await runStreamBuffered(FENCED, sender);

    assert.equal(content, VISIBLE_FENCED, 'ni un byte movido');
    assert.ok(content.includes('[END TOOL CALL]'), 'el cierre citado sobrevive');
  });

  it('sin herramientas no hay registro que pelar: la prosa pasa igual', async () => {
    // has_tools=false ⇒ el parser de herramientas no corre, no hay spans y el texto se
    // entrega verbatim. Fija que el pelado no se cuela por otra puerta.
    const sender = scriptedSender();
    const plain = 'Aquí no hay herramientas, pero sí un [END TOOL CALL] en el texto.';
    const { content } = await runNonStream(plain, sender, { has_tools: false });

    assert.equal(sender.calls.length, 0, 'sin herramientas el gate de residuo ni se consulta');
    assert.equal(content, plain);
  });
});
