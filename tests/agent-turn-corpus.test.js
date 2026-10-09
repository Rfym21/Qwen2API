'use strict'

/**
 * Test permanente del corpus de caracterización del gate de turno agéntico (issue 03).
 *
 * Afirma, escenario por escenario y superficie por superficie, el resultado observable
 * grabado en tests/fixtures/agent-turn-corpus.baseline.json — no una comparación contra
 * un archivo vivo: el baseline es el artefacto y este test lo clava. El refactor de los
 * tickets 04..07 tiene que aparecer como un diff nombrado contra ese archivo, y este test
 * es lo que hace que el diff no pueda pasar en silencio.
 *
 * El corpus en sí (frames, sender con guion, extracción del resultado) vive en
 * ./agent-turn-corpus.scenarios.js, compartido con el grabador. Sin red y sin login.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const baseline = require('./fixtures/agent-turn-corpus.baseline.json')
const { SCENARIOS, SURFACES, runScenario, corpusViolations } = require('./agent-turn-corpus.scenarios.js')

// account.js arranca intervalos con ref al importarse (vía controllers).
test.after(() => {
  try { require('../src/utils/account.js').destroy() } catch (_) { /* nada que limpiar */ }
})

test('el baseline versionado cubre todas las celdas del corpus', () => {
  assert.equal(baseline.corpus, 'agent-turn-corpus')
  assert.equal(baseline.version, 1)
  assert.deepEqual(
    Object.keys(baseline.scenarios).sort(),
    SCENARIOS.map(scenario => scenario.id).sort()
  )
  for (const scenario of SCENARIOS) {
    assert.deepEqual(
      Object.keys(baseline.scenarios[scenario.id]).sort(),
      SURFACES.map(surface => surface.id).sort(),
      `celdas grabadas de ${scenario.id}`
    )
  }
})

for (const scenario of SCENARIOS) {
  test(`corpus de turno agéntico: ${scenario.id} — ${scenario.title}`, async () => {
    for (const surface of SURFACES) {
      const entry = await runScenario(scenario, surface)
      const where = `${scenario.id} en ${surface.id}`
      assert.deepStrictEqual(entry, baseline.scenarios[scenario.id][surface.id], where)

      // Anti-baseline-hueco: los mismos invariantes que aplica el grabador antes de escribir,
      // desde la misma implementación — si divergieran, el grabador podría congelar una fila
      // que el test después acepta sin mirar.
      assert.deepStrictEqual(corpusViolations(scenario, entry, where), [], where)
    }
  })
}
