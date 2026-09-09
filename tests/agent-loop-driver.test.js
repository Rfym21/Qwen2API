'use strict'

// The A/B driver is the instrument the duplicate-rate claim rests on. An
// instrument with no tests is an assertion, not a measurement.
//
// Every case below pins a defect a design review actually found in it, or a
// property the experiment's validity depends on. The pattern to keep in mind:
// a harness that hands the model a FALSE result and then counts the model's
// reaction as a duplicate is measuring itself. The first version did exactly
// that on the single most natural call for its own task.

const test = require('node:test')
const assert = require('node:assert/strict')

const D = require('../tools/dev-probes/agent-loop-driver.js')
// agent-turn.js is a leaf of the dependency graph (its only require is the
// logger), so pulling it in here does not boot the account manager.
const { canonicalJson } = require('../src/utils/agent-turn.js')

const BIG = 'src/core/pipeline.js'
const lines = (s) => String(s).split('\n')

// --- path confinement -----------------------------------------------------

test('the simulator only ever resolves paths inside its own map', () => {
  // It reads from a Map, never from disk, so a traversal cannot reach a real
  // file — but it must also fail CLOSED rather than resolving to something.
  for (const p of ['../../etc/passwd', '/etc/passwd', 'src/../../../etc/passwd',
    '../../../../../../etc/shadow', '/srv/acme-svc/../../etc/passwd', '~/.ssh/id_rsa']) {
    const r = D.execute('Read', { file_path: p })
    assert.equal(r.err, true, `${p} must be an error`)
    assert.match(r.body, /File does not exist/, `${p} must not resolve`)
    assert.equal(r.empty, false, `${p} must not look like an empty result`)
  }
})

test('a traversal attempt is never silently reported as empty', () => {
  // An empty result is the one shape the harness must never manufacture: the
  // model cannot distinguish it from the truth, and the retry it provokes is
  // then counted as a duplicate the proxy failed to prevent.
  const r = D.runBash({ command: 'cat ../../etc/passwd' })
  assert.equal(r.empty, false)
  assert.equal(r.err, true)
  assert.equal(r.body.includes(D.EMPTY_BASH), false)
})

test('norm strips the repo root, ./ prefixes and welded shell punctuation', () => {
  for (const v of ['/srv/acme-svc/src/core/pipeline.js', 'src/core/pipeline.js',
    './src/core/pipeline.js', 'src/core/pipeline.js;', "'src/core/pipeline.js'",
    '/src/core/pipeline.js']) {
    assert.equal(D.norm(v), BIG, `norm(${v})`)
  }
})

test('the same file is reachable by absolute, relative and ./-prefixed path', () => {
  // A real agent writes all three, often in the same session. If they diverge
  // the harness invents empty results that have nothing to do with the proxy.
  const bodies = ['/srv/acme-svc/' + BIG, BIG, './' + BIG]
    .map((p) => D.execute('Read', { file_path: p }).body)
  assert.equal(bodies[0], bodies[1])
  assert.equal(bodies[1], bodies[2])
  assert.equal(bodies[0].includes('use strict'), true)
})

// --- globs ----------------------------------------------------------------

test('** spans directories and * does not', () => {
  // The original built its scope by DELETING every '*', so 'src/**/*.js' became
  // the literal prefix 'src///.js' and matched nothing at all.
  assert.equal(D.globMatches('src/**/*.js', 'src/auth/session.js'), true)
  assert.equal(D.globMatches('**/*.js', 'src/auth/session.js'), true)
  assert.equal(D.globMatches('src/*.js', 'src/auth/session.js'), false, '* must not cross a /')
  assert.equal(D.globMatches('src/core/*.js', BIG), true)
  assert.equal(D.globMatches('**/*.md', 'README.md'), true)
  assert.equal(D.globMatches('**/*.md', 'src/auth/session.js'), false)
})

test('a glob with no slash filters on the basename, ripgrep-style', () => {
  assert.equal(D.globMatches('*.js', 'src/auth/session.js'), true)
  assert.equal(D.globMatches('*.js', 'README.md'), false)
  assert.equal(D.globMatches('session.js', 'src/auth/session.js'), true)
})

test('the glob is anchored and regex metacharacters in it are literal', () => {
  assert.equal(D.globMatches('src/auth/session.js', 'xsrc/auth/session.jsx'), false)
  assert.equal(D.globToRegExp('a.b').test('axb'), false, '. must not be a wildcard')
  assert.equal(D.globToRegExp('a.b').test('a.b'), true)
  assert.equal(D.globToRegExp('a+b').test('a+b'), true)
})

test('Glob returns every .js file under src and nothing else', () => {
  const r = D.execute('Glob', { pattern: 'src/**/*.js' })
  assert.equal(r.empty, false)
  const hit = lines(r.body)
  assert.equal(hit.length, D.ALL_MODULES.length)
  assert.equal(hit.every((p) => p.startsWith('src/') && p.endsWith('.js')), true)
})

test('a glob that genuinely matches nothing still says so', () => {
  // The literal fallback must not turn the tool into one that always matches:
  // a real empty has to stay reportable or "no matches" loses its meaning.
  const r = D.execute('Glob', { pattern: 'src/**/*.rs' })
  assert.equal(r.empty, true)
  assert.equal(r.body, D.NO_MATCH)
})

// --- grep -----------------------------------------------------------------

test('an invalid regex falls back to a literal search instead of NO MATCH', () => {
  // The task's own target string, `legacyFormat(`, is an invalid JS regex, and
  // `grep` without -E matches it literally. Returning "No matches found" told
  // the model its target did not exist anywhere.
  const r = D.execute('Grep', { pattern: 'legacyFormat(', path: 'src' })
  assert.equal(r.empty, false)
  assert.equal(r.body.includes('legacyFormat('), true)
})

test('scoping by glob and scoping by path find the same hits', () => {
  const byGlob = D.execute('Grep', { pattern: 'legacyFormat\\(', glob: 'src/**/*.js' })
  const byPath = D.execute('Grep', { pattern: 'legacyFormat\\(', path: 'src' })
  const unscoped = D.execute('Grep', { pattern: 'legacyFormat\\(' })
  assert.equal(byGlob.empty, false)
  assert.equal(byGlob.body, byPath.body)
  assert.equal(byPath.body, unscoped.body)
})

test('every file the fixture seeded with legacyFormat( is findable', () => {
  const r = D.execute('Grep', { pattern: 'legacyFormat\\(', path: 'src', output_mode: 'files_with_matches' })
  assert.equal(r.empty, false)
  assert.deepEqual(lines(r.body).sort(), D.HITS.slice().sort())
  assert.ok(D.HITS.length >= 20, `expected the fixture to seed many call sites, got ${D.HITS.length}`)
})

test('a pattern that is genuinely absent reports no matches', () => {
  const r = D.execute('Grep', { pattern: 'zzzNotInTheRepoZzz', path: 'src' })
  assert.equal(r.empty, true)
  assert.equal(r.body, D.NO_MATCH)
})

test('Bash grep understands clustered flags, quoting and a leading cd', () => {
  // -rln must set files-only. A regex anchored on the cluster's LAST character
  // honoured -rl and silently ignored -rln, so the model got line output where
  // it asked for a file list.
  for (const cmd of ["grep -rln 'legacyFormat(' src", 'grep -rl "legacyFormat(" src',
    'cd /srv/acme-svc && grep -rln legacyFormat src']) {
    const r = D.runBash({ command: cmd })
    assert.equal(r.empty, false, cmd)
    assert.equal(lines(r.body).every((l) => !/:\d+:/.test(l)), true, `${cmd} must list files, not lines`)
  }
})

test('the Bash grep shapes an agent actually writes all return hits', () => {
  for (const cmd of ["grep -rn 'legacyFormat(' src/", 'grep -rnF "legacyFormat(" src',
    "rg -n 'legacyFormat\\(' src/**/*.js", "grep -rn --include='*.js' 'require(' src",
    "grep -rn 'legacyFormat(' ."]) {
    const r = D.runBash({ command: cmd })
    assert.equal(r.empty, false, `${cmd} returned an empty result`)
    assert.equal(r.err, false, `${cmd} returned an error`)
  }
})

test('grep -i is case-insensitive and plain grep is not', () => {
  assert.equal(D.runBash({ command: 'grep -rn LEGACYFORMAT src' }).empty, true)
  assert.equal(D.runBash({ command: 'grep -rni LEGACYFORMAT src' }).empty, false)
})

// --- Read -----------------------------------------------------------------

test('Read honours the requested limit and marks the truncation', () => {
  // The old cap was a silent 200: a model that asked for 500 got 200 and
  // believed it had read to line 500.
  const r = D.readFile({ file_path: BIG, limit: 500 })
  assert.equal(lines(r.body).filter((l) => /^\s*\d+\t/.test(l)).length, 500)
  assert.match(r.body, /truncated: showing lines 1-500 of \d+/)
  assert.match(r.body, /continue with offset 501/)
})

test('Read offset is a 1-based line number', () => {
  const all = D.REPO.get(BIG).split('\n')
  const r = D.readFile({ file_path: BIG, offset: 201, limit: 3 })
  assert.equal(lines(r.body)[0].split('\t')[1], all[200])
  assert.match(lines(r.body)[0], /^\s*201\t/)
})

test('a complete Read carries no truncation marker', () => {
  const r = D.readFile({ file_path: 'README.md' })
  assert.equal(/truncated/.test(r.body), false)
  assert.equal(lines(r.body).length, D.lineCount('README.md'))
})

test('Read past EOF returns a Read-shaped notice, not the Bash empty string', () => {
  const r = D.readFile({ file_path: BIG, offset: 99999 })
  assert.equal(r.empty, false, 'past EOF is information, not silence')
  assert.equal(r.body.includes(D.EMPTY_BASH), false)
  assert.match(r.body, /has \d+ lines/)
})

// --- Bash paging ----------------------------------------------------------

test('wc -l counts the lines of the named file, not the files in the repo', () => {
  // It returned ALL_PATHS.length for every input: 23 for a 1278-line file. The
  // model asks how long the file is, is told 23, and concludes it is covered.
  const r = D.runBash({ command: `wc -l ${BIG}` })
  assert.equal(Number(r.body.trim().split(/\s+/)[0]), D.lineCount(BIG))
  assert.notEqual(Number(r.body.trim().split(/\s+/)[0]), D.ALL_PATHS.length)
})

test('wc -l over several files reports each and a total', () => {
  const r = D.runBash({ command: 'wc -l src/core/pipeline.js src/core/registry.js' })
  assert.equal(lines(r.body).length, 3)
  assert.match(lines(r.body)[2], /total$/)
})

test('cat returns the whole file, not its first 60 lines', () => {
  const r = D.runBash({ command: `cat ${BIG}` })
  assert.equal(lines(r.body).length, D.lineCount(BIG))
  assert.ok(D.lineCount(BIG) > 1000, 'the fixture file must be long enough for this to matter')
})

test('head honours -n and tail reads the END of the file', () => {
  const all = D.REPO.get(BIG).split('\n')
  assert.equal(lines(D.runBash({ command: `head -n 5 ${BIG}` }).body).length, 5)
  assert.equal(lines(D.runBash({ command: `head -5 ${BIG}` }).body).length, 5)
  const t = lines(D.runBash({ command: `tail -n 3 ${BIG}` }).body)
  assert.equal(t.length, 3)
  assert.equal(t[2], all[all.length - 1], 'tail must read the end, not the start')
})

test('a requested sub-range is not stamped as truncated', () => {
  // `head -n 5` returning 5 of 1278 lines is the correct answer; calling it
  // truncated is a second way of lying about the file's shape.
  assert.equal(/truncated/.test(D.runBash({ command: `head -n 5 ${BIG}` }).body), false)
  assert.equal(/truncated/.test(D.runBash({ command: `sed -n '10,20p' ${BIG}` }).body), false)
})

test('sed -n and awk NR page the file instead of returning silence', () => {
  const all = D.REPO.get(BIG).split('\n')
  const sed = D.runBash({ command: `sed -n '200,400p' ${BIG}` })
  assert.equal(sed.empty, false)
  assert.equal(lines(sed.body).length, 201)
  assert.equal(lines(sed.body)[0], all[199])
  const awk = D.runBash({ command: `awk 'NR==5' ${BIG}` })
  assert.equal(awk.empty, false)
  assert.equal(awk.body, all[4])
  const range = D.runBash({ command: `awk 'NR>=10 && NR<=12' ${BIG}` })
  assert.equal(lines(range.body).length, 3)
})

test('an unrecognised Bash command errors rather than returning silence', () => {
  // Silence the model cannot distinguish from truth is the most dangerous thing
  // this harness can emit; an error it can react to.
  for (const cmd of ['node -e "1"', 'python3 script.py', 'git log --oneline', 'npm test']) {
    const r = D.runBash({ command: cmd })
    assert.equal(r.err, true, cmd)
    assert.equal(r.empty, false, cmd)
    assert.equal(r.body.includes(D.EMPTY_BASH), false, cmd)
  }
})

test('ls resolves a directory by absolute or relative path', () => {
  const a = D.runBash({ command: 'ls src/core' })
  const b = D.runBash({ command: 'ls /srv/acme-svc/src/core' })
  assert.equal(a.body, b.body)
  assert.deepEqual(lines(a.body), ['normalise.js', 'pipeline.js', 'registry.js'])
})

// --- task-progress provenance ---------------------------------------------

test('only results that surfaced CONTENT count as task progress', () => {
  // distinctTargetsCovered is the variable the two arms are matched on, because
  // post-fix injects ~6 KB more and does not reach a given turn with the same
  // work done. Counting any path that merely APPEARS in a result body let one
  // `Glob src/**/*.js` jump progress to 21/23 with nothing actually read.
  assert.deepEqual(D.execute('Glob', { pattern: 'src/**/*.js' }).paths, [], 'a file listing is not progress')
  assert.deepEqual(D.runBash({ command: 'ls src/core' }).paths, [])
  assert.deepEqual(D.runBash({ command: "find src -name '*.js'" }).paths, [])
  assert.deepEqual(D.execute('Grep', { pattern: 'legacyFormat\\(', path: 'src', output_mode: 'files_with_matches' }).paths, [],
    'grep -l names files without showing their contents')

  assert.deepEqual(D.execute('Read', { file_path: BIG }).paths, [BIG])
  assert.deepEqual(D.runBash({ command: `sed -n '1,5p' ${BIG}` }).paths, [BIG])
  assert.deepEqual(D.runBash({ command: `cat ${BIG}` }).paths, [BIG])
  const hits = D.execute('Grep', { pattern: 'legacyFormat\\(', path: 'src' })
  assert.deepEqual(hits.paths.slice().sort(), D.HITS.slice().sort(), 'shown match lines ARE content')
})

test('a result that surfaced nothing claims no progress', () => {
  for (const r of [D.execute('Read', { file_path: 'nope.js' }),
    D.readFile({ file_path: BIG, offset: 99999 }),
    D.execute('Grep', { pattern: 'zzzNotInTheRepoZzz', path: 'src' }),
    D.runBash({ command: 'node -e "1"' }),
    D.runBash({ command: 'pwd' })]) {
    assert.deepEqual(r.paths, [], JSON.stringify(String(r.body).slice(0, 60)))
  }
})

test('a pipeline carries the provenance of the stage that read the file', () => {
  assert.deepEqual(D.runBash({ command: `cat ${BIG} | head -n 4` }).paths, [BIG])
  // `wc -l` emits a count, not content, so it surfaces nothing of its own.
  assert.deepEqual(D.runBash({ command: `cat ${BIG} | wc -l` }).paths, [])
})

// --- the duplicate key ----------------------------------------------------

test('the duplicate key is invariant to argument key order', () => {
  assert.equal(
    D.sigOf({ name: 'Read', args: { limit: 5, file_path: 'a.js' } }),
    D.sigOf({ name: 'Read', args: { file_path: 'a.js', limit: 5 } })
  )
})

test('the duplicate key names the same equivalence class as the proxy ledger', () => {
  // The proxy dedupes on `${name}` + canonicalJson(args) (src/utils/agent-turn.js).
  // If the driver keys on anything else it counts repeats the fix was never
  // trying to collapse, and the measurement answers a different question.
  for (const args of [{ b: 2, a: 1 }, { a: [3, { z: 1, y: 2 }] }, {}, { p: 'x/y.js' }, { n: null }]) {
    assert.equal(D.sigOf({ name: 'Read', args }), `Read ${canonicalJson(args)}`)
  }
})

test('different arguments are different calls', () => {
  assert.notEqual(
    D.sigOf({ name: 'Read', args: { file_path: 'a.js' } }),
    D.sigOf({ name: 'Read', args: { file_path: 'b.js' } })
  )
  assert.notEqual(
    D.sigOf({ name: 'Read', args: { file_path: 'a.js' } }),
    D.sigOf({ name: 'Grep', args: { file_path: 'a.js' } })
  )
})

test('two DIFFERENT malformed calls do not collide', () => {
  // On the OpenAI path unparseable arguments used to become {}, so every broken
  // call keyed on `Name|{}`. Malformed arguments are a reported symptom and the
  // fixes touch argument handling — that alone could manufacture an arm
  // difference out of nothing.
  const a = { name: 'Bash', args: null, raw: '{"command":"ls src' }
  const b = { name: 'Bash', args: null, raw: '{"command":"grep -rn foo' }
  assert.notEqual(D.sigOf(a), D.sigOf(b))
  assert.equal(D.sigOf(a).includes('ls src'), true)
})

test('two IDENTICAL malformed calls still collide', () => {
  const raw = '{"command":"ls src'
  assert.equal(D.sigOf({ name: 'Bash', args: null, raw }), D.sigOf({ name: 'Bash', args: null, raw }))
})

test('string arguments are collapsed to one line, matching the ledger', () => {
  assert.equal(D.sigOf({ name: 'Bash', args: 'echo  hi' }), 'Bash echo hi')
  assert.equal(D.sigOf({ name: 'Bash', args: 'echo\nhi' }), 'Bash echo hi')
})

// --- the duplicate metric -------------------------------------------------

const mkState = () => ({ seen: new Map(), distinctCalls: 0 })
const ctxAt = (turn, extra = {}) => ({
  turn, bytes: 1000, above: false, finish: 'tool_use',
  covered: 0, prevEmptyAny: false, prevEmptyAll: false, prevResultCount: 0, ...extra
})
const rd = (p) => ({ name: 'Read', args: { file_path: p } })

function classifyOne (state, turn, calls, extra) {
  return D.classifyTurn(calls, state, ctxAt(turn, extra))
}

test('a repeat on a LATER turn is a cross-turn duplicate', () => {
  const st = mkState()
  classifyOne(st, 1, [rd('a.js')])
  const recs = classifyOne(st, 2, [rd('a.js')])
  assert.equal(recs[0].dup, true)
  assert.equal(recs[0].dupOfTurn, 1)
  assert.equal(recs[0].gapTurns, 1)
})

test('a repeat inside ONE assistant message is not counted as a duplicate', () => {
  // The corpus definition is cross-turn, and in-message repeats were measured at
  // exactly 0 — the per-attempt ledger already suppresses them. Writing `seen`
  // mid-loop scored the second call as a duplicate of its own turn and inflated
  // dupRate with something the metric was never supposed to contain.
  const st = mkState()
  const recs = classifyOne(st, 1, [rd('a.js'), rd('a.js')])
  assert.equal(recs[0].dup, false)
  assert.equal(recs[1].dup, false, 'a same-message repeat is NOT a cross-turn duplicate')
  assert.equal(recs[1].inMessageDup, true, 'but it must still be recorded')
  assert.equal(recs[0].inMessageDup, false)
})

test('an in-message repeat is admitted once, so it cannot double-count later', () => {
  const st = mkState()
  classifyOne(st, 1, [rd('a.js'), rd('a.js')])
  assert.equal(st.distinctCalls, 1)
  const recs = classifyOne(st, 2, [rd('a.js')])
  assert.equal(recs[0].dup, true)
  assert.equal(recs[0].dupOfTurn, 1)
})

test('gapDistinct is the ledger depth, so gapDistinct <= N means "still listed"', () => {
  // Whether a duplicate COULD have been suppressed depends on how many distinct
  // calls stand between it and the original, not on how many turns do. The value
  // is the original's 1-based depth in a newest-first list, which is what makes
  // the summary's `gapDistinct <= LEDGER_WINDOW` the right in-window test.
  const st = mkState()
  classifyOne(st, 1, [rd('a.js')])
  for (let i = 0; i < 5; i++) classifyOne(st, 2 + i, [rd(`f${i}.js`)])
  const recs = classifyOne(st, 9, [rd('a.js')])
  assert.equal(recs[0].dup, true)
  assert.equal(recs[0].gapTurns, 8)
  // a.js plus the 5 that followed it: a ledger of 6 still lists it, one of 5 does not.
  assert.equal(recs[0].gapDistinct, 6)
  assert.equal(st.distinctCalls, 6)

  // The immediate case pins the base: one distinct call in between means depth 1.
  const st2 = mkState()
  classifyOne(st2, 1, [rd('x.js')])
  const again = classifyOne(st2, 2, [rd('x.js')])
  assert.equal(again[0].gapDistinct, 1, 'the newest entry is at depth 1')
})

test('a quoted operator does not split the command', () => {
  // Splitting the stage naively on | and && shredded `awk 'NR>=10 && NR<=12' f`
  // and `grep -rn 'a|b' src`, and the fragment matched no command — so two
  // ordinary calls came back as errors.
  const range = D.runBash({ command: `awk 'NR>=10 && NR<=12' ${BIG}` })
  assert.equal(range.err, false)
  assert.equal(lines(range.body).length, 3)
  const alt = D.runBash({ command: "grep -rn 'legacyFormat|require' src" })
  assert.equal(alt.err, false)
  assert.equal(alt.empty, false)
})

test('a pipeline is evaluated left to right, not guessed at from its last stage', () => {
  // Reading only the last stage and hunting the whole line for a filename would
  // answer `grep pat X | wc -l` with X's LINE COUNT instead of the number of
  // matches — full, confident and wrong, which is worse than an error because
  // the model acts on it and never learns otherwise.
  const piped = D.runBash({ command: `cat ${BIG} | head -n 4` })
  assert.equal(lines(piped.body).length, 4)

  const direct = D.runBash({ command: "grep -rn 'legacyFormat(' src" })
  const counted = D.runBash({ command: "grep -rn 'legacyFormat(' src | wc -l" })
  assert.equal(Number(counted.body.trim()), lines(direct.body).length)
  assert.notEqual(Number(counted.body.trim()), D.lineCount(BIG))

  const firstThree = D.runBash({ command: "grep -rl 'legacyFormat(' src | head -3" })
  assert.equal(lines(firstThree.body).length, 3)

  const filtered = D.runBash({ command: "grep -rl 'legacyFormat(' src | grep core" })
  assert.equal(lines(filtered.body).every((l) => l.includes('core')), true)
})

test('an unsupported pipeline filter errors instead of returning silence', () => {
  const r = D.runBash({ command: `cat ${BIG} | jq .` })
  assert.equal(r.err, true)
  assert.equal(r.body.includes(D.EMPTY_BASH), false)
})

test('a first-time call carries no gap and no dupOfTurn', () => {
  const recs = classifyOne(mkState(), 1, [rd('a.js')])
  assert.equal(recs[0].dup, false)
  assert.equal(recs[0].dupOfTurn, null)
  assert.equal(recs[0].gapTurns, null)
  assert.equal(recs[0].gapDistinct, null)
})

test('every record carries the confound controls the analysis needs', () => {
  const recs = classifyOne(mkState(), 4, [rd('a.js')], { above: true, bytes: 123456, covered: 9, finish: 'max_tokens' })
  const r = recs[0]
  // `above` is the primary metric's stratum, `distinctTargetsCovered` the
  // progress-matching variable, `finish` the truncation control.
  for (const k of ['above', 'bytes', 'distinctTargetsCovered', 'finish', 'prevEmptyAny', 'sig', 'name', 'turn']) {
    assert.ok(k in r, `record is missing ${k}`)
  }
  assert.equal(r.above, true)
  assert.equal(r.distinctTargetsCovered, 9)
  assert.equal(r.finish, 'max_tokens')
})

// --- the self-test itself -------------------------------------------------

test('the self-test is non-vacuous and passes', () => {
  // The 15 wasted requests behind the first null happened because nothing
  // asserted the simulator could answer the calls its own task invites.
  assert.ok(D.SELF_TEST_CASES.length >= 20, 'too few cases to be a real guard')
  for (const [name, args] of D.SELF_TEST_CASES) {
    const r = D.execute(name, args)
    assert.equal(r.empty, false, `${name} ${JSON.stringify(args)} returned an empty result`)
    assert.equal(r.err, false, `${name} ${JSON.stringify(args)} returned an error`)
  }
  assert.deepEqual(D.selfTestFacts(), [], 'the simulator returned a full but WRONG answer')
})

// --- the fixture and the tasks --------------------------------------------

test('the import graph is acyclic, so the trace task terminates', () => {
  // The first version drew edges uniformly and produced 99 cycles reachable from
  // core/pipeline. "Follow every require edge to its leaf" is then unanswerable,
  // and the model would loop forever while the harness scored every lap as
  // duplicate calls the fix had failed to prevent.
  const seen = new Map()
  const visit = (n, trail) => {
    assert.equal(trail.includes(n), false, `cycle: ${trail.join(' -> ')} -> ${n}`)
    if (seen.has(n)) return seen.get(n)
    const kids = D.IMPORTS.get(n) || []
    let paths = kids.length ? 0 : 1
    for (const c of kids) paths += visit(c, [...trail, n])
    seen.set(n, paths)
    return paths
  }
  const paths = visit('core/pipeline', [])
  assert.ok(paths > 1 && paths < 200, `expected an enumerable number of root-to-leaf paths, got ${paths}`)
})

test('the graph has exactly one leaf and every module is in it', () => {
  const leaves = [...D.IMPORTS].filter(([, v]) => v.length === 0).map(([k]) => k)
  assert.deepEqual(leaves, ['core/normalise'])
  assert.equal(D.IMPORTS.size, D.ALL_MODULES.length)
})

test('the fixture actually violates the invariants the audit task asks about', () => {
  // An audit whose answer is "no violations anywhere" is closed out with one
  // grep and never enters the revisiting regime.
  const js = D.ALL_PATHS.filter((p) => p.endsWith('.js'))
  const noStrict = js.filter((p) => !D.REPO.get(p).startsWith("'use strict'"))
  const bareStore = js.filter((p) => /^\s*const \w+ = store\./m.test(D.REPO.get(p)))
  const badThrow = js.filter((p) => /throw new Error\('missing /.test(D.REPO.get(p)))
  const tooLong = js.filter((p) => D.lineCount(p) > 1000)
  for (const [label, set] of [['use strict', noStrict], ['bare store.', bareStore],
    ['unprefixed throw', badThrow], ['over 1000 lines', tooLong]]) {
    assert.ok(set.length > 0, `no ${label} violations seeded`)
    assert.ok(set.length < js.length, `${label} violated by every file is not a discriminating invariant`)
  }
})

test('every task id builds, names its own targets and asks for revisiting', () => {
  for (let id = 1; id <= 5; id++) {
    const t = D.buildTask(id, 1)
    assert.equal(t.id, id)
    assert.ok(t.name && t.text.length > 200, `task ${id} is too thin`)
    assert.ok(Array.isArray(t.targets) && t.targets.length > 0, `task ${id} has no targets`)
    assert.match(t.text, /TASK:/)
  }
})

test('a task instance is stable for a seed and differs between seeds', () => {
  assert.equal(D.buildTask(1, 5).text, D.buildTask(1, 5).text)
  assert.notEqual(D.buildTask(1, 5).text, D.buildTask(1, 6).text)
  assert.notEqual(D.buildTask(3, 5).text, D.buildTask(3, 6).text)
})

test('the seed does NOT reach the fixture', () => {
  // The environment must be byte-identical across arms and seeds. If --seed
  // changed the repo it would become a second uncontrolled variable and destroy
  // the paired design.
  const before = [...D.REPO.values()].reduce((a, b) => a + b.length, 0)
  D.buildTask(2, 12345)
  D.buildTask(4, 999)
  assert.equal([...D.REPO.values()].reduce((a, b) => a + b.length, 0), before)
})

test('the fixture is large enough to reach the externalisation regime', () => {
  // Every duplicate in the worst real session sat above the 92,160 B threshold.
  // A fixture that cannot push the conversation past it measures the wrong band.
  const total = [...D.REPO.values()].reduce((a, b) => a + b.length, 0)
  assert.ok(total > 300000, `fixture is only ${total} B; the regime starts at 92,160 B of REQUEST`)
  assert.ok(D.lineCount('src/core/pipeline.js') > 1000)
})

// --- adapters -------------------------------------------------------------

test('the Anthropic adapter parses tool_use blocks and keeps the raw arguments', () => {
  const p = D.anthropic.parse({
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.js' } }],
    stop_reason: 'tool_use'
  })
  assert.equal(p.text, 'hi')
  assert.equal(p.calls.length, 1)
  assert.equal(p.calls[0].name, 'Read')
  assert.equal(D.sigOf(p.calls[0]), 'Read {"file_path":"a.js"}')
  assert.equal(p.finish, 'tool_use')
})

test('the OpenAI adapter leaves unparseable arguments as null, not {}', () => {
  const p = D.openai.parse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":"ls' } }] }, finish_reason: 'tool_calls' }]
  })
  assert.equal(p.calls[0].args, null)
  assert.equal(p.calls[0].raw, '{"command":"ls')
  assert.equal(D.sigOf(p.calls[0]).includes('ls'), true)
})
