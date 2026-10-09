#!/usr/bin/env node
'use strict'

/**
 * Grabador del corpus de caracterización del gate de turno agéntico (issue 03).
 *
 *   node tools/dev-probes/record-agent-turn-corpus.js           # graba el baseline
 *   node tools/dev-probes/record-agent-turn-corpus.js --check   # corre y compara, sin escribir
 *
 * Se corre UNA vez sobre el árbol sin cambios y congela el resultado observable de cada
 * escenario (superficie × modo × razón) en tests/fixtures/agent-turn-corpus.baseline.json,
 * este archivo. Después de la consolidación (tickets 04..07) este comando es el que
 * muestra el diff: cada línea tiene que estar en la lista deliberada del spec o es un
 * cambio silencioso.
 *
 * Sin red y sin login: el sender del upstream está inyectado, no hay cuentas que cargar.
 */

const fs = require('node:fs')
const path = require('node:path')

const {
  SCENARIOS,
  SURFACES,
  runCorpus,
  stableStringify
} = require('../../tests/agent-turn-corpus.scenarios.js')

const BASELINE_PATH = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'agent-turn-corpus.baseline.json')

/**
 * Resumen legible: qué token pretendía cubrir el escenario en esta superficie y qué hizo
 * la superficie con esos frames. Las banderas son la parte útil: NO-RETRY sobre una fila
 * aplicable es una celda hueca (los frames no llegan a la razón que dicen cubrir).
 */
const line = (scenario, surface, entry) => {
  const wanted = !entry.applicable ? 'N/A' : (entry.targets.length ? entry.targets.join('+') : 'accept')
  const flags = [
    entry.applicable && entry.targets.length > 0 && entry.upstreamSends < 2 ? 'NO-RETRY' : null,
    entry.applicable && entry.targets.length === 0 && entry.retried ? 'UNEXPECTED-RETRY' : null,
    entry.delivered.length === 0 ? 'EMPTY-OUTPUT' : null,
    !entry.applicable && entry.retried ? 'not-applicable-but-retried' : null
  ].filter(Boolean)
  const frames = entry.upstreamFrames.served < entry.upstreamFrames.total
    ? `frames=${entry.upstreamFrames.served}/${entry.upstreamFrames.total}CUT`
    : `frames=${entry.upstreamFrames.served}/${entry.upstreamFrames.total}`
  return `  ${scenario.id.padEnd(30)} ${surface.id.padEnd(20)} ` +
    `${String(entry.status).padEnd(4)} sends=${entry.upstreamSends} ` +
    `want=${wanted.padEnd(30)} retried=${entry.retried ? 'yes' : 'no '} ` +
    `hints=${entry.hints.length} ${frames} out=${entry.delivered.length} ${flags.join(',')}`
}

const main = async () => {
  const actual = await runCorpus()
  const baseline = { corpus: 'agent-turn-corpus', version: 1, scenarios: actual }
  const serialized = stableStringify(baseline)

  for (const scenario of SCENARIOS) {
    console.log(`\n${scenario.group}: ${scenario.id} — ${scenario.title}`)
    for (const surface of SURFACES) {
      console.log(line(scenario, surface, actual[scenario.id][surface.id]))
    }
  }

  // Fila aplicable que no reintenta (o que no entrega nada) = baseline hueco: los frames no
  // llegan al camino que la fila dice cubrir. Se arreglan los frames, no se graba encima.
  const hollow = []
  for (const scenario of SCENARIOS) {
    for (const surface of SURFACES) {
      const entry = actual[scenario.id][surface.id]
      if (!entry.applicable) continue
      if (entry.targets.length > 0 && entry.upstreamSends < 2) hollow.push(`${scenario.id}/${surface.id}: declara ${entry.targets.join('+')} y no reintentó`)
      if (entry.targets.length === 0 && entry.retried) hollow.push(`${scenario.id}/${surface.id}: celda de aceptación que reintentó`)
      if (entry.delivered.length === 0) hollow.push(`${scenario.id}/${surface.id}: no entrega nada al cliente`)
      if (scenario.requiresCut && entry.upstreamFrames.served >= entry.upstreamFrames.total) hollow.push(`${scenario.id}/${surface.id}: la guarda de fuga no abortó el stream`)
    }
  }
  if (hollow.length > 0) {
    console.error('\nBALANCE HUECO — no se graba:')
    for (const item of hollow) console.error(`  ${item}`)
    process.exit(1)
  }

  if (process.argv.includes('--check')) {
    const previous = fs.existsSync(BASELINE_PATH)
      ? fs.readFileSync(BASELINE_PATH, 'utf8')
      : null
    const same = previous === serialized
    console.log(`\n${same ? 'OK: idéntico al baseline grabado' : 'DIFF: el baseline grabado no coincide'}`)
    if (!same) process.exitCode = 1
  } else {
    fs.writeFileSync(BASELINE_PATH, serialized)
    console.log(`\nBaseline escrito en ${path.relative(process.cwd(), BASELINE_PATH)}`)
  }

  // account.js abre intervalos con ref al importarse: sin esto el proceso no termina.
  try { require('../../src/utils/account.js').destroy() } catch (_) {}
  process.exit(process.exitCode || 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
