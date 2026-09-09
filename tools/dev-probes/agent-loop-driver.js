#!/usr/bin/env node
'use strict'
/**
 * agent-loop-driver.js — drive a REAL agent loop and count the repeats.
 *
 * WHY THIS EXISTS. Two earlier instruments failed to reach the regime where the
 * duplicate-tool-call bug actually lives, and they failed for the same reason.
 *
 *   probe-agent-loop.js  — synthetic, 12 cells, passes 12/12. Its repetition
 *                          cells passed BEFORE the fix and one passes vacuously
 *                          (the model emits no call at all). No headroom.
 *   replay-duplicates.js — replays recorded prefixes. The recorded prefixes run
 *                          to ~340 KiB; above 90 KiB the proxy externalises the
 *                          whole prompt into an uploaded document, so the replay
 *                          has to WINDOW to ~90 KiB. Windowing deletes exactly
 *                          the accumulated state that drives the repetition.
 *
 * The structural fix is to stop reconstructing context and start ACCUMULATING
 * it. This driver plays the client half of the loop: the model calls a tool, the
 * driver executes it against a deterministic simulated repo, appends the result,
 * and sends the WHOLE conversation back. Nothing is windowed, ever.
 *
 * THE SIMULATOR IS THE INSTRUMENT'S WEAKEST POINT, AND IT HAS FAILED BEFORE.
 * A design review of the first version found it manufactured empty results at
 * high rate, including on the most natural call for its own task:
 *
 *   Grep{pattern:'legacyFormat\\(', glob:'src/(star)(star)/(star).js'} -> "No matches found"
 *   Bash: grep -rn 'legacyFormat(' src/                                -> "No matches found"
 *   Bash: sed -n '200,400p' src/core/pipeline.js                       -> "(no output)"
 *   Bash: wc -l src/core/pipeline.js                                   -> "23"  (file count!)
 *   Bash: cat src/core/pipeline.js                                     -> first 60 of 1278
 *
 * Two root causes: a glob scope built by DELETING every '*' from the pattern, so
 * 'src/**' + '/*.js' became the literal prefix 'src///.js' and matched nothing;
 * and an invalid-regex catch that returned NO MATCH instead of falling back,
 * while the task's own target string 'legacyFormat(' is an invalid regex. A
 * harness that tells the model a file is empty and then counts the re-read as a
 * duplicate is measuring itself. Every one of those is fixed below, and
 * `--self-test` asserts none can come back: it runs the calls the tasks
 * plausibly generate, fails on any empty or error, and separately checks that
 * the answers are TRUE. Run it before spending a single upstream request.
 *
 * WHAT IS MEASURED (per call)
 *   - the turn it was emitted on, the request size, whether that size was above
 *     the externalisation threshold
 *   - CROSS-TURN duplicate: byte-identical (name + canonical args) to a call
 *     executed on an EARLIER turn of this run. That is the corpus definition
 *     behind the 9.5% figure. Same-message repeats are recorded SEPARATELY as
 *     `inMessageDup` and are NOT counted in `dupRate`; the corpus measured them
 *     at exactly 0, and the per-attempt ledger already suppresses them.
 *   - gapTurns / gapDistinct back to the original, recorded raw so an
 *     in-ledger-window flag can be computed post-hoc for ANY window size rather
 *     than being baked into the data at collection time.
 *   - distinctTargetsCovered: how much of the task is actually done. The arms do
 *     not reach the same turn with the same progress — post-fix injects a ledger
 *     and so crosses the threshold earlier — and comparing them at a matched
 *     turn index is therefore confounded. This is the matching variable.
 *   - whether the result immediately before was empty. Retry-after-empty is
 *     already REFUTED on the corpus (RR 0.38); this is kept only so the harness
 *     can demonstrate it is not itself generating the empties.
 *
 * HONESTY CONSTRAINTS, STATED UP FRONT
 *   - The environment is byte-identical across arms and across seeds: the repo
 *     is built from a FIXED seed. Only the task instance varies with --seed.
 *   - The REQUESTS are not byte-identical across arms and cannot be — once the
 *     model makes a different choice on turn 3 the conversations diverge. A
 *     within-arm repeat run is therefore mandatory: without a noise floor a
 *     between-arm difference is not interpretable.
 *   - The absolute rates are this harness's rates, not Claude Code's.
 *   - An unrecognised Bash command returns an ERROR, never silence. Silence is
 *     a lie the model cannot detect; an error it can react to.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:7861 KEY=sk-... MODEL=qwen3.8-max \
 *     node tools/dev-probes/agent-loop-driver.js --arm post --task 1 --turns 14 \
 *       --seed 3 --out /tmp/post-t1-s3.jsonl
 *
 *   --path anthropic|openai   default anthropic (the user's actual path)
 *   --task 1..5               which task to run (see buildTask); default 1
 *   --turns N                 hard cap on upstream turns for this run
 *   --seed S                  task-instance seed; does NOT change the repo
 *   --arm LABEL               free-form label recorded in every line
 *   --out FILE                JSONL record, one line per turn
 *   --dry-run                 build the repo, print its shape, spend nothing
 *   --self-test               exercise the tool simulator, spend nothing
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

// --- args -----------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)

const DRY = has('dry-run')
const SELFTEST = has('self-test')
const PATH_KEY = flag('path', 'anthropic')
const TURNS = Number(flag('turns', 30))
const ARM = flag('arm', 'unlabelled')
const OUT = flag('out', null)
const TASK_ID = Number(flag('task', 1))
const SEED = Number(flag('seed', 1))
// 1024 truncated agentic turns, and Task 5 changed stop_reason precedence UNDER
// truncation — so at 1024 the two arms differed in truncation handling, which is
// not the thing under test. `finish` is now recorded per call as well.
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096)
const THRESHOLD = Number(process.env.THRESHOLD || 92160)
// The measured capacity of the injected ledger: 30 entries survived the 48 KiB
// live-prompt rebuild above the threshold. Used only for a convenience column —
// gapDistinct is in every record, so any window can be applied afterwards.
const LEDGER_WINDOW = Number(process.env.LEDGER_WINDOW || 30)

const BASE_URL = process.env.BASE_URL
const KEY = process.env.KEY
const MODEL = process.env.MODEL
const BASE = String(BASE_URL || '').replace(/\/$/, '')

// --- the simulated repository ---------------------------------------------
// Deterministic and INDEPENDENT of --seed: both arms, and every seed, audit the
// byte-identical repo. Only the task instance varies with --seed. Letting the
// seed reach the fixture would make the environment a second uncontrolled
// variable and destroy the paired design.

const mkRng = (s) => {
  let x = s >>> 0
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >> 17
    x ^= x << 5; x >>>= 0
    return x / 0x100000000
  }
}

const REPO_SEED = 0x9e3779b9
const rnd = mkRng(REPO_SEED)
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]

const MODULES = [
  'auth/session', 'auth/tokens', 'auth/permissions',
  'billing/invoice', 'billing/ledger', 'billing/rates',
  'catalog/index', 'catalog/search', 'catalog/facets',
  'orders/create', 'orders/fulfil', 'orders/refund',
  'shipping/quote', 'shipping/label', 'shipping/track',
  'users/profile', 'users/prefs', 'users/audit'
]
const BIG = ['core/pipeline', 'core/registry', 'core/normalise']
const ALL_MODULES = [...BIG, ...MODULES]

const VERBS = ['resolve', 'collect', 'validate', 'derive', 'merge', 'flush', 'hydrate', 'reconcile']
const NOUNS = ['Record', 'Batch', 'Envelope', 'Cursor', 'Descriptor', 'Snapshot', 'Handle', 'Window']

// A deterministic import graph. Tasks 1 and 4 are built on it: the REVERSE edge
// ("which modules require X") is not visible in X itself, so answering forces a
// file already read to be examined again. That revisiting is the property which
// separates high-duplicate sessions from low-duplicate ones in the corpus.
//
// Edges only ever run FORWARD along DAG_ORDER, which makes the graph acyclic by
// construction. That is not decoration: the first version drew edges uniformly
// and produced 99 cycles reachable from core/pipeline, which makes task 4 —
// "follow every require edge to its leaf" — literally unanswerable, and would
// have had the model looping through core/pipeline -> catalog/index ->
// billing/invoice -> catalog/facets -> core/pipeline forever while the harness
// counted every lap as duplicate tool calls the fix had failed to prevent.
//
// core/pipeline is the root (package.json's `main`), core/normalise the single
// leaf, and core/registry a hub just above it so many chains converge — the
// convergence is what makes shared nodes get revisited.
const DAG_ORDER = ['core/pipeline', ...MODULES, 'core/registry', 'core/normalise']
const IMPORTS = new Map()
{
  const g = mkRng(0x51ed270b)
  const LEAF = DAG_ORDER.length - 1
  const HUB = DAG_ORDER.length - 2
  for (let i = 0; i < DAG_ORDER.length; i++) {
    const me = DAG_ORDER[i]
    const deps = new Set()
    if (i < LEAF) {
      // Out-degree is capped so the number of distinct root-to-leaf paths stays
      // in a range a person could actually enumerate; the root gets more edges
      // so the traversal fans out immediately.
      const fanout = i === 0 ? 4 : 2
      for (let k = 0; k < fanout; k++) {
        // Half the edges go a short way forward (a chain), half to a hub (the
        // convergence). Both are strictly forward, so no cycle is possible.
        const target = (k % 2 === 1 || i >= HUB - 1)
          ? (g() < 0.5 ? HUB : LEAF)
          : Math.min(LEAF, i + 1 + Math.floor(g() * 4))
        if (target !== i) deps.add(DAG_ORDER[target])
      }
      if (!deps.size) deps.add(DAG_ORDER[LEAF])
    }
    IMPORTS.set(me, [...deps].sort())
  }
}

const relRequire = (from, to) => {
  const a = from.split('/')
  a.pop()
  const rel = path.posix.relative(a.join('/') || '.', to)
  return rel.startsWith('.') ? rel : `./${rel}`
}

// Deliberate invariant violations, so task 2 has something to find and cannot be
// closed out with a single grep that returns nothing.
const NO_STRICT = new Set(['catalog/facets', 'users/prefs'])
const BARE_STORE = new Set(['billing/ledger', 'orders/refund', 'core/registry'])
const BAD_THROW = new Set(['auth/tokens', 'shipping/label', 'core/pipeline'])

function mkBody (name, lines) {
  const out = []
  if (!NO_STRICT.has(name)) out.push('\'use strict\'')
  out.push(`// ${name} — generated fixture`)
  for (const dep of IMPORTS.get(name) || []) {
    out.push(`const ${dep.split('/').pop()} = require('${relRequire(name, dep)}')`)
  }
  out.push('')
  for (let i = 0; i < lines; i++) {
    const v = pick(VERBS); const n = pick(NOUNS)
    const r = rnd()
    if (r < 0.06) {
      out.push(`  const shaped = legacyFormat(${v}${n}, { strict: false })`)
    } else if (r < 0.16) {
      out.push(`function ${v}${n} (input, opts = {}) {`)
    } else if (r < 0.26) {
      out.push('}')
    } else if (r < 0.4) {
      const bare = BARE_STORE.has(name) && i % 37 === 0
      out.push(`  const ${v}${i} = ${bare ? '' : 'await '}store.${v}('${n.toLowerCase()}', input.id)`)
    } else if (r < 0.55) {
      const prefix = BAD_THROW.has(name) && i % 41 === 0 ? '' : `${name}: `
      out.push(`  if (!${v}${i}) throw new Error('${prefix}missing ${n}')`)
    } else if (r < 0.7) {
      out.push(`  // ${v} the ${n.toLowerCase()} before the ${pick(VERBS)} step runs`)
    } else {
      out.push(`  ctx.${v}(${JSON.stringify(n)}, ${i}, opts.${pick(VERBS)} ?? null)`)
    }
  }
  return out.join('\n')
}

// SIZING IS NOT ARBITRARY — it is calibrated to the measured regime.
// In the worst real session (33f8544e, 179/510 dupes) every duplicate call with
// usage recorded sat ABOVE the 90 KiB threshold: effective input p50 = 105,153
// tokens (~370 KiB), 18/18 above. A fixture whose whole content is 145 KB tops
// out around 139 KB of context and never enters that band. SCALE controls it;
// default 3 puts a systematic audit in the 300-500 KiB range.
const SCALE = Number(process.env.SCALE || 3)
const REPO = new Map()
for (const m of MODULES) REPO.set(`src/${m}.js`, mkBody(m, (60 + Math.floor(rnd() * 50)) * SCALE))
for (const m of BIG) REPO.set(`src/${m}.js`, mkBody(m, (420 + Math.floor(rnd() * 120)) * SCALE))
REPO.set('package.json', JSON.stringify({ name: 'acme-svc', version: '3.2.1', main: 'src/core/pipeline.js' }, null, 2))
REPO.set('README.md', [
  '# acme-svc',
  '',
  'Internal service. See src/ for modules.',
  '',
  '## Claims',
  '',
  'C1. The `legacyFormat` helper is deprecated and must be removed before 4.0.',
  'C2. Every source file under src/ begins with the \'use strict\' pragma.',
  'C3. `src/core/normalise.js` has no dependencies of its own.',
  'C4. No module outside src/core/ requires `src/core/registry.js` directly.',
  'C5. Every `store.` call in the codebase is awaited.',
  'C6. Every thrown Error message is prefixed with its own module name.',
  ''
].join('\n'))

const ALL_PATHS = [...REPO.keys()]
const HITS = ALL_PATHS.filter(p => REPO.get(p).includes('legacyFormat('))
const lineCount = (p) => REPO.get(p).split('\n').length

// Claude Code's own strings. Not invented for this harness.
const EMPTY_BASH = '(Bash completed with no output)'
const NO_MATCH = 'No matches found'
// Claude Code's Read reads up to 2000 lines. The previous version silently
// capped every read at 200 with no marker, so a model that asked for 500 got
// 200 and believed it had reached line 500.
const READ_MAX_LINES = Number(process.env.READ_MAX_LINES || 2000)
const GREP_MAX_HITS = 200

const trunc = (text, shown, total, unit) =>
  shown < total ? `${text}\n... [truncated: showing ${shown} of ${total} ${unit}]` : text

// Every tool takes a path the way a real agent writes it: absolute
// (/srv/acme-svc/src/x.js), repo-relative (src/x.js) or ./-prefixed. All three
// must resolve to the same file, or the harness manufactures empty results that
// have nothing to do with the proxy.
const norm = (p) => String(p ?? '')
  .trim()
  // a real agent chains commands, so the captured path arrives welded to shell
  // punctuation (`...pipeline.js;`, `...src/ &&`). Strip it or every such call
  // scopes to a path that does not exist and returns a FALSE empty result.
  .replace(/[;&|)'"`]+$/, '')
  .replace(/^['"`]+/, '')
  .replace(/^\/srv\/acme-svc\/?/, '')
  .replace(/^\.\//, '')
  .replace(/^\/+/, '')
  .replace(/\/+$/, '')

// Real glob semantics: '**' spans directories, '*' does not, and the pattern is
// anchored. Built by scanning rather than by sentinel substitution, because the
// previous version collapsed the stars into a substring match and made
// 'src/**' + '/*.js' return nothing — a false empty, the exact artefact this
// harness must never manufacture. One implementation, shared by Glob, by Grep's
// `glob` filter and by `grep --include`, so the bug cannot be fixed in one place
// and left standing in another.
function globToRegExp (raw) {
  const s = String(raw)
  let out = '^'
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '*') {
      if (s[i + 1] === '*') {
        if (s[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

// A glob with no slash filters on the BASENAME (ripgrep's rule): '*.js' means
// any .js anywhere, not only one at the repo root.
function globMatches (raw, p) {
  const g = norm(raw)
  if (!g || g === '.' || g === '**') return true
  const re = globToRegExp(g)
  return g.includes('/') ? re.test(p) : re.test(p.split('/').pop())
}

// A path scope is a directory prefix or an exact file, never a glob — but an
// agent writes `grep pat src/**/*.js` often enough that a scope carrying stars
// must degrade to glob matching instead of matching nothing.
function scopeMatches (raw, p) {
  const s = norm(raw)
  if (!s || s === '.') return true
  if (s.includes('*') || s.includes('?')) return globMatches(s, p)
  return p === s || p.startsWith(s + '/')
}

function readFile (args) {
  const p = String(args?.file_path ?? args?.path ?? '')
  const key = norm(p)
  if (!REPO.has(key)) return { body: `<tool_use_error>File does not exist: ${p}</tool_use_error>`, empty: false, err: true, paths: [] }
  const lines = REPO.get(key).split('\n')
  // Claude Code's `offset` is a 1-based line number.
  const offset = Math.max(0, Number(args?.offset ?? 0) - (args?.offset ? 1 : 0))
  const asked = Number(args?.limit ?? READ_MAX_LINES) || READ_MAX_LINES
  const limit = Math.min(Math.max(1, asked), READ_MAX_LINES)
  const slice = lines.slice(offset, offset + limit)
  if (!slice.length) {
    // Past EOF is INFORMATION, not silence. The old code returned Bash's
    // "(Bash completed with no output)" from a Read — the wrong tool's string,
    // and indistinguishable from a manufactured empty.
    return {
      body: `<system-reminder>${key} has ${lines.length} lines. Requested offset ${offset + 1} is past the end of the file.</system-reminder>`,
      empty: false,
      err: false,
      paths: []
    }
  }
  const numbered = slice.map((l, i) => `${String(offset + i + 1).padStart(6)}\t${l}`).join('\n')
  const end = offset + slice.length
  const note = end < lines.length
    ? `\n... [truncated: showing lines ${offset + 1}-${end} of ${lines.length}; continue with offset ${end + 1}]`
    : ''
  return { body: numbered + note, empty: false, err: false, paths: [key] }
}

// A pattern that will not compile as a JS regex is NOT a reason to report "no
// matches". `grep` without -E treats '(' literally and matches 'legacyFormat('
// fine, and that is the task's own target string. A literal substring fallback
// is the only behaviour here that cannot manufacture a false empty.
function makeMatcher (pattern, { icase = false } = {}) {
  const pat = String(pattern ?? '')
  try {
    const re = new RegExp(pat, icase ? 'i' : '')
    return { test: (l) => re.test(l), literal: false }
  } catch (_) {
    const needle = icase ? pat.toLowerCase() : pat
    return { test: (l) => (icase ? String(l).toLowerCase() : String(l)).includes(needle), literal: true }
  }
}

function grepRepo (pattern, scope, opts = {}) {
  const { glob = null, icase = false, filesOnly = false, count = false } = opts
  if (!String(pattern ?? '').length) return { body: '<tool_use_error>grep: empty pattern</tool_use_error>', empty: false, err: true, paths: [] }
  const m = makeMatcher(pattern, { icase })
  const out = []
  const files = []
  let total = 0
  for (const p of ALL_PATHS) {
    if (!scopeMatches(scope, p)) continue
    if (glob && !globMatches(glob, p)) continue
    let n = 0
    REPO.get(p).split('\n').forEach((l, i) => {
      if (!m.test(l)) return
      n++; total++
      out.push(`${p}:${i + 1}:${l.trim()}`)
    })
    if (n) files.push(count ? `${p}:${n}` : p)
  }
  if (!total) return { body: NO_MATCH, empty: true, err: false, paths: [] }
  // A file LIST is not content: `grep -l` and `Glob` tell the model which files
  // exist, not what is in them, so neither counts as task progress.
  if (filesOnly || count) return { body: files.join('\n'), empty: false, err: false, paths: [] }
  return {
    body: trunc(out.slice(0, GREP_MAX_HITS).join('\n'), Math.min(out.length, GREP_MAX_HITS), total, 'matches'),
    empty: false,
    err: false,
    paths: files.slice()
  }
}

function globRepo (args) {
  const raw = String(args?.pattern ?? '').trim()
  if (!raw) return { body: '<tool_use_error>Glob: empty pattern</tool_use_error>', empty: false, err: true, paths: [] }
  const hit = ALL_PATHS.filter(p => globMatches(raw, p))
  if (!hit.length) return { body: NO_MATCH, empty: true, err: false, paths: [] }
  return { body: hit.join('\n'), empty: false, err: false, paths: [] }
}

// --- Bash -----------------------------------------------------------------
// A handful of real shapes. The critical rule: an unrecognised command returns
// an ERROR, never "(Bash completed with no output)". The old catch-all returned
// silence, so `sed -n '200,400p' file` and `awk 'NR==5' file` — the two commands
// the old task's own "page through them" instruction invited — reported the file
// as empty. Silence the model cannot distinguish from truth is the single most
// dangerous thing this harness can emit.

// Split a command line on |, || , && and ; but only OUTSIDE quotes.
function splitStages (cmd) {
  const out = []
  let cur = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q) {
      cur += c
      if (c === q) q = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue }
    if (c === ';' || c === '|' || c === '&') {
      // `||` and `&&` are two characters; a lone & is a background marker.
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++
      out.push(cur.trim()); cur = ''
      continue
    }
    cur += c
  }
  out.push(cur.trim())
  return out.filter(Boolean)
}

const fileArg = (tokens) => {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = norm(tokens[i])
    if (t && !t.startsWith('-') && REPO.has(t)) return t
  }
  return null
}

function bashRead (tokens, from, to) {
  const p = fileArg(tokens)
  if (!p) {
    const guess = norm(tokens[tokens.length - 1] || '')
    return { body: `${tokens[0]}: ${guess || '(no file)'}: No such file or directory`, empty: false, err: true, paths: [] }
  }
  const lines = REPO.get(p).split('\n')
  const a = Math.max(1, from)
  const b = Math.min(lines.length, to)
  if (a > lines.length) {
    return { body: `<system-reminder>${p} has ${lines.length} lines; requested range starts at ${a}, past the end.</system-reminder>`, empty: false, err: false, paths: [] }
  }
  // A requested sub-range is NOT truncation: `head -n 5` returning 5 of 1279
  // lines is the correct answer, and stamping "truncated" on it would be a
  // second way of lying about the file's shape. Only a range whose END runs off
  // the file earns a note, and `cat` (to === Infinity) never does.
  const slice = lines.slice(a - 1, b)
  const note = (to !== Infinity && to > lines.length) ? `\n... [end of file: ${p} has ${lines.length} lines]` : ''
  return { body: slice.join('\n') + note, empty: false, err: false, paths: [p] }
}

// A pipeline is evaluated left to right, each stage filtering the previous
// stage's output. Taking only the LAST stage and hunting the whole command line
// for a filename would answer `grep pat X | wc -l` with X's line count instead
// of the number of matches — full, confident and wrong, which is worse than an
// error because the model acts on it.
function applyFilter (stage, prev) {
  const tokens = stage.split(/\s+/)
  const head = tokens[0]
  const rows = prev.body ? prev.body.split('\n') : []
  const nm = stage.match(/-n\s*\+?(\d+)/) || stage.match(/(?:^|\s)-(\d+)/)
  const n = nm ? Number(nm[1]) : 10
  const keep = prev.paths || []
  if (head === 'head') return { body: rows.slice(0, n).join('\n'), empty: !rows.length, err: false, paths: keep }
  if (head === 'tail') return { body: rows.slice(Math.max(0, rows.length - n)).join('\n'), empty: !rows.length, err: false, paths: keep }
  if (head === 'wc') return { body: String(rows.length), empty: false, err: false, paths: [] }
  if (head === 'sort') return { body: rows.slice().sort().join('\n'), empty: !rows.length, err: false, paths: keep }
  if (head === 'uniq') return { body: [...new Set(rows)].join('\n'), empty: !rows.length, err: false, paths: keep }
  if (head === 'cat') return prev
  if (/^(grep|rg|egrep|fgrep)$/.test(head)) {
    const w = stage.slice(head.length).match(/'([^']*)'|"([^"]*)"|(?:^|\s)([^-\s]\S*)/)
    if (!w) return { body: '<tool_use_error>grep: no pattern given</tool_use_error>', empty: false, err: true, paths: [] }
    const m = makeMatcher(w[1] ?? w[2] ?? w[3], { icase: /(?:^|\s)-[a-zA-Z]*i/.test(stage) })
    const hit = rows.filter(l => m.test(l))
    return hit.length ? { body: hit.join('\n'), empty: false, err: false, paths: keep } : { body: NO_MATCH, empty: true, err: false, paths: [] }
  }
  return { body: `<tool_use_error>Bash: '${head}' is not available as a pipeline filter in this sandbox.</tool_use_error>`, empty: false, err: true, paths: [] }
}

function runBash (args) {
  const cmd = String(args?.command ?? '').trim()
  if (!cmd) return { body: '<tool_use_error>Bash: empty command</tool_use_error>', empty: false, err: true, paths: [] }
  // The split MUST respect quotes: a naive split on the operators shredded
  // `awk 'NR>=10 && NR<=12' f` at the && and `grep -rn 'a|b' src` at the |,
  // leaving a fragment that matched no command and returning an error for a
  // perfectly ordinary call. A leading `cd` is scenery.
  const stages = splitStages(cmd).filter(x => x && !/^cd\b/.test(x))
  if (stages.length > 1) {
    let r = runStage(stages[0])
    for (let i = 1; i < stages.length && !r.err; i++) r = applyFilter(stages[i], r)
    return r
  }
  return runStage(stages[0] || cmd)
}

function runStage (stage) {
  const tokens = stage.split(/\s+/)
  const head = tokens[0]
  let m

  if (/^(grep|rg|egrep|fgrep)$/.test(head)) {
    const rest = stage.slice(head.length)
    // Flags arrive clustered (`-rln`), so the letters have to be collected from
    // the cluster rather than matched at its end: a regex anchored on the last
    // character honoured `-rl` and silently ignored `-rln`.
    const flags = new Set()
    for (const t of tokens.slice(1)) {
      if (t.startsWith('--') || !t.startsWith('-')) continue
      for (const ch of t.slice(1)) flags.add(ch)
    }
    const icase = flags.has('i')
    const filesOnly = flags.has('l')
    const count = flags.has('c')
    const inc = rest.match(/--include[= ]['"]?([^\s'"]+)/)
    // Every non-flag word in order: pattern first, then the path scope.
    const words = []
    const re = /'([^']*)'|"([^"]*)"|(\S+)/g
    let w
    while ((w = re.exec(rest))) {
      if (w[3] && w[3].startsWith('-')) continue
      words.push(w[1] ?? w[2] ?? w[3])
    }
    if (!words.length) return { body: '<tool_use_error>grep: no pattern given</tool_use_error>', empty: false, err: true }
    return grepRepo(words[0], words[1] ?? null, { glob: inc ? inc[1] : null, icase, filesOnly, count })
  }

  if (head === 'ls') {
    const dir = norm(tokens.filter(t => !t.startsWith('-')).slice(1).pop() || '')
    const kids = new Set()
    for (const p of ALL_PATHS) {
      if (!scopeMatches(dir, p)) continue
      kids.add(dir && dir !== '.' ? p.slice(dir.length + 1).split('/')[0] : p.split('/')[0])
    }
    if (!kids.size) return { body: `ls: ${dir}: No such file or directory`, empty: false, err: true, paths: [] }
    return { body: [...kids].sort().join('\n'), empty: false, err: false, paths: [] }
  }

  if (head === 'cat') return bashRead(tokens, 1, Infinity)

  if (head === 'head' || head === 'tail') {
    // -n 5, -n5 and -5 are all real spellings, and tail reads the END.
    const nm = stage.match(/-n\s*\+?(\d+)/) || stage.match(/(?:^|\s)-(\d+)/)
    const n = nm ? Number(nm[1]) : 10
    const p = fileArg(tokens)
    if (!p) return { body: `${head}: ${norm(tokens[tokens.length - 1] || '')}: No such file or directory`, empty: false, err: true }
    const total = lineCount(p)
    return head === 'head' ? bashRead(tokens, 1, n) : bashRead(tokens, Math.max(1, total - n + 1), total)
  }

  // sed -n '200,400p'  /  sed -n '5p'
  if (head === 'sed' && (m = stage.match(/(\d+)\s*,\s*(\d+)\s*p/))) return bashRead(tokens, Number(m[1]), Number(m[2]))
  if (head === 'sed' && (m = stage.match(/(\d+)\s*p/))) return bashRead(tokens, Number(m[1]), Number(m[1]))

  // awk 'NR==5'  /  awk 'NR>=200 && NR<=400'
  if (head === 'awk' && (m = stage.match(/NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*(\d+)/))) return bashRead(tokens, Number(m[1]), Number(m[2]))
  if (head === 'awk' && (m = stage.match(/NR\s*==\s*(\d+)/))) return bashRead(tokens, Number(m[1]), Number(m[1]))

  if (head === 'wc') {
    // The old version returned the number of FILES IN THE REPO for every wc, so
    // `wc -l src/core/pipeline.js` answered 23 for a 1278-line file and the model
    // concluded it had already seen the whole thing.
    const targets = tokens.slice(1).filter(t => !t.startsWith('-')).map(norm).filter(t => REPO.has(t))
    if (!targets.length) return { body: `wc: ${norm(tokens[tokens.length - 1] || '')}: No such file or directory`, empty: false, err: true }
    const rows = targets.map(t => `${String(lineCount(t)).padStart(8)} ${t}`)
    if (targets.length > 1) rows.push(`${String(targets.reduce((a, t) => a + lineCount(t), 0)).padStart(8)} total`)
    return { body: rows.join('\n'), empty: false, err: false }
  }

  if (head === 'find') {
    const nm = stage.match(/-name\s+['"]?([^\s'"]+)/)
    const scope = tokens[1] && !tokens[1].startsWith('-') ? tokens[1] : null
    const hit = ALL_PATHS.filter(p => scopeMatches(scope, p) && (!nm || globMatches(nm[1], p)))
    if (!hit.length) return { body: NO_MATCH, empty: true, err: false, paths: [] }
    return { body: hit.join('\n'), empty: false, err: false, paths: [] }
  }

  if (head === 'echo') return { body: stage.slice(4).trim().replace(/^['"]|['"]$/g, ''), empty: false, err: false, paths: [] }
  if (head === 'pwd') return { body: '/srv/acme-svc', empty: false, err: false, paths: [] }

  return {
    body: `<tool_use_error>Bash: '${head}' is not available in this sandbox. Available: grep, rg, ls, cat, head, tail, sed -n, awk NR, wc -l, find, echo, pwd. Prefer the Read, Grep and Glob tools.</tool_use_error>`,
    empty: false,
    err: true,
    paths: []
  }
}

function execute (name, args) {
  if (name === 'Read') return readFile(args || {})
  if (name === 'Bash') return runBash(args || {})
  if (name === 'Grep') {
    const a = args || {}
    return grepRepo(String(a.pattern ?? ''), a.path ?? null, {
      glob: a.glob ?? null,
      icase: a['-i'] === true || a.case_insensitive === true,
      filesOnly: a.output_mode === 'files_with_matches',
      count: a.output_mode === 'count'
    })
  }
  if (name === 'Glob') return globRepo(args || {})
  return { body: `<tool_use_error>Unknown tool: ${name}</tool_use_error>`, empty: false, err: true, paths: [] }
}

// --- the tasks ------------------------------------------------------------
// The corpus says what separates a high-duplicate session from a low-duplicate
// one, and it is not length, tool mix or context size. It is the ratio of
// DISTINCT call signatures to total calls: 0.62 in sessions above 25% duplicates,
// 0.99 in sessions below 5%. High-duplicate sessions revisit a bounded target
// set; low-duplicate sessions have an expanding frontier where every call is new.
//
// The driver's original task — "find every call site of legacyFormat( across 23
// files" — is an expanding frontier: each file is read once, distinct/total ~1.0.
// It is a LOW-duplicate-regime task, which explains its 20-call / 0-duplicate
// null at least as well as low power does.
//
// All five below force a bounded set to be revisited, and they differ in HOW:
// traversal order (breadth-first, multi-pass, depth-first, graph-driven,
// document-anchored), what drives the revisit (a second criterion vs. graph
// structure vs. an external claim), and tool mix. A single behavioural quirk
// would have to survive all five orderings in the same direction — which is why
// per-task rates must always be reported and never only the pooled number.
//
// Repetition is unambiguously wasteful in every one: the tree never changes,
// nothing is edited, and every duplicate is a byte-identical re-read of content
// already in context. No stateless status poll (the ListAgents shape, 98.9%
// "duplicate" in the corpus and legitimately so) is in the tool set.

const shuffle = (arr, rng) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

const INVARIANTS = [
  'I1. Every file under src/ starts with the `\'use strict\'` pragma.',
  'I2. No file calls `legacyFormat(`.',
  'I3. Every `store.` call is awaited.',
  'I4. Every `throw new Error` message begins with the module\'s own path.',
  'I5. No module outside src/core/ requires `src/core/registry.js` directly.',
  'I6. Every file declares at least one `function`.',
  'I7. No `ctx.` call passes a literal `null` as its third argument.',
  'I8. No file under src/ exceeds 1000 lines.'
]

const PREAMBLE = [
  'You are working in the repository /srv/acme-svc (a Node.js service).',
  'Use the Read, Grep, Glob and Bash tools to inspect it. Do not guess: an answer',
  'you report without having seen the lines that support it is a wrong answer.',
  ''
].join('\n')

function buildTask (id, seed) {
  const rng = mkRng((seed >>> 0) * 2654435761 + id)
  if (id === 1) {
    const targets = shuffle(ALL_MODULES, rng).slice(0, 12).sort()
    return {
      id,
      name: 'import-xref',
      targets,
      text: [PREAMBLE, 'TASK: build a two-way import cross-reference.', '',
        'For EACH of these 12 modules:', ...targets.map(t => `  - src/${t}.js`), '',
        'report BOTH:',
        '  (a) which modules it requires, and',
        '  (b) which modules require IT.', '',
        'Direction (b) is not visible in the file itself — you have to establish it',
        'from the other files. Give the final answer as one table with both columns',
        'filled in for all 12 modules.'].join('\n')
    }
  }
  if (id === 2) {
    const inv = shuffle(INVARIANTS, rng)
    return {
      id,
      name: 'invariant-audit',
      targets: inv,
      text: [PREAMBLE, 'TASK: audit the codebase against 8 invariants.', '',
        ...inv, '',
        'For EACH invariant, list every file under src/ that violates it, or state',
        'that none does. An invariant with no violations still needs the evidence',
        'that let you conclude that. Answer with one section per invariant, in the',
        'order given above.'].join('\n')
    }
  }
  if (id === 3) {
    const targets = shuffle(ALL_MODULES, rng).slice(0, 6).sort()
    return {
      id,
      name: 'three-key-ranking',
      targets,
      text: [PREAMBLE, 'TASK: rank these 6 files three different ways.', '',
        ...targets.map(t => `  - src/${t}.js`), '',
        'Produce three separate rankings, each from highest to lowest:',
        '  1. by the number of `await` occurrences',
        '  2. by the number of `throw` occurrences',
        '  3. by total line count', '',
        'Give the counts alongside each ranking, and finish with a single table',
        'showing all three positions per file.'].join('\n')
    }
  }
  if (id === 4) {
    return {
      id,
      name: 'call-chain-trace',
      targets: ['core/pipeline'],
      text: [PREAMBLE, 'TASK: trace the dependency graph.', '',
        'Starting from src/core/pipeline.js, follow every `require` edge to its leaf',
        '(a module that requires nothing). Report every distinct path from the root',
        'to a leaf, one per line, in the form `a -> b -> c`.', '',
        'Then state which modules appear on more than one path, and how many paths',
        'each of those appears on.'].join('\n')
    }
  }
  return {
    id: 5,
    name: 'spec-vs-code',
    targets: ['README.md'],
    text: [PREAMBLE, 'TASK: check the README against the code.', '',
      'README.md makes six numbered claims (C1..C6). For EACH claim, decide whether',
      'the code actually upholds it. Where a claim is false, name every file that',
      'breaks it and quote the line that proves it.', '',
      'Read README.md first to get the exact wording of the claims. Answer with one',
      'verdict per claim, in order, each with its supporting evidence.'].join('\n')
  }
}

const NUDGE = 'Continue. Do not stop until every item in the task has been covered.'

// --- adapters -------------------------------------------------------------

const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}
const collapseToOneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

// The duplicate key. It must name the SAME equivalence class the proxy's ledger
// dedupes on (src/utils/agent-turn.js: `${name}` + args, where args is
// canonicalJson for objects and collapseToOneLine for a raw string), or the
// driver counts repeats the fix was never trying to collapse.
//
// `args === null` means the arguments did not parse. The old version fed
// `canon(args ?? {})`, so EVERY malformed call keyed on `Name|{}` and two
// different broken calls scored as duplicates of each other — with malformed
// arguments a reported symptom and the fixes touching argument handling, that
// alone could have manufactured an arm difference.
const sigOf = (c) => {
  const a = c?.args
  const body = (a === null || a === undefined)
    ? collapseToOneLine(c?.raw ?? '')
    : (typeof a === 'string' ? collapseToOneLine(a) : canon(a))
  return `${String(c?.name ?? '')} ${body}`
}

// The duplicate accounting, lifted out of the loop so it can be tested without
// spending a request. This is the headline metric; leaving it inline meant the
// only way to check it was to run the experiment it decides.
//
// `state.seen` is READ for the whole turn and written only after every call in
// the message has been classified. Updating it mid-loop made a second identical
// call in the SAME assistant message score as a cross-turn duplicate with
// dupOfTurn === turn — conflating it with the metric the corpus measured at
// exactly 0, and inflating dupRate with repeats the per-attempt ledger already
// suppresses.
function classifyTurn (calls, state, ctx) {
  const recs = []
  const thisMessage = new Set()
  const admitted = []
  for (const c of calls) {
    const sig = sigOf(c)
    const prior = state.seen.get(sig) || null
    const inMessageDup = thisMessage.has(sig)
    thisMessage.add(sig)
    recs.push({
      turn: ctx.turn,
      name: c.name,
      sig,
      bytes: ctx.bytes,
      above: ctx.above,
      finish: ctx.finish ?? null,
      // CROSS-TURN only. An in-message repeat is recorded, never counted here.
      dup: prior !== null,
      dupOfTurn: prior ? prior.turn : null,
      inMessageDup,
      // gapDistinct is the original's DEPTH in a newest-first list of distinct
      // calls, counting from 1 — so `gapDistinct <= N` is exactly "a ledger of N
      // entries would still be listing it". Recorded raw so any window can be
      // applied after the fact instead of being baked in at collection time.
      gapTurns: prior ? ctx.turn - prior.turn : null,
      gapDistinct: prior ? state.distinctCalls - prior.ordinal : null,
      // Task progress, for matching arms that do not reach the same turn with
      // the same amount of work done.
      distinctTargetsCovered: ctx.covered,
      distinctCallsSoFar: state.distinctCalls,
      prevEmptyAny: ctx.prevEmptyAny,
      prevEmptyAll: ctx.prevEmptyAll,
      prevResultCount: ctx.prevResultCount
    })
    // `!inMessageDup` matters: without it a call repeated inside one message was
    // admitted twice, consuming two ordinals — inflating distinctCalls, which is
    // both the denominator of distinctRatio and the unit gapDistinct is measured in.
    if (prior === null && !inMessageDup) admitted.push(sig)
  }
  for (const sig of admitted) {
    state.seen.set(sig, { turn: ctx.turn, ordinal: state.distinctCalls })
    state.distinctCalls++
  }
  return recs
}

const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] },
  Bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  Grep: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
  Glob: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
}
const DESCS = {
  Read: 'Read a file from the local filesystem. Supports offset (1-based line number) and limit for paging large files.',
  Bash: 'Run a shell command and return its combined output. Available: grep, rg, ls, cat, head, tail, sed -n, awk NR, wc -l, find, echo, pwd.',
  Grep: 'Search file contents with a regular expression. Optional path (directory scope) and glob (filename filter).',
  Glob: 'Find files matching a glob pattern.'
}
const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Glob']

const anthropic = {
  path: '/v1/messages',
  headers: () => ({ 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }),
  body: (messages) => ({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: false,
    messages,
    tools: TOOL_NAMES.map(n => ({ name: n, description: DESCS[n], input_schema: SCHEMAS[n] }))
  }),
  parse: (j) => {
    const blocks = Array.isArray(j?.content) ? j.content : []
    return {
      text: blocks.filter(b => b?.type === 'text').map(b => String(b.text || '')).join(''),
      calls: blocks.filter(b => b?.type === 'tool_use').map(b => ({
        id: String(b.id || ''), name: String(b.name || ''), args: b.input ?? {}, raw: JSON.stringify(b.input ?? {})
      })),
      finish: j?.stop_reason ?? null,
      usage: j?.usage ?? null
    }
  },
  user: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
  assistant: (text, calls) => ({
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} }))
    ]
  }),
  results: (pairs) => [{ role: 'user', content: pairs.map(p => ({ type: 'tool_result', tool_use_id: p.id, content: p.body })) }]
}

const openai = {
  path: '/v1/chat/completions',
  headers: () => ({ 'content-type': 'application/json', authorization: `Bearer ${KEY}` }),
  body: (messages) => ({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: false,
    messages,
    tools: TOOL_NAMES.map(n => ({ type: 'function', function: { name: n, description: DESCS[n], parameters: SCHEMAS[n] } }))
  }),
  parse: (j) => {
    const choice = j?.choices?.[0] || {}
    const msg = choice.message || {}
    const list = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      calls: list.map(c => {
        const raw = typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {})
        // args stays null when the payload does not parse; sigOf then keys on the
        // raw string, so two different broken calls stay different.
        let args; try { args = JSON.parse(raw || '{}') } catch (_) { args = null }
        return { id: String(c?.id || ''), name: String(c?.function?.name || ''), args, raw }
      }),
      finish: choice.finish_reason ?? null,
      usage: j?.usage ?? null
    }
  },
  user: (text) => ({ role: 'user', content: text }),
  assistant: (text, calls) => ({
    role: 'assistant',
    content: text || null,
    tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) } }))
  }),
  results: (pairs) => pairs.map(p => ({ role: 'tool', tool_call_id: p.id, content: p.body }))
}

const adapter = PATH_KEY === 'openai' ? openai : anthropic

// --- transport ------------------------------------------------------------

let SPEND = 0
let RETRIES = 0
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const RETRY_5XX = Number(process.env.RETRY_5XX || 3)

async function post (messages) {
  const payload = JSON.stringify(adapter.body(messages))
  let last = 'no attempt'
  for (let attempt = 0; attempt <= RETRY_5XX; attempt++) {
    SPEND++
    try {
      const r = await fetch(`${BASE}${adapter.path}`, { method: 'POST', headers: adapter.headers(), body: payload })
      const raw = await r.text()
      let json = null
      try { json = JSON.parse(raw) } catch (_) { json = null }
      if (r.ok && json) return { ok: true, status: r.status, bytes: Buffer.byteLength(payload), retries: attempt, ...adapter.parse(json) }
      last = `HTTP ${r.status} ${raw.replace(/\s+/g, ' ').slice(0, 200)}`
      // A daily/rate limit is terminal: retrying burns quota to relearn it.
      // Qwen's RateLimited currently surfaces as 500 on /v1/messages and 502 on
      // the OpenAI path, so the BODY, not the status, is what identifies it.
      if (r.status === 429 || /RateLimited|upper limit|超出|限制/i.test(raw)) {
        return { ok: false, status: 429, rate: true, err: last, bytes: Buffer.byteLength(payload), text: '', calls: [], finish: null }
      }
      // The WAF/captcha 500 is burst-correlated, so back off rather than
      // retrying hard. Aborting here discards the whole climb into the regime.
      if (r.status >= 500 && attempt < RETRY_5XX) {
        RETRIES++
        const wait = 20000 * (attempt + 1)
        console.log(`      5xx, backing off ${wait / 1000}s (attempt ${attempt + 1}/${RETRY_5XX})`)
        await sleep(wait)
        continue
      }
      if (r.status >= 400 && r.status < 500) break
    } catch (e) {
      last = `fetch ${e.message}`
      if (attempt < RETRY_5XX) { RETRIES++; await sleep(10000); continue }
    }
  }
  return { ok: false, status: 0, err: last, bytes: Buffer.byteLength(payload), text: '', calls: [], finish: null }
}

// --- provenance -----------------------------------------------------------
// Two runs six weeks apart must be tellable apart. The driver's own content hash
// is the precise identity of the instrument; the git head pins the tree it ran
// from. Neither is derivable from the JSONL without recording it here.

function provenance () {
  let sha = null
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16) } catch (_) {}
  let head = null
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch (_) {}
  return { driverSha256: sha, gitHead: head, argv: argv.slice(), node: process.version }
}

// --- the self-test --------------------------------------------------------
// The 15 wasted requests that produced the first null happened because nothing
// asserted the simulator could answer the calls its own task invites. This is
// that assertion. It spends zero upstream requests and must be run before any.

const SELF_TEST_CASES = [
  ['Grep', { pattern: 'legacyFormat\\(', glob: 'src/**/*.js' }],
  ['Grep', { pattern: 'legacyFormat\\(', glob: '**/*.js' }],
  ['Grep', { pattern: 'legacyFormat(', path: 'src' }],
  ['Grep', { pattern: 'legacyFormat\\(' }],
  ['Grep', { pattern: 'require\\(', path: 'src/core' }],
  ['Grep', { pattern: 'await store\\.', glob: '*.js' }],
  ['Grep', { pattern: 'use strict', path: 'src', output_mode: 'files_with_matches' }],
  ['Glob', { pattern: 'src/**/*.js' }],
  ['Glob', { pattern: '**/*.md' }],
  ['Read', { file_path: '/srv/acme-svc/src/core/pipeline.js' }],
  ['Read', { file_path: 'src/core/pipeline.js', offset: 201, limit: 200 }],
  ['Read', { file_path: './README.md' }],
  ['Bash', { command: "grep -rn 'legacyFormat(' src/" }],
  ['Bash', { command: 'grep -rnF "legacyFormat(" src' }],
  ['Bash', { command: "rg -n 'legacyFormat\\(' src/**/*.js" }],
  ['Bash', { command: "grep -rn --include='*.js' 'require(' src" }],
  ['Bash', { command: 'cd /srv/acme-svc && grep -rln legacyFormat src' }],
  ['Bash', { command: 'ls src/core' }],
  ['Bash', { command: 'wc -l src/core/pipeline.js' }],
  ['Bash', { command: "sed -n '200,400p' src/core/pipeline.js" }],
  ['Bash', { command: "awk 'NR==5' src/core/pipeline.js" }],
  ['Bash', { command: 'head -n 5 src/core/pipeline.js' }],
  ['Bash', { command: 'tail -n 5 src/core/pipeline.js' }],
  ['Bash', { command: 'cat README.md' }],
  ['Bash', { command: "find src -name '*.js'" }],
  ['Bash', { command: "grep -rn 'legacyFormat(' src | wc -l" }],
  ['Bash', { command: "awk 'NR>=10 && NR<=12' src/core/pipeline.js" }],
  ['Bash', { command: 'cat src/core/pipeline.js | head -n 40' }]
]

// Facts the simulator must get RIGHT, not merely non-empty. A wrong-but-full
// answer (wc -l reporting the repo's file count) is worse than an empty one:
// the model acts on it and never learns it was lied to.
function selfTestFacts () {
  const fails = []
  const check = (label, got, want) => {
    if (String(got) !== String(want)) fails.push(`${label}: got ${JSON.stringify(String(got)).slice(0, 90)}, want ${JSON.stringify(String(want)).slice(0, 90)}`)
  }
  const big = 'src/core/pipeline.js'
  const body = REPO.get(big)
  const all = body.split('\n')
  const n = all.length

  check('wc -l reports the FILE line count, not the repo file count',
    runBash({ command: `wc -l ${big}` }).body.trim().split(/\s+/)[0], n)
  check('cat returns every line of the file',
    runBash({ command: `cat ${big}` }).body.split('\n').length, n)
  check('head -n 5 returns exactly 5 lines',
    runBash({ command: `head -n 5 ${big}` }).body.split('\n').length, 5)
  const tail = runBash({ command: `tail -n 3 ${big}` }).body.split('\n')
  check('tail reads the END of the file', tail[tail.length - 1], all[n - 1])
  check('sed -n 200,204p returns 5 lines',
    runBash({ command: `sed -n '200,204p' ${big}` }).body.split('\n').length, 5)
  check('sed -n 200,204p starts at line 200',
    runBash({ command: `sed -n '200,204p' ${big}` }).body.split('\n')[0], all[199])
  check('awk NR==5 returns line 5', runBash({ command: `awk 'NR==5' ${big}` }).body, all[4])

  const r500 = readFile({ file_path: big, limit: 500 })
  check('Read honours a limit of 500', r500.body.split('\n').filter(l => /^\s*\d+\t/.test(l)).length, 500)
  check('a truncated Read says so', /truncated/.test(r500.body), 'true')
  check('Read past EOF does not return the Bash empty string',
    readFile({ file_path: big, offset: 99999 }).body.includes(EMPTY_BASH), 'false')
  check('an unknown Bash command errors rather than returning silence',
    runBash({ command: 'node -e "1"' }).err, 'true')
  check('grep -l lists files, not matching lines',
    runBash({ command: "grep -rl 'legacyFormat(' src" }).body.split('\n').every(l => !/:\d+:/.test(l)), 'true')
  check('a clustered flag (-rln) is read letter by letter, not by its last char',
    runBash({ command: 'grep -rln legacyFormat src' }).body.split('\n').every(l => !/:\d+:/.test(l)), 'true')
  check('head -n 5 is not stamped as truncated',
    /truncated/.test(runBash({ command: `head -n 5 ${big}` }).body), 'false')
  check('Grep via glob and via path find the same number of hits',
    grepRepo('legacyFormat\\(', null, { glob: 'src/**/*.js' }).body.split('\n').length,
    grepRepo('legacyFormat\\(', 'src', {}).body.split('\n').length)
  check('an invalid regex falls back to a literal search instead of NO MATCH',
    grepRepo('legacyFormat(', 'src', {}).empty, 'false')
  check('a genuinely absent pattern still reports no matches',
    grepRepo('zzzNotInTheRepoZzz', 'src', {}).body, NO_MATCH)
  check('a pipeline counts the PREVIOUS stage, not a file it happens to name',
    runBash({ command: "grep -rn 'legacyFormat(' src | wc -l" }).body.trim(),
    runBash({ command: "grep -rn 'legacyFormat(' src" }).body.split('\n').length)
  check('a quoted operator does not split the command',
    runBash({ command: `awk 'NR>=10 && NR<=12' ${big}` }).body.split('\n').length, 3)

  // Path confinement: the simulator must never reach outside its own map, and a
  // traversal attempt must fail closed rather than resolving to a real file.
  check('a traversal escape does not resolve to anything',
    readFile({ file_path: '../../etc/passwd' }).err, 'true')
  check('an absolute host path does not resolve to anything',
    readFile({ file_path: '/etc/passwd' }).err, 'true')
  return fails
}

function runSelfTest () {
  let bad = 0
  console.log(`repo: ${ALL_PATHS.length} files, ${[...REPO.values()].reduce((a, b) => a + b.length, 0)} bytes, legacyFormat( in ${HITS.length}`)
  console.log('--- no plausible call may return an empty or error result ---')
  for (const [name, args] of SELF_TEST_CASES) {
    const r = execute(name, args)
    const label = `${name} ${JSON.stringify(args)}`.slice(0, 74)
    const ok = !r.empty && !r.err
    if (!ok) bad++
    console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label.padEnd(76)} -> ${String(r.body).replace(/\s+/g, ' ').slice(0, 50)}`)
  }
  const factFails = selfTestFacts()
  console.log('--- and the results must also be TRUE ---')
  if (!factFails.length) console.log('  ok    all fact checks pass')
  for (const f of factFails) console.log(`  FAIL  ${f}`)
  bad += factFails.length
  console.log('')
  console.log(bad ? `SELF-TEST FAILED: ${bad} problem(s). Do not spend upstream requests.` : 'SELF-TEST PASSED.')
  return bad
}

// --- the loop -------------------------------------------------------------

async function main () {
  if (SELFTEST) { process.exitCode = runSelfTest() ? 1 : 0; return }

  if (DRY) {
    const task = buildTask(TASK_ID, SEED)
    console.log(`repo: ${ALL_PATHS.length} files, ${[...REPO.values()].reduce((a, b) => a + b.length, 0)} bytes`)
    console.log(`legacyFormat( call sites in ${HITS.length} files`)
    for (const p of ALL_PATHS) console.log(`  ${p.padEnd(28)} ${String(lineCount(p)).padStart(5)} lines  ${String(REPO.get(p).length).padStart(7)} B`)
    console.log(`task ${task.id} (${task.name}) seed ${SEED}: ${Buffer.byteLength(task.text)} bytes`)
    console.log('---')
    console.log(task.text)
    console.log('---')
    console.log(`provenance: ${JSON.stringify(provenance())}`)
    console.log('')
    if (runSelfTest()) process.exitCode = 1
    return
  }

  if (!BASE_URL || !KEY || !MODEL) {
    console.error('need BASE_URL, KEY and MODEL in the environment')
    process.exit(2)
  }
  if (!(TASK_ID >= 1 && TASK_ID <= 5)) {
    console.error(`--task must be 1..5, got ${TASK_ID}`)
    process.exit(2)
  }

  const task = buildTask(TASK_ID, SEED)
  const out = OUT ? fs.createWriteStream(OUT, { flags: 'w' }) : null
  const emit = (o) => { if (out) out.write(JSON.stringify(o) + '\n') }
  const meta = {
    arm: ARM, path: PATH_KEY, model: MODEL, task: task.id, taskName: task.name, seed: SEED,
    scale: SCALE, maxTokens: MAX_TOKENS, threshold: THRESHOLD, startedAt: new Date().toISOString(),
    ...provenance()
  }
  emit({ kind: 'meta', ...meta })

  const messages = [adapter.user(task.text)]
  // sig -> { turn, ordinal } of its FIRST execution, plus the distinct-call
  // counter that gives gapDistinct its unit. classifyTurn owns both.
  const state = { seen: new Map(), distinctCalls: 0 }
  const records = []              // one per emitted call
  const covered = new Set()       // distinct repo files whose content has been seen
  let crossedAt = null
  let peak = 0
  let turn = 0
  let stopped = 'turns'
  let prevEmptyAny = false
  let prevEmptyAll = false
  let prevResultCount = 0

  while (turn < TURNS) {
    turn++
    const res = await post(messages)
    peak = Math.max(peak, res.bytes)
    if (crossedAt === null && res.bytes > THRESHOLD) crossedAt = turn

    if (!res.ok) {
      emit({ ...meta, turn, kind: 'error', status: res.status, err: res.err, bytes: res.bytes })
      console.log(`turn ${String(turn).padStart(3)}  ERROR ${res.status}  ${String(res.err).slice(0, 140)}`)
      stopped = res.rate ? 'rate-limit' : 'error'
      break
    }

    const above = res.bytes > THRESHOLD
    const callRecs = classifyTurn(res.calls, state, {
      turn, bytes: res.bytes, above, finish: res.finish,
      covered: covered.size, prevEmptyAny, prevEmptyAll, prevResultCount
    })
    for (const r of callRecs) records.push(r)

    const dupsHere = callRecs.filter(r => r.dup).length
    const inMsgHere = callRecs.filter(r => r.inMessageDup).length
    emit({
      ...meta, turn, kind: 'turn', bytes: res.bytes, above,
      finish: res.finish,
      calls: callRecs.map(r => ({
        name: r.name, sig: r.sig, dup: r.dup, dupOfTurn: r.dupOfTurn, inMessageDup: r.inMessageDup,
        gapTurns: r.gapTurns, gapDistinct: r.gapDistinct, distinctTargetsCovered: r.distinctTargetsCovered
      })),
      dups: dupsHere,
      inMessageDups: inMsgHere,
      prevEmptyAny, prevEmptyAll,
      distinctTargetsCovered: covered.size,
      textLen: (res.text || '').length,
      text: (res.text || '').slice(0, 400),
      usage: res.usage
    })
    console.log(
      `turn ${String(turn).padStart(3)}  ${String(res.bytes).padStart(7)}B${above ? '*' : ' '}  ` +
      `calls=${String(res.calls.length).padStart(2)} dup=${dupsHere} inmsg=${inMsgHere}  ` +
      `cov=${String(covered.size).padStart(2)}/${ALL_PATHS.length}  ${res.finish || '-'}  ` +
      `${res.calls.map(c => c.name).join(',') || '(text)'}`
    )

    if (!res.calls.length) {
      // The model answered. If it stopped early the task is not done, so the user
      // nudges it — which is what a real user does, and it is recorded.
      messages.push(adapter.assistant(res.text, []))
      messages.push(adapter.user(NUDGE))
      emit({ ...meta, turn, kind: 'nudge' })
      prevEmptyAny = false; prevEmptyAll = false; prevResultCount = 0
      continue
    }

    messages.push(adapter.assistant(res.text, res.calls))
    const pairs = res.calls.map(c => {
      const r = execute(c.name, c.args)
      // Task progress, the variable the arms have to be matched on — not the
      // turn index, which is confounded by the ledger's own size. Only files
      // whose CONTENT was surfaced count: scanning the body for any path that
      // appears in it let one `Glob src/**/*.js` jump progress to 21/23 without
      // the model having read a single line.
      for (const covPath of r.paths || []) covered.add(covPath)
      return { id: c.id, body: r.body, empty: r.empty }
    })
    for (const m of adapter.results(pairs)) messages.push(m)
    prevResultCount = pairs.length
    prevEmptyAny = pairs.some(p => p.empty)
    prevEmptyAll = pairs.every(p => p.empty)
  }

  // --- summary ------------------------------------------------------------
  const total = records.length
  const dups = records.filter(r => r.dup).length
  const inMsg = records.filter(r => r.inMessageDup).length
  const belowRecs = records.filter(r => !r.above)
  const aboveRecs = records.filter(r => r.above)
  const inWin = records.filter(r => r.dup && r.gapDistinct !== null && r.gapDistinct <= LEDGER_WINDOW)
  const outWin = records.filter(r => r.dup && r.gapDistinct !== null && r.gapDistinct > LEDGER_WINDOW)
  const afterEmpty = records.filter(r => r.prevEmptyAny)
  const afterFull = records.filter(r => !r.prevEmptyAny && r.prevResultCount > 0)
  const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a'

  const summary = {
    ...meta,
    turns: turn,
    stopped,
    upstreamRequests: SPEND,
    retries: RETRIES,
    totalCalls: total,
    distinctCalls: state.distinctCalls,
    // The corpus separator: distinct/total is 0.62 in high-duplicate sessions and
    // 0.99 in low-duplicate ones. If a run comes back near 1.0 the task did not
    // put the model in the revisiting regime, and a null from it means nothing.
    distinctRatio: total ? state.distinctCalls / total : null,
    duplicates: dups,
    dupRate: total ? dups / total : null,
    inMessageDuplicates: inMsg,
    distinctTargetsCovered: covered.size,
    repoFiles: ALL_PATHS.length,
    peakBytes: peak,
    crossedThresholdAtTurn: crossedAt,
    below: { calls: belowRecs.length, dups: belowRecs.filter(r => r.dup).length },
    above: { calls: aboveRecs.length, dups: aboveRecs.filter(r => r.dup).length },
    ledgerWindow: LEDGER_WINDOW,
    dupsInWindow: inWin.length,
    dupsOutOfWindow: outWin.length,
    afterEmptyResult: { calls: afterEmpty.length, dups: afterEmpty.filter(r => r.dup).length },
    afterNonEmptyResult: { calls: afterFull.length, dups: afterFull.filter(r => r.dup).length }
  }
  emit({ kind: 'summary', ...summary })

  console.log('')
  console.log(`ARM ${ARM}  path=${PATH_KEY}  task=${task.id}(${task.name}) seed=${SEED}  stopped=${stopped}  upstream=${SPEND}`)
  console.log(`turns ${turn}  calls ${total}  distinct ${state.distinctCalls} (ratio ${summary.distinctRatio === null ? 'n/a' : summary.distinctRatio.toFixed(2)})`)
  console.log(`cross-turn duplicates ${dups} = ${pct(dups, total)}    in-message repeats ${inMsg} (recorded, not counted)`)
  console.log(`peak request ${peak} B   crossed ${THRESHOLD} B at turn ${crossedAt === null ? 'NEVER' : crossedAt}   coverage ${covered.size}/${ALL_PATHS.length}`)
  console.log(`  below threshold: ${belowRecs.filter(r => r.dup).length}/${belowRecs.length} = ${pct(belowRecs.filter(r => r.dup).length, belowRecs.length)}`)
  console.log(`  above threshold: ${aboveRecs.filter(r => r.dup).length}/${aboveRecs.length} = ${pct(aboveRecs.filter(r => r.dup).length, aboveRecs.length)}`)
  console.log(`  duplicates within ${LEDGER_WINDOW} distinct calls of the original: ${inWin.length}; beyond it: ${outWin.length}`)
  console.log(`  after EMPTY result: ${afterEmpty.filter(r => r.dup).length}/${afterEmpty.length} = ${pct(afterEmpty.filter(r => r.dup).length, afterEmpty.length)}`)
  console.log(`  after non-empty   : ${afterFull.filter(r => r.dup).length}/${afterFull.length} = ${pct(afterFull.filter(r => r.dup).length, afterFull.length)}`)
  if (out) out.end()
}

module.exports = {
  execute, readFile, runBash, grepRepo, globRepo,
  norm, globToRegExp, globMatches, scopeMatches,
  sigOf, canon, collapseToOneLine, classifyTurn,
  buildTask, INVARIANTS, IMPORTS,
  REPO, ALL_PATHS, ALL_MODULES, HITS, lineCount,
  EMPTY_BASH, NO_MATCH, READ_MAX_LINES,
  SELF_TEST_CASES, selfTestFacts, runSelfTest,
  anthropic, openai
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
