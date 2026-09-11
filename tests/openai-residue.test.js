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

// ─────── la otra mitad del contrato gemelo: pelar sin juzgar deja un 200 vacío ───────
//
// Reparación de la verificación adversaria de T7. La primera entrega de esta spec portó el
// PELADO de anthropic.js:2278 pero no la GUARDA que va inmediatamente después
// (anthropic.js:2269 `residueOnlyTurn` → 502 invalid_tool_call_error), y el comentario del
// gemelo dice que el orden es cargante: "剥离必须在下面的空判据之前 ... 绝不能交付
// content: [] 的空消息 (frozen matrix: never an empty-content message)".
//
// Consecuencia medida sobre el árbol post-T7 y pre-reparación: un turno cuyo cuerpo visible
// entero era residuo condenado se pelaba a vacío y salía como HTTP 200 con
// `content: ""` y `finish_reason: "stop"` — un turno muerto silencioso para un cliente
// agéntico. El mismo texto por /v1/messages devolvía 502. O sea que T7 cambió una violación
// de la matriz congelada (protocolo crudo al cliente) por la otra (mensaje sin contenido).
//
// Estas pruebas fijan LAS DOS direcciones, igual que el gemelo hace en
// tests/anthropic-toolcall-salvage.test.js:771 y :792:
//   residuo puro          → error, jamás 200 vacío, y el cierre crudo nunca llega;
//   prosa + cierre suelto → 200 con la prosa, jamás un 502.

describe('OpenAI: un turno que es 100% residuo falla, no entrega un 200 vacío', () => {
  // Forma alcanzable por la puerta normal: `<agent_final>` es el envoltorio que el gate
  // exige (agentTurnAcceptBareFinal=false), el intento 1 dispara malformed_protocol y el
  // intento 2 entrega "tal cual" — que tras el pelado de T7 es la nada.
  const CLOSER_ONLY = '<agent_final>[END TOOL CALL]</agent_final>';
  const CLOSER_ONLY_PADDED = '<agent_final>   [END TOOL CALL]   </agent_final>';

  it('no-streaming: el cierre huérfano solitario da 502, nunca 200 con content vacío', async () => {
    const sender = scriptedSender(CLOSER_ONLY);
    const { res, body, content } = await runNonStream(CLOSER_ONLY, sender);

    assert.equal(sender.calls.length, 1, 'un reintento de recuperación y se rinde');
    assert.equal(res.statusCode, 502, 'un turno sin nada entregable no es un éxito');
    assert.equal(body?.error?.code, 'invalid_tool_call',
      'misma clase de fallo que el gemelo (invalid_tool_call_error)');
    assert.notEqual(
      res.statusCode === 200 && content === '',
      true,
      'un 200 con content vacío es un turno muerto silencioso para el cliente agéntico'
    );
    assert.ok(!JSON.stringify(body).includes('END TOOL CALL'),
      'el protocolo crudo no llega al cliente por ninguna salida');
  });

  it('no-streaming: el mismo caso con espacios alrededor tampoco se cuela', async () => {
    // `String.trim()` es quien decide "vacío": el relleno no debe abrir una puerta trasera.
    const sender = scriptedSender(CLOSER_ONLY_PADDED);
    const { res, body } = await runNonStream(CLOSER_ONLY_PADDED, sender);

    assert.equal(res.statusCode, 502);
    assert.equal(body?.error?.code, 'invalid_tool_call');
  });

  it('streaming (buffer): sale un evento de error, no un finish_reason stop mudo', async () => {
    // Pre-reparación esto emitía delta de rol → finish_reason "stop" → usage → [DONE], sin un
    // solo delta de contenido: indistinguible de un turno correcto que no dijo nada.
    const sender = scriptedSender(CLOSER_ONLY);
    const { res, content } = await runStreamBuffered(CLOSER_ONLY, sender);

    assert.equal(content, '', 'no hay contenido que entregar');
    assert.equal(streamFinishReason(res.output), null,
      'no se corona como turno terminado con éxito');
    assert.match(res.output, /"code":"invalid_tool_call"/,
      'el cliente recibe un error accionable');
    assert.ok(!res.output.includes('END TOOL CALL'),
      'el cierre crudo tampoco viaja por el canal SSE');
  });

  it('prosa + cierre suelto sigue siendo 200 con la prosa — la línea que no se cruza', async () => {
    // Dirección opuesta, explícita (gemelo :792). Una respuesta real con un cierre extraviado
    // detrás NO puede ascender a 502: se pela el cierre y se entrega la respuesta.
    const sender = scriptedSender(LEAK);
    const { res, body, content } = await runNonStream(LEAK, sender);

    assert.equal(res.statusCode, 200, 'una respuesta real jamás se convierte en error');
    assert.equal(content, PROSE);
    assert.equal(body.choices[0].finish_reason, 'stop');
  });

  it('una ronda con llamada de herramienta válida no la toca la guarda', async () => {
    // La guarda exige `toolCalls.length === 0`: un turno que entrega llamadas puede llevar
    // content vacío legítimamente (OpenAI lo permite) y no debe convertirse en 502.
    const CALL = `[TOOL CALL]${JSON.stringify({ name: 'Read', arguments: { file_path: '/tmp/a' } })}[END TOOL CALL]`;
    const sender = scriptedSender();
    const { res, body } = await runNonStream(CALL, sender);

    assert.equal(sender.calls.length, 0, 'una llamada válida se acepta a la primera');
    assert.equal(res.statusCode, 200);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Read');
  });
});

// ─────── la etiqueta de control anidada tampoco llega al cliente ───────

describe('OpenAI: el pelado de entrega quita las etiquetas de control, como el gemelo', () => {
  // anthropic.js:2278 pela `stripAgentTags(stripToolCallResidue(...))`; T7 sólo portó la
  // mitad de dentro. Medido: `<agent_final>` filtrado como texto visible en 3 de 29.352
  // turnos reales. `unwrapExactTag` está anclado al final, así que sólo consume el
  // envoltorio EXTERIOR — una etiqueta anidada sobrevive al desenvuelto y salía cruda.
  it('el <agent_final> anidado se va junto con el residuo', async () => {
    const NESTED = '<agent_final>x [END TOOL CALL] <agent_final>y</agent_final></agent_final>';
    const sender = scriptedSender(NESTED);
    const { res, content } = await runNonStream(NESTED, sender);

    assert.equal(res.statusCode, 200);
    assert.ok(!content.includes('agent_final'),
      `la etiqueta de control llegó al cliente: ${JSON.stringify(content)}`);
    assert.ok(!content.includes('END TOOL CALL'), 'y el residuo tampoco');
    assert.ok(content.includes('x') && content.includes('y'), 'la prosa de ambos lados sobrevive');
  });

  it('sin residuo registrado no se toca un byte, ni siquiera una etiqueta', async () => {
    // El pelado de etiquetas va DENTRO de la guarda `spans.length > 0`, igual que en el
    // gemelo ("零残渣轮逐字节保持今天的交付"). No es cosmética: pelar siempre rompería el
    // descuento del stream (`acceptedVisibleText.startsWith(streamedVisibleText)`) cuando una
    // etiqueta anidada ya salió en vivo SIN pelar, y el turno entero se reenviaría detrás.
    const NESTED_CLEAN = '<agent_final>x <agent_final>y</agent_final></agent_final>';
    const sender = scriptedSender();
    const { res, content } = await runNonStream(NESTED_CLEAN, sender);

    assert.equal(sender.calls.length, 0, 'sin residuo no hay reintento');
    assert.equal(res.statusCode, 200);
    assert.equal(content, 'x <agent_final>y</agent_final>', 'ronda sin residuo: byte a byte');
  });
});
