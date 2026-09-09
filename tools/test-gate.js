#!/usr/bin/env node
'use strict'

/**
 * Test-count gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * `node --test --test-force-exit` under-reports, silently.
 *
 * Node propagates `--test-force-exit` to the CHILD process it spawns per test
 * file (confirmed: it appears in the child's `process.execArgv`). When a child
 * finishes it calls `process.exit()`, which does NOT flush stdout that is still
 * buffered — and a child's stdout is a pipe to the runner, which is async on
 * POSIX. Whatever had not reached the pipe is discarded. The parent counts only
 * what it received, sees no failure, and exits 0.
 *
 * Reproduced with zero project code: two trivial test files (3000 tests + 3
 * tests), `--test-force-exit`, 5 runs -> one run reported 3000 instead of 3003,
 * `fail 0`, exit 0. The 3-test file vanished whole. Without `--test-force-exit`
 * the same pair reported 3003 every time.
 *
 * We cannot simply drop `--test-force-exit`: 26 of this repo's 43 test files
 * never exit without it (module-load `setInterval`s in `src/utils/account.js`,
 * reached through `src/utils/chat-helpers.js`, keep the loop alive), so the run
 * hangs forever instead of finishing short.
 *
 * So instead: run the suite, then check the reported counts against a committed
 * baseline. A run that comes back short is retried — the loss is a race, so a
 * genuinely deleted test is short on EVERY attempt while a truncated one is not
 * — and if it is still short, the gate exits non-zero and says so loudly.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TESTS_DIR = path.join(ROOT, 'tests')
const BASELINE_FILE = path.join(TESTS_DIR, 'expected-counts.json')

const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']

// Matches both reporters: spec ("ℹ tests 972") and tap ("# tests 972").
const summaryLine = (key) => new RegExp(`^(?:\\u2139|#)\\s+${key}\\s+(\\d+)\\s*$`)

/**
 * Pull the runner's summary block out of its output.
 * Takes the LAST occurrence of each key so a test *name* that looks like a
 * summary line, or a doubled summary, cannot move the number.
 * @returns {{tests:number,suites:number,pass:number,fail:number,cancelled:number,skipped:number,todo:number}|null}
 */
function parseSummary (output) {
  if (typeof output !== 'string' || output === '') return null
  const lines = output.split(/\r?\n/)
  const found = {}
  for (const key of SUMMARY_KEYS) {
    const re = summaryLine(key)
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = re.exec(lines[i])
      if (m) { found[key] = Number(m[1]); break }
    }
  }
  // `tests` and `fail` are the two the gate cannot work without.
  if (!Number.isInteger(found.tests) || !Number.isInteger(found.fail)) return null
  for (const key of SUMMARY_KEYS) if (!Number.isInteger(found[key])) found[key] = 0
  return found
}

const verdict = (ok, reason, code, retryable, message, summary) =>
  ({ ok, reason, code, retryable, message, summary: summary || null })

/**
 * Decide whether a completed run counts as a pass.
 * Order matters: a real failure must never be reported as a count problem.
 */
function evaluate ({ summary, exitCode, expected, timedOut = false }) {
  if (timedOut) {
    return verdict(false, 'TIMEOUT', 4, false,
      'the test runner did not finish inside the watchdog window and was killed; no result was produced', summary)
  }
  if (!summary) {
    return verdict(false, 'NO_SUMMARY', 3, false,
      'the test runner produced no summary block at all — it crashed, hung, or its output was lost entirely', null)
  }
  if (summary.fail > 0) {
    return verdict(false, 'TEST_FAILURES', 1, false,
      `${summary.fail} test(s) failed`, summary)
  }
  if (exitCode !== 0) {
    return verdict(false, 'RUNNER_EXIT', 2, false,
      `the test runner exited ${exitCode} despite reporting fail 0`, summary)
  }
  if (summary.tests < expected.tests) {
    return verdict(false, 'SHORT_RUN', 5, true,
      `only ${summary.tests} of ${expected.tests} expected tests were reported — ` +
      `${expected.tests - summary.tests} went missing. Every test that DID run passed, ` +
      'which is exactly what a truncated run looks like. This is not a pass.', summary)
  }
  if (summary.suites < expected.suites) {
    return verdict(false, 'SHORT_SUITES', 5, true,
      `only ${summary.suites} of ${expected.suites} expected suites were reported`, summary)
  }
  if (summary.tests > expected.tests || summary.suites > expected.suites) {
    return verdict(false, 'BASELINE_STALE', 6, false,
      `the run reported ${summary.tests} tests / ${summary.suites} suites but the baseline says ` +
      `${expected.tests} / ${expected.suites}. If you added tests, re-bless the baseline: npm run test:bless`, summary)
  }
  return verdict(true, 'OK', 0, false,
    `${summary.tests} tests / ${summary.suites} suites / 0 fail`, summary)
}

const BAR = '='.repeat(72)

function formatVerdict (v) {
  if (v.ok) return `${BAR}\nTEST GATE: PASS — ${v.message}\n${BAR}`
  return `${BAR}\nTEST GATE: FAIL [${v.reason}]\n${v.message}\n${BAR}`
}

/* ------------------------------------------------------------------ CLI -- */

function listTestFiles () {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('tests', f))
}

function readBaseline () {
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
    if (Number.isInteger(raw.tests) && Number.isInteger(raw.suites)) return raw
  } catch { /* fall through */ }
  return null
}

function runOnce (files, watchdogMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      ['--test', '--test-force-exit', ...files],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

    let output = ''
    let timedOut = false
    const capture = (chunk) => { output += chunk; process.stdout.write(chunk) }
    child.stdout.setEncoding('utf8'); child.stdout.on('data', capture)
    child.stderr.setEncoding('utf8'); child.stderr.on('data', capture)

    // Nothing here may hang: if the runner stops making progress we kill it and
    // report a TIMEOUT, which is a failure, never a pass.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, watchdogMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ output, exitCode: timedOut ? null : code, timedOut })
    })
  })
}

async function main () {
  const argv = process.argv.slice(2)
  const bless = argv.includes('--bless')
  const filters = argv.filter((a) => !a.startsWith('--'))
  const attemptsAllowed = Number(process.env.TEST_GATE_ATTEMPTS || 3)
  const watchdogMs = Number(process.env.TEST_GATE_TIMEOUT_MS || 600000)

  // `npm test -- tests/foo.test.js` used to be a lie: the package script's glob
  // won and the whole suite ran anyway. Here the filter is honoured, and the
  // count gate is skipped because a partial run cannot meet a whole-suite count.
  if (filters.length > 0) {
    const { output, exitCode, timedOut } = await runOnce(filters, watchdogMs)
    const summary = parseSummary(output)
    if (timedOut) { console.error(formatVerdict(evaluate({ summary, exitCode, expected: { tests: 0, suites: 0 }, timedOut }))); process.exit(4) }
    console.error(`${BAR}\nTEST GATE: SKIPPED — filtered run of ${filters.length} file(s); ` +
      'the whole-suite count gate does not apply. Run `npm test` with no arguments before claiming a green suite.\n' +
      `reported: ${summary ? `${summary.tests} tests / ${summary.fail} fail` : 'no summary'}\n${BAR}`)
    process.exit(summary && summary.fail === 0 && exitCode === 0 ? 0 : 1)
  }

  const files = listTestFiles()
  let expected = readBaseline()

  if (!expected && !bless) {
    console.error(`${BAR}\nTEST GATE: FAIL [NO_BASELINE]\n` +
      `${BASELINE_FILE} is missing or malformed. Create it with: npm run test:bless\n${BAR}`)
    process.exit(7)
  }
  if (bless && !expected) expected = { tests: -1, suites: -1 }

  let last = null
  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    const { output, exitCode, timedOut } = await runOnce(files, watchdogMs)
    const summary = parseSummary(output)
    last = evaluate({ summary, exitCode, expected, timedOut })

    if (bless) {
      if (!summary || summary.fail > 0 || exitCode !== 0) {
        console.error(`${BAR}\nREFUSING TO BLESS: the run was not clean.\n${BAR}`)
        process.exit(1)
      }
      // Bless the highest counts seen, never a truncated one.
      if (attempt < attemptsAllowed) {
        expected = { tests: Math.max(expected.tests, summary.tests), suites: Math.max(expected.suites, summary.suites) }
        console.error(`[bless] attempt ${attempt}/${attemptsAllowed}: ${summary.tests} tests / ${summary.suites} suites (running again to defeat truncation)`)
        continue
      }
      expected = { tests: Math.max(expected.tests, summary.tests), suites: Math.max(expected.suites, summary.suites) }
      fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({
        tests: expected.tests,
        suites: expected.suites,
        note: 'Authoritative count. Verify with: for f in tests/*.test.js; do node --test --test-force-exit "$f"; done | grep "tests " | awk \'{s+=$3}END{print s}\'',
        updated: new Date().toISOString().slice(0, 10)
      }, null, 2)}\n`)
      console.error(`${BAR}\nBLESSED: ${expected.tests} tests / ${expected.suites} suites -> ${path.relative(ROOT, BASELINE_FILE)}\n${BAR}`)
      process.exit(0)
    }

    if (last.ok) {
      if (attempt > 1) {
        console.error(`${BAR}\nNOTE: attempt(s) 1..${attempt - 1} came back SHORT and were retried.\n` +
          'That is node dropping a child\'s buffered stdout on --test-force-exit, not a broken test.\n' +
          `This attempt reported the full ${expected.tests}.\n${BAR}`)
      }
      console.error(formatVerdict(last))
      process.exit(0)
    }

    if (!last.retryable) break

    if (attempt < attemptsAllowed) {
      console.error(`${BAR}\nSHORT RUN on attempt ${attempt}/${attemptsAllowed}: ${last.message}\nRetrying.\n${BAR}`)
    }
  }

  console.error(formatVerdict(last))
  if (last.reason === 'SHORT_RUN' || last.reason === 'SHORT_SUITES') {
    console.error(`Short on all ${attemptsAllowed} attempts. A truncation flake does not survive that many\n` +
      'retries, so treat this as real: a test file threw at load, was deleted, or stopped registering tests.\n' +
      'Confirm with the per-file sum, which does not go through the parent runner:\n' +
      '  for f in tests/*.test.js; do node --test --test-force-exit "$f"; done | grep -E "^. tests [0-9]" | awk \'{s+=$3}END{print s}\'')
  }
  process.exit(last.code)
}

module.exports = { parseSummary, evaluate, formatVerdict }

if (require.main === module) {
  main().catch((err) => {
    console.error(`${BAR}\nTEST GATE: FAIL [CRASH]\n${err && err.stack ? err.stack : err}\n${BAR}`)
    process.exit(8)
  })
}
