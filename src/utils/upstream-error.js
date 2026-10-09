class UpstreamResponseError extends Error {
  constructor(message, code = 'upstream_error', details = null) {
    super(message);
    this.name = 'UpstreamResponseError';
    this.code = code;
    this.publicMessage = message;
    this.details = details;
  }
}

/**
 * Cuota diaria agotada. Qwen la anuncia con `data.code = 'RateLimited'` y el texto
 * "You've reached the upper limit for today's usage." (observado en vivo en las sesiones
 * reales del usuario, 2026-08-21).
 *
 * Vive AQUI y solo aqui: los dos controladores son gemelos y cada uno lo traducia —o no—
 * a su manera. /v1/messages lo entregaba como 500 `api_error` y /v1/chat/completions como
 * 502 `upstream_error`; con ninguno de los dos puede un cliente agentico distinguir
 * "sin cuota" de "servidor roto", asi que reintenta contra un muro y quema otra cuenta del
 * pool en cada vuelta. Las dos APIs nativas contestan 429 justamente para evitar eso.
 */
const RATE_LIMIT_CODE = 'RateLimited';
const QUOTA_LIMIT_CODE = 'quota_limit';
const WAF_CHALLENGE_CODE = 'upstream_waf_challenge';
const isWafChallengeError = (error) => String(error?.code || '').toLowerCase() === WAF_CHALLENGE_CODE;
/**
 * Señales con las que Qwen Web anuncia el WAF/captcha. Vive aquí porque hay DOS rutas que
 * tienen que reconocerlo —los controladores de texto vía assertNoUpstreamFailure, y el de
 * imagen/vídeo vía parseUpstreamImageError— y separarlas ya costó un fallo silencioso: la
 * ruta de imagen no reconocía este paquete y entregaba un 200 con la imagen de relleno del
 * propio Qwen (img.alicdn.com) como si la generación hubiera salido bien.
 */
const WAF_SIGNAL_RE = /FAIL_SYS_USER_VALIDATE|RGV587|captcha|\/punish\?|upstream_waf_challenge/i;
/**
 * Señales de la MISMA página de captcha pero cuando el upstream la manda como HTML.
 *
 * Caso real (2026-09-19): `/api/v2/chat/completions` contestó 200 con 16 KB de
 * `<!doctype html> <meta name="aliyun_waf_aa" ...>`. El detector solo miraba el paquete
 * JSON `{ret:[...]}`, así que el HTML pasaba entero: `parseSsePayloads` no encontraba
 * ninguna línea `data:`, `JSON.parse` fallaba, y `extractResourceUrlFromPayload` sacaba
 * del propio HTML la primera URL que hubiera — que resultó ser la imagen de relleno de
 * Qwen — y la devolvía como generación correcta.
 *
 * Ancladas a marcadores que solo existen en el challenge, no a la palabra suelta
 * "captcha": el texto normal del modelo puede nombrarla.
 */
const WAF_HTML_SIGNAL_RE = /aliyun_waf_|aliyunCaptcha|_waf_is_mobile|id=["']captcha-element|<title>Verification<\/title>/i;
/**
 * ¿El cuerpo CRUDO del upstream (texto o buffer) es la página de captcha del WAF?
 * @param {unknown} rawText - Cuerpo sin parsear
 * @returns {boolean}
 */
const isWafChallengeBody = (rawText) => {
  if (typeof rawText !== 'string' || rawText === '') return false;
  return WAF_HTML_SIGNAL_RE.test(rawText);
};
/**
 * ¿Este payload de upstream (HTTP 200, JSON normal) es en realidad el WAF pidiendo captcha?
 *
 * Qwen contesta 200 con `{"ret":["FAIL_SYS_USER_VALIDATE",...],"data":{"url":".../punish?..."}}`
 * en vez de un error HTTP. Sin reconocerlo, el llamador lo trata como respuesta buena.
 * @param {unknown} payload - Cuerpo JSON del upstream
 * @returns {string[]} Señales encontradas (vacío si no es un challenge)
 */
const findWafChallengeSignals = (payload) => {
  if (!payload || typeof payload !== 'object') return [];
  const ret = Array.isArray(payload.ret)
    ? payload.ret.map(String)
    : (payload.ret ? [String(payload.ret)] : []);
  return [
    ...ret,
    payload.code,
    payload.data?.code,
    payload.data?.url,
    payload.error?.code
  ].filter(Boolean).map(String).filter(item => WAF_SIGNAL_RE.test(item));
};
/**
 * Detecta el challenge y devuelve el error canónico, o null si el payload no lo es.
 * @param {unknown} payload - Cuerpo JSON del upstream
 * @returns {UpstreamResponseError|null}
 */
const detectWafChallenge = (payload) => {
  // El cuerpo crudo llega a veces tal cual (HTML). Se comprueba primero porque un HTML
  // no tiene forma de objeto que inspeccionar.
  if (typeof payload === 'string' && isWafChallengeBody(payload)) {
    return new UpstreamResponseError(
      'Qwen 网页上游触发 WAF/captcha；Agent 上下文可能过大或账号需要验证',
      WAF_CHALLENGE_CODE,
      { ret: [] }
    );
  }
  if (!payload || typeof payload !== 'object') return null;
  const signals = findWafChallengeSignals(payload);
  if (signals.length === 0) return null;
  const ret = Array.isArray(payload?.ret) ? payload.ret.map(String) : [];
  return new UpstreamResponseError(
    'Qwen 网页上游触发 WAF/captcha；Agent 上下文可能过大或账号需要验证',
    WAF_CHALLENGE_CODE,
    { ret }
  );
};
/** Vocabulario de cable de cada API. Juntos aqui para que los gemelos no se separen. */
const RATE_LIMIT_ANTHROPIC_TYPE = 'rate_limit_error';
const RATE_LIMIT_OPENAI_TYPE = 'insufficient_quota';
/**
 * Respaldo por texto: el paquete no siempre trae `data.code`, y el mensaje ingles es el
 * que el usuario vio en su propio transcript. No cubre el "被挤爆啦" del WAF ni el
 * "internal error" de Bad_Request — esos NO son cuota y siguen su propio camino.
 */
const RATE_LIMIT_MESSAGE_RE = /upper limit for today|reached the upper limit|已达上限|次数已达上限/i;

/**
 * ¿Este fallo de upstream es la cuota diaria agotada?
 * @param {unknown} error - Error capturado en el controlador
 * @returns {boolean}
 */
const isRateLimitError = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (isWafChallengeError(error)) return false;
  // Un 429 del upstream es la cuota dicha por el otro canal: la misma pared, sin cuerpo que
  // leer. Clasificarla aqui hace que TODOS los consumidores de este predicado la vean igual
  // (el failover dentro de la peticion, la marca de cuenta agotada, el registro de fallos).
  if (Number(error.response?.status) === 429) return true;
  const code = String(error.code || '').toLowerCase();
  if (code === RATE_LIMIT_CODE.toLowerCase() || code === QUOTA_LIMIT_CODE) return true;
  return RATE_LIMIT_MESSAGE_RE.test(String(error.publicMessage || error.message || ''));
};

/**
 * ¿El transporte se cayo antes o a mitad de la respuesta? Cierres de socket y timeouts tal
 * y como los emiten Node (`ECONNRESET`), undici (`UND_ERR_SOCKET: other side closed` —
 * 3 de 70 peticiones en 8 h el 2026-09-16 en qwen-next, con 63–90 KiB ya escritos) y los
 * streams (`ERR_STREAM_PREMATURE_CLOSE`). NO incluye la cancelacion del propio cliente
 * (`ERR_CANCELED` / AbortError): si quien corto fue el cliente no hay a quien reintentarle.
 * Tampoco un error con respuesta HTTP: eso lo decidio el upstream, no la red.
 */
const TRANSPORT_INTERRUPTION_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'ERR_STREAM_PREMATURE_CLOSE'
]);
const TRANSPORT_INTERRUPTION_MESSAGE_RE = /other side closed|socket hang up|premature close/i;
const isTransportInterruption = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.response) return false;
  if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') return false;
  const code = String(error.code || error.cause?.code || '');
  if (TRANSPORT_INTERRUPTION_CODES.has(code)) return true;
  return TRANSPORT_INTERRUPTION_MESSAGE_RE.test(String(error.message || error.cause?.message || ''));
};

/**
 * El adjunto de contexto largo (upload + parse en Qwen) fallo en una peticion que NO
 * puede compactarse (lleva tools). Es una averia temporal del upstream —el servicio de
 * parse cae a ratos durante minutos u horas; 4 episodios en 9 dias de prod, el del
 * 2026-09-09 21:25 medido en vivo— asi que sale como 529 `overloaded_error` (Anthropic)
 * / 503 `upstream_unavailable` (OpenAI) con Retry-After: el cliente agentico reintenta
 * solo y nunca ejecuta un turno viendo el 7–50 % de su historial.
 */
const CONTEXT_ATTACHMENT_CODE = 'context_externalization_failed';
const CONTEXT_ATTACHMENT_RETRY_AFTER_SECONDS = 10;

const describeContextAttachmentCause = (cause) => {
  const code = cause?.parseCode;
  if (code === 'WAF_CAPTCHA') return 'Upstream WAF is challenging document parse; retry shortly';
  if (code === 'PARSE_RATE_LIMITED') return 'Upstream document parse rate limit reached; retry shortly';
  return 'Upstream document parse unavailable; retry shortly';
};

class ContextExternalizationError extends Error {
  constructor(cause) {
    super(`Agent context attachment failed: ${cause?.message || cause}`);
    this.name = 'ContextExternalizationError';
    this.code = CONTEXT_ATTACHMENT_CODE;
    this.cause = cause;
    this.publicMessage = describeContextAttachmentCause(cause);
    // El cortacircuitos de upload.js sabe cuanto va a rechazar sin subir nada; pedir al
    // cliente que vuelva antes solo encadena 529.
    const wait = Number(cause?.retryAfterSeconds);
    this.retryAfter = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : CONTEXT_ATTACHMENT_RETRY_AFTER_SECONDS;
  }
}

const isContextAttachmentError = (error) => String(error?.code || '') === CONTEXT_ATTACHMENT_CODE;

/**
 * Retry-After en segundos, SOLO si el upstream mando una espera de verdad.
 *
 * Qwen manda `data.num` en HORAS en el paquete de cuota; es la misma lectura que ya hace
 * src/controllers/chat.image.video.js:88 ("请等待约 N 小时后再试"). Si el campo no viene,
 * devuelve null y no se emite cabecera: una espera inventada es peor que ninguna, porque
 * el cliente la respeta al pie de la letra.
 * @param {unknown} error - Error capturado en el controlador
 * @returns {number|null} Segundos enteros, o null si no hay dato real
 */
const rateLimitRetryAfterSeconds = (error) => {
  const hours = Number(error?.details?.waitHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.ceil(hours * 3600);
};

/**
 * MATRIZ DE ALCANZABILIDAD — que recibe el cliente de verdad, por camino y por fase.
 *
 * Un status (y la cabecera Retry-After, la unica que los SDK respetan) solo es alcanzable
 * mientras la respuesta sigue libre. Los caminos en streaming comprometen de forma perezosa:
 * nada sale hasta que el PRIMER frame de Qwen pasa assertNoUpstreamFailure, asi que un
 * chat challenge o un paquete de cuota —que llegan como primer frame— si cambian el status:
 *
 *   camino                          se compromete en                       fallo en el 1er frame
 *   /v1/messages        stream:false  al final                             429/529 + Retry-After
 *   /v1/messages        stream:true   1er frame valido o 1er ping          429/529 + Retry-After
 *                                     (anthropic.js#handleAnthropicStream, ensureMessageStart)
 *   /v1/chat/... llano  stream:false  al final                             429/503 + Retry-After
 *   /v1/chat/... llano  stream:true   1er byte escrito                     429/503 + Retry-After
 *   /v1/chat/... agente stream:true   1er frame valido o 1er latido        429/503 + Retry-After
 *                                     (chat.js#handleOpenAIAgentStream, commitStream)
 *   imagen              stream:true   al entregar el resultado             503 + Retry-After
 *   video (t2v)         stream:true   1er keep-alive (15 s; las cabeceras  503 + Retry-After
 *                                     SSE se fijan antes pero no se envian)
 *
 * Solo el chat challenge y la cuota se quedan sin comprometer; cualquier otro fallo antes
 * del primer frame compromete y sale como antes, dentro del stream (convertirlo en 5xx
 * haria que los SDK lo reintenten contra upload/parse). Tras el compromiso —p. ej. cuota a
 * mitad de respuesta, las 149 negativas de los logs del usuario— la espera viaja DENTRO del
 * evento/frame (`retry_after`): es el unico canal que queda. El compromiso perezoso no
 * reabre el falso "stream muerto" del puente: los `ping`/latidos lo comprometen como mucho
 * un intervalo despues, y el silencio largo que resolvian era el del reintento de correccion,
 * que ocurre ya comprometido.
 */

/**
 * Forma de entrega de un fallo de upstream. Los controladores consultan esto en vez de
 * repetir la deteccion; el `type` de cable lo pone cada uno con su constante de arriba.
 * @param {unknown} error - Error capturado
 * @param {number} [fallbackStatus] - Status cuando NO es cuota (500 Anthropic / 502 OpenAI)
 * @param {number} [overloadedStatus] - Status del adjunto de contexto caido o del chat challenge (529 Anthropic / 503 OpenAI)
 * @returns {{ rateLimited: boolean, overloaded: boolean, status: number, retryAfter: number|null }}
 */
const describeUpstreamFailure = (error, fallbackStatus = 502, overloadedStatus = 529) => {
  if (isWafChallengeError(error)) {
    return {
      rateLimited: false,
      overloaded: true,
      status: overloadedStatus,
      retryAfter: Number(error.retryAfter) || CHAT_CHALLENGE_RETRY_AFTER_SECONDS
    };
  }
  if (isContextAttachmentError(error)) {
    return {
      rateLimited: false,
      overloaded: true,
      status: overloadedStatus,
      retryAfter: Number(error.retryAfter) || CONTEXT_ATTACHMENT_RETRY_AFTER_SECONDS
    };
  }
  if (!isRateLimitError(error)) {
    return { rateLimited: false, overloaded: false, status: fallbackStatus, retryAfter: null };
  }
  return { rateLimited: true, overloaded: false, status: 429, retryAfter: rateLimitRetryAfterSeconds(error) };
};

/**
 * El veredicto cuando no hay causa de upstream que leer: nadie clasifico, y el status lo
 * elige quien conoce el caso (503 configuracion local, 502 upstream opaco). Existe para que
 * la forma del veredicto se defina una sola vez, aqui, y no en cada sitio que la construye.
 * @param {number} status - Status que corresponde al caso
 * @returns {{rateLimited: boolean, overloaded: boolean, status: number, retryAfter: null}}
 */
const unclassifiedFailure = (status) => ({
  rateLimited: false,
  overloaded: false,
  status,
  retryAfter: null
});

/**
 * Denuncia la cuenta que se quedo sin cuota, para que la rotacion deje de elegirla.
 *
 * Existe aqui, junto al clasificador, porque los dos controladores son gemelos y esto
 * tiene que pasar igual en ambos. El status correcto solo arregla la mitad del problema
 * que motivo el cambio: si el servidor sigue devolviendo la misma cuenta muerta al
 * sorteo, cada vuelta la vuelve a quemar. account-rotator#recordError (por donde van los
 * HTTP 4xx/5xx) no enfria a proposito, y ese es justo el hueco.
 *
 * El require es perezoso: account.js arranca temporizadores al cargarse y no debe
 * entrar en la cadena de carga de este modulo, que no arranca ninguno (el unico estado
 * que guarda es el cortacircuitos del chat challenge, mas abajo).
 * @param {unknown} error - Error capturado en el controlador
 * @param {{email?: string}|null} [account] - Cuenta que sirvio la peticion
 * @returns {boolean} true si se marco la cuenta
 */
const noteRateLimitedAccount = (error, account) => {
  if (!isRateLimitError(error)) return false;
  const email = account?.email;
  if (!email) return false;
  try {
    require('./account.js').recordAccountQuotaExhausted(email, rateLimitRetryAfterSeconds(error));
    return true;
  } catch (_) {
    // Marcar la cuenta es contabilidad interna: no puede tumbar la respuesta al cliente.
    return false;
  }
};

/**
 * Chat challenge: Qwen se niega a GENERAR ("被挤爆啦") mientras crear el chat y subir el
 * historial siguen pasando. Medido en prod 2026-09-23..26: 477 de 502 envios desafiados,
 * todos entre 07:00Z y 22:00Z (el pico de Pekin); la misma cuenta pasa de noche y cae de
 * dia, asi que no es la cuenta ni el tamano del contexto. Cada reintento inmediato del
 * cliente agentico re-sube su historial y agota el limitador de parse en segundos.
 *
 * Cortacircuitos (gemelo en intencion del de parse en upload.js, pero con media apertura):
 * - cerrado: cada desafio suma un strike; una respuesta con `choices` los borra.
 * - abierto: tras CHAT_BREAKER_STRIKES seguidos, sendChatRequest contesta 529/503 sin
 *   tocar Qwen durante `chatChallengeBreakerSeconds`. Una respuesta de un stream que ya
 *   estaba en curso borra strikes pero NO cierra: no prueba que Qwen acepte peticiones nuevas.
 * - media apertura: la primera peticion tras el enfriamiento sale como UNICA sonda y
 *   rearma la ventana para las demas. Si Qwen le contesta, cierra; si la desafia, reabre.
 */
const CHAT_BUSY_MESSAGE = 'Qwen 上游繁忙，触发风控验证（被挤爆啦），请稍后重试 / Qwen chat challenge: upstream busy, retry later';
const CHAT_CAPTCHA_MESSAGE = 'Qwen 上游要求人机验证（captcha），请稍后重试 / Qwen chat challenge: captcha required, retry later';
const CHAT_BREAKER_MESSAGE = 'Qwen 上游连续触发风控验证，已暂停发送，请稍后重试 / Qwen chat challenge: repeated upstream challenges, requests paused, retry later';
const CHAT_BUSY_SIGNAL_RE = /RGV587|被挤爆/;
const CHAT_CHALLENGE_RETRY_AFTER_SECONDS = 30;
const CHAT_BREAKER_STRIKES = 3;
const chatBreakers = new Map();
let chatResponseContexts = new WeakMap();
let nextProbeId = 0;

const breakerFor = (egress) => {
  if (!chatBreakers.has(egress)) chatBreakers.set(egress, { strikes: 0, openUntil: 0, probeId: null });
  return chatBreakers.get(egress);
};

const challengeContext = (source) => {
  if (source && typeof source.egress === 'string') return source;
  return source && typeof source === 'object'
    ? (chatResponseContexts.get(source) || { egress: 'direct', probeId: null })
    : { egress: 'direct', probeId: null };
};

const bindChatChallengeContext = (response, context) => {
  if (response && typeof response === 'object') chatResponseContexts.set(response, context);
  return response;
};

// Reloj inyectable, como parseClock en upload.js: los tests avanzan la ventana sin dormir.
let chatClock = () => Date.now();
const setChatChallengeClockForTests = (fn) => { chatClock = typeof fn === 'function' ? fn : () => Date.now(); };

// Perezosos como el require de account.js: config valida el entorno al cargarse.
const chatBreakerSeconds = () => Math.max(0, Number(require('../config/index.js').chatChallengeBreakerSeconds) || 0);
const logger = () => require('./logger').logger;

const resetChatChallengeBreaker = () => {
  chatBreakers.clear();
  chatResponseContexts = new WeakMap();
  nextProbeId = 0;
};

/** @returns {number} Retry-After (s) para el desafio que acaba de llegar */
const noteChatChallenge = (source) => {
  const context = challengeContext(source);
  const breaker = breakerFor(context.egress);
  breaker.strikes += 1;
  const seconds = chatBreakerSeconds();
  const isProbe = context.probeId !== null && context.probeId === breaker.probeId;
  if (seconds <= 0 || (breaker.probeId !== null && !isProbe) ||
      (breaker.probeId === null && breaker.strikes < CHAT_BREAKER_STRIKES)) {
    return CHAT_CHALLENGE_RETRY_AFTER_SECONDS;
  }
  breaker.openUntil = chatClock() + seconds * 1000;
  breaker.probeId = null;
  logger().warn('Qwen chat challenge 连续 ' + breaker.strikes + ' 次，' + seconds + 's 内不再发送聊天请求', 'UPSTREAM');
  return seconds;
};

const noteChatAnswer = (source) => {
  const context = challengeContext(source);
  const breaker = breakerFor(context.egress);
  breaker.strikes = 0;
  if (breaker.probeId === null || context.probeId !== breaker.probeId) return;
  breaker.openUntil = 0;
  breaker.probeId = null;
  logger().info('Qwen chat challenge 探测请求已正常返回，恢复发送聊天请求', 'UPSTREAM');
};

const noteChatChallengeAnswer = (source) => noteChatAnswer(source);

// Los SDK de Anthropic y OpenAI solo respetan un Retry-After por debajo de 60 s; con 60 o mas
// vuelven a su backoff corto. La ventana del breaker puede ser 60: el cliente vuelve 1 s antes
// y, si aun esta abierto, recibe el segundo que falta.
const CHAT_CHALLENGE_MAX_RETRY_AFTER_SECONDS = 59;

const chatChallengeError = (message, retryAfter, details) => {
  const error = new UpstreamResponseError(message, WAF_CHALLENGE_CODE, details);
  error.retryAfter = Math.min(retryAfter, CHAT_CHALLENGE_MAX_RETRY_AFTER_SECONDS);
  return error;
};

/**
 * sendChatRequest y la ruta de imagen/video lo llaman antes de crear el chat o subir nada.
 * Con el enfriamiento agotado deja pasar a quien llega primero como sonda.
 */
const assertChatChallengeBreakerClosed = (account) => {
  const egress = require('./proxy-helper').describeEgress(account);
  const breaker = breakerFor(egress);
  const context = { egress, probeId: null };
  if (!breaker.openUntil) return context;
  const now = chatClock();
  const remaining = Math.ceil((breaker.openUntil - now) / 1000);
  if (remaining > 0) throw chatChallengeError(CHAT_BREAKER_MESSAGE, remaining, { breakerOpen: true });
  context.probeId = ++nextProbeId;
  breaker.openUntil = now + chatBreakerSeconds() * 1000;
  breaker.probeId = context.probeId;
  return context;
};

/**
 * Release a probe that failed before Qwen returned an answer or challenge.
 * @param {object} source - Probe context returned by assertChatChallengeBreakerClosed
 * @returns {void}
 */
const releaseChatProbe = (source) => {
  const context = challengeContext(source);
  if (context.probeId === null) return;
  const breaker = breakerFor(context.egress);
  if (breaker.probeId !== context.probeId) return;
  breaker.probeId = null;
  breaker.openUntil = Math.max(1, chatClock());
};

/**
 * Si el frame es un chat challenge devuelve su error (y cuenta el strike); si no, null.
 * "被挤爆啦" es saturacion; un captcha/punish sin ella es verificacion humana.
 * @param {object|string} payload - Frame ya parseado o pagina HTML del captcha
 * @param {object} source - Respuesta o contexto de la sonda
 * @returns {UpstreamResponseError|null}
 */
const chatChallengeFrom = (payload, source) => {
  const detected = detectWafChallenge(payload);
  if (!detected) return null;
  const busy = CHAT_BUSY_SIGNAL_RE.test(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return chatChallengeError(busy ? CHAT_BUSY_MESSAGE : CHAT_CAPTCHA_MESSAGE,
    noteChatChallenge(source), detected.details);
};

/**
 * Qwen Web 有时以 HTTP 200 + 普通 JSON 返回 WAF/captcha 或业务失败。
 * 这些帧没有 choices，若直接跳过就会被误包装成空成功或正常 stop。
 * Alimenta el cortacircuitos del chat challenge: cada desafio suma un strike y cada frame
 * con `choices` cuenta como respuesta (ver noteChatAnswer).
 */
const assertNoUpstreamFailure = (payload, source) => {
  const challenge = chatChallengeFrom(payload, source);
  if (challenge) throw challenge;
  if (!payload || typeof payload !== 'object') return;

  const explicitError = payload.error;
  if (explicitError && !Array.isArray(payload.choices)) {
    const message = typeof explicitError === 'string'
      ? explicitError
      : (explicitError.message || explicitError.msg || 'Qwen 上游返回业务错误');
    const waitHours = explicitError.num ?? payload.data?.num;
    throw new UpstreamResponseError(message, explicitError.code || 'upstream_business_error',
      waitHours == null ? null : { waitHours });
  }

  if (payload.success === false && !Array.isArray(payload.choices)) {
    const message = payload.data?.details || payload.data?.message || payload.message || 'Qwen 上游返回业务错误';
    // `num` (horas de espera) viaja en `details` para que el controlador pueda emitir un
    // Retry-After real. Se pasa crudo: rateLimitRetryAfterSeconds lo valida.
    const waitHours = payload.data?.num;
    throw new UpstreamResponseError(
      message,
      payload.data?.code || payload.code || 'upstream_business_error',
      waitHours === undefined || waitHours === null ? null : { waitHours }
    );
  }

  if (Array.isArray(payload.choices)) noteChatAnswer(source);
};

module.exports = {
  UpstreamResponseError,
  assertNoUpstreamFailure,
  detectWafChallenge,
  isWafChallengeBody,
  isRateLimitError,
  isWafChallengeError,
  isTransportInterruption,
  assertChatChallengeBreakerClosed,
  bindChatChallengeContext,
  chatChallengeFrom,
  noteChatChallengeAnswer,
  releaseChatProbe,
  resetChatChallengeBreaker,
  setChatChallengeClockForTests,
  rateLimitRetryAfterSeconds,
  describeUpstreamFailure,
  unclassifiedFailure,
  noteRateLimitedAccount,
  ContextExternalizationError,
  isContextAttachmentError,
  RATE_LIMIT_CODE,
  RATE_LIMIT_ANTHROPIC_TYPE,
  RATE_LIMIT_OPENAI_TYPE
};
