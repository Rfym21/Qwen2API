const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  assertNoUpstreamFailure,
  detectWafChallenge,
  isWafChallengeBody,
  isWafChallengeError,
  isRateLimitError
} = require('../src/utils/upstream-error.js')

// Material real: lo que chat.qwen.ai devolvio en vivo (HTTP 200) cuando el captcha
// del WAF salto, con el cuerpo exacto que vio el usuario.
const capturedWafPayload = () => ({
  ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'],
  data: {
    url: 'https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=xgad0069&x5step=2&action=captchaconnect&pureCaptcha=',
    dialogSize: { width: '375px', height: '665px' }
  },
  dialogSize: { width: '375px', height: '665px' },
  attributes: { style: 'background-color: transparent' }
})

test('detectWafChallenge reconoce el paquete real de captcha', () => {
  const err = detectWafChallenge(capturedWafPayload())
  assert.ok(err, 'el paquete capturado tiene que reconocerse')
  assert.equal(err.code, 'upstream_waf_challenge')
  assert.equal(isWafChallengeError(err), true)
  // No es cuota agotada: mandarlo como 429 haria que el cliente reintente contra un muro.
  assert.equal(isRateLimitError(err), false)
  // El `ret` viaja crudo para que el log diga QUE contesto el upstream.
  assert.deepEqual(err.details.ret, ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'])
})

// Esta es la razon de ser del helper. El camino de texto ya lo reconocia; el de
// imagen/video no, y como `parseUpstreamImageError` solo miraba `success:false`,
// el paquete se colaba entero: la generacion "salia bien" y se devolvia la imagen
// de relleno del propio Qwen (img.alicdn.com) como si fuera el resultado.
test('assertNoUpstreamFailure lanza con el mismo paquete (camino de texto)', () => {
  assert.throws(
    () => assertNoUpstreamFailure(capturedWafPayload()),
    (e) => e.code === 'upstream_waf_challenge'
  )
})

test('una respuesta normal NO se confunde con un captcha', () => {
  // Canario: si el detector se pasara de listo, todo el trafico bueno saldria como 502.
  for (const payload of [
    { choices: [{ message: { content: 'hola' } }] },
    { data: [{ id: 'qwen3.8-max' }] },
    { success: true, data: {} },
    undefined,
    null,
    42
  ]) {
    assert.equal(detectWafChallenge(payload), null, `falso positivo con ${JSON.stringify(payload)}`)
    assert.doesNotThrow(() => assertNoUpstreamFailure(payload))
  }
})

test('detecta el challenge por cada señal, no solo por `ret`', () => {
  // El upstream no siempre usa la misma forma: basta una de las señales.
  const byCode = detectWafChallenge({ code: 'FAIL_SYS_USER_VALIDATE' })
  assert.ok(byCode, 'señal en code')
  const byUrl = detectWafChallenge({ data: { url: 'https://x/_____tmd_____/punish?x5secdata=abc' } })
  assert.ok(byUrl, 'señal en data.url')
  const byStringRet = detectWafChallenge({ ret: 'RGV587_ERROR::SM::blah' })
  assert.ok(byStringRet, 'señal con ret escalar')
})

// El 2026-09-19 la ruta de imagen recibio la MISMA pagina de captcha pero servida como
// HTML (16 KB), no como el paquete JSON de arriba. El detector solo miraba el JSON, asi
// que el HTML pasaba entero: sin lineas `data:`, JSON.parse fallaba, y el extractor de
// URLs sacaba del propio HTML la imagen de relleno de Qwen y la entregaba como resultado.
test('reconoce la pagina de captcha cuando llega como HTML', () => {
  const htmlChallenge = [
    '<!doctype html>',
    '<meta charset="UTF-8">',
    '<meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29a6197d3460">',
    '<meta name="aliyun_waf_bb" content="eade71455e2ad9c6d08b82bc7d98df8c">',
    '<title></title>'
  ].join('\n')

  assert.equal(isWafChallengeBody(htmlChallenge), true)
  const err = detectWafChallenge(htmlChallenge)
  assert.ok(err, 'el HTML tiene que reconocerse')
  assert.equal(err.code, 'upstream_waf_challenge')
})

test('un cuerpo normal NO se confunde con la pagina de captcha', () => {
  // Canario del detector de HTML: texto legitimo puede nombrar "captcha" sin serlo.
  for (const body of [
    '{"choices":[{"message":{"content":"hi"}}]}',
    '![image](https://img.alicdn.com/imgextra/i1/real.png)',
    '<html><body>hola</body></html>',
    '<!doctype html><html><head><title>chat.qwen.ai</title></head></html>',
    'data: {"choices":[{"delta":{"content":"a captcha is a challenge"}}]}',
    ''
  ]) {
    assert.equal(isWafChallengeBody(body), false, `falso positivo con ${JSON.stringify(body.slice(0, 40))}`)
    assert.equal(detectWafChallenge(body), null)
  }
})
