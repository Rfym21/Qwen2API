'use strict'

/**
 * Paridad de decisión entre las dos rutas Anthropic, en el seam de la ruta HTTP (issue 06
 * de `.scratch/agent-turn-gate/`).
 *
 * El corpus (`tests/agent-turn-corpus.test.js`) clava cada celda contra el baseline grabado.
 * Acá se afirma la relación ENTRE las dos celdas Anthropic: conducidos los mismos escenarios
 * de decisión por `/v1/messages` con y sin streaming, las dos rutas tienen que llegar a la
 * misma decisión de turno — mismo status, mismo "reintentó o no", y el mismo hint viajando
 * al modelo, en el mismo orden. Es lo que se ve de la puerta única desde afuera: si un
 * refactor vuelve a separar los dos loops, esto rompe acá aunque el baseline se re-grabe.
 *
 * Las desviaciones están medidas y listadas (abajo): son diferencias de LOOP, no de puerta.
 * Una desviación que no esté en la lista falla; una entrada de la lista que ya no desvíe
 * también, para que la lista no envejezca tapando paridad.
 *
 * El módulo del corpus se importa PRIMERO: fija los pines de entorno (AGENT_TURN_MAX_ATTEMPTS
 * y compañía) antes de que cualquier require arrastre config/index.js.
 */

const { SCENARIOS, SURFACES, runScenario } = require('./agent-turn-corpus.scenarios.js')

const test = require('node:test')
const assert = require('node:assert/strict')

const STREAM = SURFACES.find(surface => surface.id === 'anthropic.stream')
const NON_STREAM = SURFACES.find(surface => surface.id === 'anthropic.nonstream')

/**
 * Desviaciones medidas entre las dos rutas, con su causa. Estar acá no dispensa de la
 * aserción: la forma esperada sigue siendo "el no-stream decide al menos cada ronda que
 * decidió el stream, con el mismo hint" y se afirma.
 */
const DESVIACIONES = new Map([
  ['delivered_round_then_empty',
    'el loop streaming ya gastó su único reintento posterior a texto visible ' +
    '(retriedAfterVisibleText: la prosa de la ronda 1 salió al cliente) y no puede pedir la ' +
    'ronda 3; el no-stream no entrega nada hasta el final, así que decide también la ronda ' +
    'vacía y la reintenta. Cupo del loop, no de la puerta.']
])

// account.js arranca intervalos con ref al importarse (vía controllers).
test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* nada que limpiar */ }
})

for (const scenario of SCENARIOS) {
  test(`paridad de la puerta Anthropic: ${scenario.id} — ${scenario.title}`, async () => {
    const stream = await runScenario(scenario, STREAM)
    const nonStream = await runScenario(scenario, NON_STREAM)
    const where = scenario.id

    assert.equal(nonStream.status, stream.status, `${where}: el status del cable difiere`)
    assert.equal(nonStream.retried, stream.retried, `${where}: la decisión de reintentar difiere`)
    // La guarda de fuga corta el mismo frame en las dos rutas: el punto de aborto del intento
    // es parte de la misma decisión de turno.
    assert.deepEqual(nonStream.upstreamFrames, stream.upstreamFrames,
      `${where}: las dos rutas tiraron distinta cantidad de frames del upstream`)

    const desviacion = DESVIACIONES.get(scenario.id)
    if (!desviacion) {
      assert.equal(nonStream.upstreamSends, stream.upstreamSends,
        `${where}: mismo veredicto tiene que dar los mismos envíos al upstream`)
      assert.deepEqual(nonStream.hints, stream.hints, `${where}: los hints que viajaron al modelo difieren`)
      return
    }

    assert.ok(nonStream.upstreamSends > stream.upstreamSends,
      `${where}: declarada como desviación y ya no desvía — sacarla de DESVIACIONES (${desviacion})`)
    assert.deepEqual(nonStream.hints.slice(0, stream.hints.length), stream.hints,
      `${where}: la desviación tiene que EXTENDER la decisión del stream, no cambiarla`)
  })
}
