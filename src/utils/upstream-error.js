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
const WAF_SIGNAL_RE = /FAIL_SYS_USER_VALIDATE|RGV587|captcha|\/punish\?/i;
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
  const code = String(error.code || '').toLowerCase();
  if (code === RATE_LIMIT_CODE.toLowerCase() || code === QUOTA_LIMIT_CODE) return true;
  return RATE_LIMIT_MESSAGE_RE.test(String(error.publicMessage || error.message || ''));
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
 * El 429 solo es alcanzable mientras las cabeceras siguen libres. En streaming los dos
 * controladores comprometen el 200 ANTES de leer un byte del upstream, asi que un
 * paquete de cuota —que llega como PRIMER frame— nunca puede cambiar el status:
 *
 *   camino                          fase             status  senal para el cliente
 *   /v1/messages        stream:false  libre           429     body.error.type
 *   /v1/messages        stream:true   comprometida    200     evento error.type (+retry_after)
 *   /v1/chat/... llano  stream:false  libre           429     body.error.type
 *   /v1/chat/... llano  stream:true   libre 1er byte  429     body.error.type
 *   /v1/chat/... agente stream:true   comprometida    200     frame error.type (+retry_after)
 *
 * La fila que importa es la segunda: Claude Code habla /v1/messages con stream:true, y
 * las 149 negativas de cuota de los logs del usuario salen todas de ahi. Decir que este
 * cambio "mapea la cuota a 429 en los dos caminos" es falso justo para el modo que el
 * usuario ejecuta; lo que hace es que la negativa sea RECONOCIBLE en los dos caminos y
 * en las dos fases. anthropic.js:1203/1211 y chat.js:407 son las lineas que comprometen
 * la respuesta, y adelantarlas es deliberado: sin cabeceras enviadas no se pueden mandar
 * `ping` dentro del protocolo (anthropic.js:1156-1160), que es como se elimino el falso
 * "stream muerto" del puente. Por eso la espera viaja DENTRO del evento/frame: es el
 * unico canal que queda cuando la cabecera Retry-After ya no se puede poner.
 */

/**
 * Forma de entrega de un fallo de upstream. Los controladores consultan esto en vez de
 * repetir la deteccion; el `type` de cable lo pone cada uno con su constante de arriba.
 * @param {unknown} error - Error capturado
 * @param {number} [fallbackStatus] - Status cuando NO es cuota (500 Anthropic / 502 OpenAI)
 * @param {number} [overloadedStatus] - Status del adjunto de contexto caido (529 Anthropic / 503 OpenAI)
 * @returns {{ rateLimited: boolean, overloaded: boolean, status: number, retryAfter: number|null }}
 */
const describeUpstreamFailure = (error, fallbackStatus = 502, overloadedStatus = 529) => {
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
 * Denuncia la cuenta que se quedo sin cuota, para que la rotacion deje de elegirla.
 *
 * Existe aqui, junto al clasificador, porque los dos controladores son gemelos y esto
 * tiene que pasar igual en ambos. El status correcto solo arregla la mitad del problema
 * que motivo el cambio: si el servidor sigue devolviendo la misma cuenta muerta al
 * sorteo, cada vuelta la vuelve a quemar. account-rotator#recordError (por donde van los
 * HTTP 4xx/5xx) no enfria a proposito, y ese es justo el hueco.
 *
 * El require es perezoso: account.js arranca temporizadores al cargarse y no debe
 * entrar en la cadena de carga de este modulo, que es puro.
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
 * Qwen Web 有时以 HTTP 200 + 普通 JSON 返回 WAF/captcha 或业务失败。
 * 这些帧没有 choices，若直接跳过就会被误包装成空成功或正常 stop。
 */
const assertNoUpstreamFailure = (payload) => {
  const wafChallenge = detectWafChallenge(payload);
  if (wafChallenge) throw wafChallenge;
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
};

module.exports = {
  UpstreamResponseError,
  assertNoUpstreamFailure,
  detectWafChallenge,
  isWafChallengeBody,
  isRateLimitError,
  isWafChallengeError,
  rateLimitRetryAfterSeconds,
  describeUpstreamFailure,
  noteRateLimitedAccount,
  ContextExternalizationError,
  isContextAttachmentError,
  RATE_LIMIT_CODE,
  RATE_LIMIT_ANTHROPIC_TYPE,
  RATE_LIMIT_OPENAI_TYPE
};
