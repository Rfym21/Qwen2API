const { test } = require('node:test')
const assert = require('node:assert/strict')

const { parseSummary, evaluate, formatVerdict } = require('../tools/test-gate.js')

const SPEC_TAIL = [
  '✔ some passing test (1.2ms)',
  'ℹ tests 972',
  'ℹ suites 122',
  'ℹ pass 972',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 4364.5'
].join('\n')

const TAP_TAIL = [
  '# tests 972',
  '# suites 122',
  '# pass 972',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0'
].join('\n')

const EXPECTED = { tests: 972, suites: 122 }

test('parseSummary reads the spec reporter summary block', () => {
  const s = parseSummary(SPEC_TAIL)
  assert.equal(s.tests, 972)
  assert.equal(s.suites, 122)
  assert.equal(s.pass, 972)
  assert.equal(s.fail, 0)
})

test('parseSummary reads the tap reporter summary block', () => {
  const s = parseSummary(TAP_TAIL)
  assert.equal(s.tests, 972)
  assert.equal(s.fail, 0)
})

test('parseSummary is not fooled by a test NAME that looks like a summary line', () => {
  const output = ['✔ ℹ tests 5 is a great name (0.1ms)', SPEC_TAIL].join('\n')
  assert.equal(parseSummary(output).tests, 972)
})

test('parseSummary takes the LAST occurrence when a summary appears twice', () => {
  const output = [SPEC_TAIL.replace('ℹ tests 972', 'ℹ tests 111'), SPEC_TAIL].join('\n')
  assert.equal(parseSummary(output).tests, 972)
})

test('parseSummary returns null when there is no summary at all (the hang case)', () => {
  assert.equal(parseSummary('✔ a test ran (1ms)\nand then nothing'), null)
  assert.equal(parseSummary(''), null)
})

test('a full clean run passes the gate', () => {
  const v = evaluate({ summary: parseSummary(SPEC_TAIL), exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, true)
  assert.equal(v.code, 0)
})

// The bug this gate exists for: node's --test-force-exit is propagated to child
// test processes; a child's process.exit() drops unflushed stdout, so a tail of
// its reporter output is silently lost. The runner still exits 0 with fail 0.
test('THE BUG: a short run with fail 0 and exit 0 FAILS the gate', () => {
  const short = parseSummary(SPEC_TAIL.replace('ℹ tests 972', 'ℹ tests 944'))
  const v = evaluate({ summary: short, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'SHORT_RUN')
  assert.notEqual(v.code, 0)
  assert.equal(v.retryable, true)
  assert.match(v.message, /944/)
  assert.match(v.message, /972/)
})

test('a run missing only suites also fails the gate', () => {
  const short = parseSummary(SPEC_TAIL.replace('ℹ suites 122', 'ℹ suites 121'))
  const v = evaluate({ summary: short, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'SHORT_SUITES')
  assert.equal(v.retryable, true)
})

test('real test failures beat a short count and are never retryable', () => {
  const failing = parseSummary(SPEC_TAIL.replace('ℹ fail 0', 'ℹ fail 3').replace('ℹ tests 972', 'ℹ tests 900'))
  const v = evaluate({ summary: failing, exitCode: 1, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'TEST_FAILURES')
  assert.equal(v.retryable, false)
})

test('a missing summary fails loudly and is not retryable', () => {
  const v = evaluate({ summary: null, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NO_SUMMARY')
  assert.equal(v.retryable, false)
  assert.notEqual(v.code, 0)
})

test('a nonzero runner exit with a clean summary still fails', () => {
  const v = evaluate({ summary: parseSummary(SPEC_TAIL), exitCode: 7, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'RUNNER_EXIT')
  assert.equal(v.retryable, false)
})

test('MORE tests than expected fails too, so the baseline cannot rot', () => {
  const more = parseSummary(SPEC_TAIL.replace('ℹ tests 972', 'ℹ tests 980'))
  const v = evaluate({ summary: more, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'BASELINE_STALE')
  assert.equal(v.retryable, false)
  assert.match(v.message, /bless/i)
})

test('a timed-out runner reports the watchdog, never a pass', () => {
  const v = evaluate({ summary: null, exitCode: null, expected: EXPECTED, timedOut: true })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'TIMEOUT')
  assert.equal(v.retryable, false)
})

test('formatVerdict never prints a pass banner for a failing verdict', () => {
  const bad = evaluate({ summary: parseSummary(SPEC_TAIL.replace('ℹ tests 972', 'ℹ tests 1')), exitCode: 0, expected: EXPECTED })
  const text = formatVerdict(bad)
  assert.match(text, /FAIL/)
  assert.doesNotMatch(text, /\bPASS\b/)
})
