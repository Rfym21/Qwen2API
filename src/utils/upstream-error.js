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
  if (String(error.code || '').toLowerCase() === RATE_LIMIT_CODE.toLowerCase()) return true;
  return RATE_LIMIT_MESSAGE_RE.test(String(error.publicMessage || error.message || ''));
};

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
 * Forma de entrega de un fallo de upstream. Los controladores consultan esto en vez de
 * repetir la deteccion; el `type` de cable lo pone cada uno con su constante de arriba.
 * @param {unknown} error - Error capturado
 * @param {number} [fallbackStatus] - Status cuando NO es cuota (500 Anthropic / 502 OpenAI)
 * @returns {{ rateLimited: boolean, status: number, retryAfter: number|null }}
 */
const describeUpstreamFailure = (error, fallbackStatus = 502) => {
  if (!isRateLimitError(error)) {
    return { rateLimited: false, status: fallbackStatus, retryAfter: null };
  }
  return { rateLimited: true, status: 429, retryAfter: rateLimitRetryAfterSeconds(error) };
};

/**
 * Qwen Web 有时以 HTTP 200 + 普通 JSON 返回 WAF/captcha 或业务失败。
 * 这些帧没有 choices，若直接跳过就会被误包装成空成功或正常 stop。
 */
const assertNoUpstreamFailure = (payload) => {
  if (!payload || typeof payload !== 'object') return;

  const ret = Array.isArray(payload.ret)
    ? payload.ret.map(String)
    : (payload.ret ? [String(payload.ret)] : []);
  const upstreamSignals = [
    ...ret,
    payload.code,
    payload.data?.code,
    payload.data?.url,
    payload.error?.code
  ].filter(Boolean).map(String);
  if (upstreamSignals.some(item => /FAIL_SYS_USER_VALIDATE|RGV587|captcha|\/punish\?/i.test(item))) {
    throw new UpstreamResponseError(
      'Qwen 网页上游触发 WAF/captcha；Agent 上下文可能过大或账号需要验证',
      'upstream_waf_challenge',
      { ret }
    );
  }

  const explicitError = payload.error;
  if (explicitError && !Array.isArray(payload.choices)) {
    const message = typeof explicitError === 'string'
      ? explicitError
      : (explicitError.message || explicitError.msg || 'Qwen 上游返回业务错误');
    throw new UpstreamResponseError(message, explicitError.code || 'upstream_business_error');
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
  isRateLimitError,
  rateLimitRetryAfterSeconds,
  describeUpstreamFailure,
  RATE_LIMIT_CODE,
  RATE_LIMIT_ANTHROPIC_TYPE,
  RATE_LIMIT_OPENAI_TYPE
};
