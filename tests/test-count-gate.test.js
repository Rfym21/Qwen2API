const { test } = require('node:test')
const assert = require('node:assert/strict')

const { parseSummary, sumSummaries, evaluate, formatVerdict, computeBlessed, PER_FILE_SUM } = require('../tools/test-gate.js')

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

// Rewrite summary counters on the fixture. Keep runs PHYSICALLY POSSIBLE:
// node reports tests = pass + fail + skipped + todo + cancelled, so a truncated
// run loses `tests` and `pass` together — the parent simply never received
// those results. A fixture with more passes than tests describes no real run.
const skewed = (over) => parseSummary(
  Object.entries(over).reduce(
    (text, [k, v]) => text.replace(new RegExp(`ℹ ${k} \\d+`), `ℹ ${k} ${v}`),
    SPEC_TAIL))

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
  const short = skewed({ tests: 944, pass: 944 })
  const v = evaluate({ summary: short, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'SHORT_RUN')
  assert.notEqual(v.code, 0)
  assert.equal(v.retryable, true)
  assert.match(v.message, /944/)
  assert.match(v.message, /972/)
})

test('a run missing only suites also fails the gate', () => {
  const short = skewed({ suites: 121 })
  const v = evaluate({ summary: short, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'SHORT_SUITES')
  assert.equal(v.retryable, true)
})

test('real test failures beat a short count and are never retryable', () => {
  const failing = skewed({ tests: 900, pass: 897, fail: 3 })
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
  const more = skewed({ tests: 980, pass: 980 })
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
  const bad = evaluate({ summary: skewed({ tests: 1, pass: 1 }), exitCode: 0, expected: EXPECTED })
  const text = formatVerdict(bad)
  assert.match(text, /FAIL/)
  assert.doesNotMatch(text, /\bPASS\b/)
})

/* ---------------------------------------------------------------------------
 * DEFECT 1 — a disabled test keeps its place in `tests` and is invisible to a
 * pure count gate. `it.skip` on all six tests of a file left the total at the
 * blessed number, `fail 0`, and the gate printed a PASS banner byte-identical
 * to an honest run's. Unlike the truncation race this is deterministic: it
 * survives every retry and gets committed.
 *
 * Node's own arithmetic (verified on v24.15.0): tests = pass + fail + skipped
 * + todo + cancelled. Suites are NOT in `pass`, and a `todo` test is NOT in
 * `pass` either, despite the reporter printing a check mark for it.
 * ------------------------------------------------------------------------- */

test('DEFECT 1: six it.skip tests keep the count and must NOT pass the gate', () => {
  const s = skewed({ pass: 966, skipped: 6 })
  assert.equal(s.tests, 972)
  assert.equal(s.fail, 0)
  const v = evaluate({ summary: s, exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false, 'a run with six disabled tests must not be a pass')
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.notEqual(v.code, 0)
  assert.match(v.message, /6 test/)
  assert.match(v.message, /skipped 6/)
})

test('DEFECT 1: a skip is deterministic, so NOT_ALL_RAN is never retryable', () => {
  const v = evaluate({ summary: skewed({ pass: 966, skipped: 6 }), exitCode: 0, expected: EXPECTED })
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.equal(v.retryable, false, 'retrying a skip three times only wastes three runs')
})

test('DEFECT 1: todo tests are caught too (node does not count them as pass)', () => {
  const v = evaluate({ summary: skewed({ pass: 970, todo: 2 }), exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.match(v.message, /todo 2/)
})

test('DEFECT 1: cancelled tests are caught too', () => {
  const v = evaluate({ summary: skewed({ pass: 971, cancelled: 1 }), exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.match(v.message, /cancelled 1/)
})

test('DEFECT 1: a real failure still outranks NOT_ALL_RAN', () => {
  const v = evaluate({ summary: skewed({ pass: 965, fail: 1, skipped: 6 }), exitCode: 1, expected: EXPECTED })
  assert.equal(v.reason, 'TEST_FAILURES')
})

test('DEFECT 1: a deterministic skip outranks the retryable SHORT_RUN', () => {
  // Short AND skipped: report the cause that will not go away, and do not burn
  // three retries on it.
  const v = evaluate({ summary: skewed({ tests: 950, pass: 944, skipped: 6 }), exitCode: 0, expected: EXPECTED })
  assert.equal(v.reason, 'NOT_ALL_RAN')
  assert.equal(v.retryable, false)
})

test('DEFECT 1: an honest full run is still a pass (no false positive)', () => {
  const v = evaluate({ summary: parseSummary(SPEC_TAIL), exitCode: 0, expected: EXPECTED })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'OK')
})

/* ---------------------------------------------------------------------------
 * DEFECT 2 — `test:bless` seeded its running maximum from the baseline ON DISK,
 * so Math.max() could only ever go up. Deleting a test file made bless print
 * "BLESSED: <the old, higher number>" and exit 0 without writing anything,
 * leaving `npm test` permanently red with no documented way out.
 *
 * The fix is structural: the blessed value is computed from the attempt
 * summaries ALONE. computeBlessed() takes no baseline argument, so it cannot be
 * floored by one.
 * ------------------------------------------------------------------------- */

test('DEFECT 2: bless takes the max over ATTEMPTS, defeating truncation', () => {
  const blessed = computeBlessed([
    { tests: 1013, suites: 127 },
    { tests: 998, suites: 126 },
    { tests: 1013, suites: 127 }
  ])
  assert.deepEqual(blessed, { tests: 1013, suites: 127 })
})

test('DEFECT 2: bless can go DOWN — a genuine removal re-records the smaller count', () => {
  // Three clean attempts of a suite that really did lose 15 tests and 3 suites.
  // The old baseline (1013/127) must not floor the result.
  const blessed = computeBlessed([
    { tests: 998, suites: 124 },
    { tests: 998, suites: 124 },
    { tests: 998, suites: 124 }
  ])
  assert.deepEqual(blessed, { tests: 998, suites: 124 })
})

test('DEFECT 2: computeBlessed cannot be handed a baseline to be floored by', () => {
  // Arity is the guarantee: one argument, the attempt summaries. If someone
  // reintroduces a baseline parameter this fails and they re-read the comment.
  assert.equal(computeBlessed.length, 1)
})

test('DEFECT 2: blessing zero attempts is refused rather than writing garbage', () => {
  assert.throws(() => computeBlessed([]), /attempt/i)
})

/* ---------------------------------------------------------------------------
 * DEFECT 3 (minor) — the CI job's timeout-minutes must be able to contain the
 * gate's own worst case (TEST_GATE_TIMEOUT_MS x TEST_GATE_ATTEMPTS) plus the
 * dependency installation / lint steps. As shipped the watchdog was 10 min x 3 attempts = 30 min
 * inside a 10-minute job, so the job died first and the watchdog could never
 * act — the gate's "it can never hang" property did not hold in CI.
 * ------------------------------------------------------------------------- */

test('DEFECT 3: the CI job budget can contain the gate watchdog x attempts', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { parse } = require('yaml')
  const workflowDirectory = path.join(__dirname, '..', '.github', 'workflows')
  const ci = parse(fs.readFileSync(path.join(workflowDirectory, 'ci.yml'), 'utf8'))
  const verification = parse(fs.readFileSync(path.join(workflowDirectory, 'verify.yml'), 'utf8'))
  assert.equal(ci.jobs.verify.uses, './.github/workflows/verify.yml')
  const regressionJob = verification.jobs.regression
  const regressionStep = regressionJob.steps.find(step => step.run === 'bun run test')
  assert.ok(regressionStep, 'The reusable workflow must run the complete regression gate')

  const jobMinutes = regressionJob['timeout-minutes']
  assert.ok(Number.isInteger(jobMinutes), 'verify.yml regression job has no timeout-minutes')

  const gateMs = regressionStep.env.TEST_GATE_TIMEOUT_MS
  assert.ok(Number.isInteger(gateMs),
    'verify.yml must pin TEST_GATE_TIMEOUT_MS; the 10-minute default x 3 attempts outlives any sane job budget')

  const attempts = regressionStep.env.TEST_GATE_ATTEMPTS
  const worstCaseMs = gateMs * attempts
  assert.ok(worstCaseMs < jobMinutes * 60000,
    `gate worst case ${worstCaseMs}ms >= job budget ${jobMinutes * 60000}ms: ` +
    'the job dies before the watchdog can report, so a hung runner looks like a CI infra failure')
})

/* ---------------------------------------------------------------------------
 * DEFECT 4 — the escape hatch lied too. Every place that tells you to confirm
 * the real count (this tool's SHORT_RUN advice, the baseline's note, AGENTS.md,
 * CLAUDE.md) shipped a per-file sum whose grep had no `-a`. tool-prompt.test.js
 * emits bytes that make grep declare the stream binary and print
 * "Binary file (standard input) matches" INSTEAD of the summary line, so that
 * file's whole contribution disappears. Measured: the sum came back 892 instead
 * of 1025 — off by exactly the 133 tests in that one file, silently, from the
 * command whose entire job is to be the trustworthy second opinion.
 * ------------------------------------------------------------------------- */

test('DEFECT 4: the per-file sum the gate hands you keeps grep -a', () => {
  assert.match(PER_FILE_SUM, /grep\s+-[a-zA-Z]*a/,
    'without -a, grep suppresses tool-prompt.test.js\'s summary line and the sum ' +
    'silently loses 133 tests — the exact class of quiet under-count this gate exists to stop')
  assert.match(PER_FILE_SUM, /--test-force-exit/)
  assert.match(PER_FILE_SUM, /s\+=\$3/, 'it must still sum the third column')
})

/* ---------------------------------------------------- per-file sum (2026-09-11) -- */
// The gate no longer goes through node's parent runner (it dropped file tails
// under CI load: 1035 of 1074, fail 0, exit 0). One process per file, summed.

const fileSummary = (tests, suites, fail = 0) =>
  parseSummary(`ℹ tests ${tests}\nℹ suites ${suites}\nℹ pass ${tests - fail}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`)

test('sumSummaries adds one summary per file, key by key', () => {
  assert.deepEqual(sumSummaries([fileSummary(3, 1), fileSummary(5, 2, 1)]),
    { tests: 8, suites: 3, pass: 7, fail: 1, cancelled: 0, skipped: 0, todo: 0 })
})

test('sumSummaries: a file with no summary voids the attempt — it is never subtracted quietly', () => {
  assert.equal(sumSummaries([fileSummary(3, 1), null]), null)
  assert.equal(sumSummaries([]), null)
})

test('a dead file in a per-file attempt fails the gate as NO_SUMMARY, not as a shorter pass', () => {
  const summary = sumSummaries([fileSummary(3, 1), null])
  const v = evaluate({ summary, exitCode: 0, expected: { tests: 3, suites: 1 } })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'NO_SUMMARY')
  assert.equal(v.retryable, false)
})
