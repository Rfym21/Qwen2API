#!/usr/bin/env node
'use strict'
/**
 * replay-duplicates.js — does the model actually stop repeating itself?
 *
 * The synthetic probe (probe-agent-loop.js) cannot answer that. Its cells B and
 * C already passed BEFORE the correlation fix landed — C passed vacuously,
 * because the model emitted no calls at all. A probe with no headroom cannot
 * measure a fix. Static analysis shows the addressing information is now present
 * for 100% of duplicate cases; it does not show the model uses it.
 *
 * This harness replays real history instead of inventing it. A recorded Claude
 * Code session that ran through this proxy is a natural experiment: at every
 * point where the model re-issued a call it had already made, we know what the
 * real model did with that exact context. Replay the prefix, look at what comes
 * back now.
 *
 * ---------------------------------------------------------------------------
 * MEASURED 2026-09-08 — READ THIS BEFORE SPENDING A SINGLE REQUEST.
 *
 * THE PRE-FIX ARM DOES NOT REPRODUCE THE BUG. 24 upstream requests, qwen3.8-max,
 * pre-fix service at 309da59 (no numbering, no ledger) and post-fix at 785486d:
 *
 *   arm        stratum                                  REPEATED  tool-emission
 *   pre-fix    95b7b0c1, budget 48, collisions p50=6       0/8          100%
 *   pre-fix    33f8544e, budget 90, collisions p50=44      0/8          100%
 *   post-fix   95b7b0c1, the same 8 byte-identical cells   0/8          100%
 *
 * The null is NOT the vacuous one that made probe cell C worthless. Tool-emission
 * was 100% in every arm: the model engaged on every cell and chose a DIFFERENT
 * call. The instrument was audited against this exact failure mode — prefixSigs
 * held 20-52 signatures per cell and the about-to-be-repeated signature WAS in
 * the set, so a repeat would have been caught. The absence is real.
 *
 * WHY, STRUCTURALLY. Repetition lives in a context regime this replay cannot
 * reach. 100% of runnable onsets are WINDOWED: 0 of 99 fitting onsets in
 * 95b7b0c1 and 4 of 94 in 33f8544e survive as a full prefix even at the 90 KiB
 * ceiling, and those 4 have gap<=6 and collisions<=3 — no headroom by
 * construction. The recorded prefixes run to ~340 KiB, and above 90 KiB the
 * proxy externalises context into an uploaded document, which is a different
 * subsystem. So the window is not a tunable: it is forced, and it removes the
 * accumulated task state. It shows in the output — pre-fix cells answered with
 * `cd … && ls package.json` and `cat package.json`, i.e. the model RE-ORIENTING
 * in a repo it no longer has the history for, not continuing the paging loop
 * that produced the duplicate. MOVED_ON here does not mean "correctly used the
 * numbered result"; it means the replay put the model in a different behavioural
 * regime from the one that was recorded.
 *
 * WHAT THE 24 REQUESTS DID BUY, and it is not nothing:
 *   - No regression, two-sided. 8/8 concordant pairs, discordant b=0 c=0. The
 *     pre-registered upward direction (the ledger PRIMING repeats by printing
 *     the exact strings) did not materialise on this sample.
 *   - The lazy-model risk did not materialise either. The anti-repetition rule
 *     was predicted to buy a fake win by making the model call fewer tools;
 *     instead the post-fix arm emitted MORE calls than pre-fix (11 vs 9) at
 *     identical tool-emission, so the raw metric was not being flattered.
 *   - Prompt cost, measured on real agentic requests rather than a synthetic
 *     one: +6679 input tokens across 8 cells, +15.8% versus pre-fix on
 *     byte-identical request bodies. Larger than the +12.7% measured on a bare
 *     prompt, because the ledger grows with tool history. Any further prompt
 *     growth pays this multiplier on EVERY request.
 *   - Zero protocol residue and zero errors in either arm.
 *
 * DO NOT run the paired A/B on this design expecting a duplicate-rate number.
 * It would spend 40+ requests comparing 0% against 0%. To get headroom, the
 * replay has to keep the full recorded prefix, which means either measuring
 * ON the externalisation path deliberately (a different subject, with its own
 * invariant) or capturing fresh sessions against a live proxy instead of
 * replaying windowed ones. Until one of those exists, the duplicate-rate claim
 * stays UNPROVEN, and that is the honest state to leave it in.
 * ---------------------------------------------------------------------------
 * PRE-REGISTRATION. Fill this in BEFORE spending a request, and do not revise it
 * afterwards. The test is TWO-SIDED. The ledger prints the exact command strings
 * that count as REPEATED, so it is a plausible PRIMING mechanism: REPEATED going
 * UP is a real possible outcome and must not be re-narrated as noise.
 *
 *   H0   post-fix repeat rate == pre-fix repeat rate
 *   H1   post-fix repeat rate != pre-fix repeat rate      (two-sided)
 *   Primary metric   REPEATED / (REPEATED + MOVED_ON)   — see METRIC below
 *   Test             McNemar exact on discordant pairs, two-sided, alpha 0.05
 *   Decision rule    Report the point estimate, the discordant counts b/c and
 *                    the exact p. With the cluster structure below, treat a
 *                    p-value as descriptive, never as proof.
 *
 * POWER, STATED HONESTLY. McNemar on n=20 needs ~9 of 10 discordant pairs to
 * move the same way to clear 0.05. A genuine 50%->25% halving returns
 * NON-significant at that n. Worse, the onsets are not independent draws: in
 * both reference sessions the majority of eligible onsets touch ONE file
 * (lohari 68% AssignmentWizardShell.tsx, qwen2api 80% anthropic.js), so the
 * effective number of independent situations is closer to the distinct-target
 * count than to the scenario count. --per-target exists to attack exactly this
 * and the run prints the realised cluster count. Read that number before
 * believing any p-value.
 * ---------------------------------------------------------------------------
 *
 * WHAT COUNTS AS A DUPLICATE-ONSET POINT
 *
 *   cross  (default) call[i] is byte-identical (name + canonical arguments) to
 *          some earlier call[j], and the message before call[i] is the user
 *          message carrying tool_result. The replayed prefix therefore ends at
 *          exactly the decision point where the real model chose to repeat.
 *   strict            call[i] is byte-identical to call[i-1] — the model called,
 *          got the result, and immediately re-issued the same call.
 *
 * READ THIS BEFORE TRUSTING A NUMBER. In each reference transcript there is
 * roughly ONE strict-immediate onset and ~170 eligible cross onsets. The figure
 * "326 immediate repeats" is a whole-corpus number (192 sessions, 15,337 calls),
 * not a property of any one file. `--mode strict` here has a sample size of ~1
 * and is useful only as a spot check; `--mode cross` is the arm with statistical
 * power, and it is the default.
 *
 * CHOOSING A TRANSCRIPT — THE POPULATION IS PART OF THE EXPERIMENT.
 * Root cause 1 (the headline numbering fix) addresses results that cannot be
 * told apart: N calls to the same tool whose results all read `[TOOL RESULT:
 * <name>]`. A session whose repeats are "Bash returned nothing, try again" is
 * a retry-after-empty-output loop and the numbering fix is inapplicable to it
 * BY CONSTRUCTION. Measured over the eligible-and-fitting onsets of each
 * candidate (`--dry-run --profile` reprints this for any transcript):
 *
 *   session                       fits  decision tool   empty results  ledger live
 *   95b7b0c1 (Qwen2API)  DEFAULT    90  Read 76/Bash 14           7%        18/20
 *   33f8544e (lohari)               81  Bash 69/Read 10          63%        11/20
 *
 * The default is the Read-heavy one: it is the population the fix is aimed at,
 * and its ledger survives the byte cap far more often. The lohari session stays
 * available as a SECOND, SEPARATELY REPORTED stratum — it has more same-name
 * ambiguity but the wrong failure mechanism. NEVER POOL THEM: run the harness
 * once per transcript and report two numbers. Note also that lohari's transcript
 * is contaminated by somebody else's treatment — 7 of its tool_results carry an
 * external "Wasted call — file unchanged since your last Read" hook message.
 *
 * WINDOWING. A late-session prefix is ~340 KiB, far past the 90 KiB threshold
 * at which the proxy externalises context into an uploaded document. That path
 * is not what we are measuring here. So: if the full prefix fits the budget it
 * is sent verbatim; otherwise the request is the first user message (the task)
 * followed by a contiguous tail beginning at the assistant message that carries
 * call[j]. That window always contains the earlier identical call AND the result
 * that answered it, which is the whole precondition for calling a repeat a
 * repeat. Every record says which shape it used, so a sceptic can split on it.
 *
 * THE BUDGET FILTER IS NOT NEUTRAL. `gap` (calls between the original and the
 * repeat) is the DOSE — how much ambiguous history the model must see through —
 * and it correlates with prefix size, so the byte budget preferentially discards
 * the high-dose onsets. Measured: lohari eligible gap p50=94 -> fitting p50=25;
 * qwen2api eligible p50=41 -> fitting p50=12. The experiment therefore studies
 * the EASY half of the population and understates any dose-dependent effect.
 * `--strata gap` spreads the sample across the surviving gap quartiles so at
 * least the retained range is covered evenly; it cannot resurrect what the
 * budget dropped. Raise `--budget` (ceiling 90) to keep more.
 *
 * CLASSIFICATION (exactly one per scenario-trial)
 *   REPEATED   emitted a tool_use byte-identical to a call already answered in
 *              the replayed prefix
 *   MOVED_ON   emitted tool_use, none of them a repeat
 *   ANSWERED   text only, no tool_use
 *   TRUNCATED  the turn hit the output cap — see below; excluded from both
 *              denominators because a turn cut off mid-emission has not chosen
 *   ERROR      non-2xx or unparseable — status and body recorded
 *
 * TRUNCATED IS KEYED ON TOKENS, NOT ON stop_reason, AND THAT IS DELIBERATE.
 * `stop_reason` is itself under test: the truncation-precedence fix makes a cut
 * off tool turn report `max_tokens` where the pre-fix build reports `tool_use`.
 * Keying the verdict on it would let a fix under test change the classification,
 * biasing the very comparison this harness exists to make. `usage.output_tokens`
 * is untouched by that fix, so the cap test is arm-independent. `stopReason` is
 * still recorded, so the disagreement can be audited.
 *
 * METRIC. The headline is REPEATED / (REPEATED + MOVED_ON): of the turns where
 * the model chose to call something, how often was the choice a repeat. The raw
 * REPEATED/all is ALSO printed but is confounded — it falls if the model merely
 * stops calling tools, and the post-fix prompt contains a rule pushing that way,
 * so a lazier model would score as a win. The tool-emission rate is printed
 * separately for exactly that reason.
 *
 * WHAT THIS CANNOT TELL YOU, STATED FOR THE RECORD
 *   - ANSWERED conflates "correctly reused the earlier result" (the win) with
 *     "gave up" and with "emitted a call the parser failed to lift". The `residue`
 *     field and the full `text` are recorded so the three can be separated BY
 *     HAND; nothing here does it automatically. In particular an answer sourced
 *     from the WRONG numbered result still scores ANSWERED, and that is the most
 *     important failure mode the numbering fix could introduce.
 *   - A repeat is not always wrong: re-reading a file after editing it is
 *     correct. `mutationBetween` records whether a state-changing call ran
 *     between j and i so those cells can be split out. It is rare in both
 *     reference sessions (lohari 3/81, qwen2api 6/90) but it is not zero.
 *   - No system prompt is sent and the tool schemas are reconstructed from
 *     observed inputs (generic descriptions, no `required`). Both arms get
 *     byte-identical requests so INTERNAL validity holds, but the absolute
 *     rates are not Claude Code's rates and must never be reported as such.
 *
 * Selection is deterministic: no RNG anywhere. The same invocation picks the
 * same scenarios on every run and in every arm, which is the only way the
 * pre-fix and post-fix numbers are comparable.
 *
 * Usage:
 *   node tools/dev-probes/replay-duplicates.js --dry-run --profile   (no spend)
 *
 *   # pilot: pre-fix arm only, learn whether the bug reproduces at all
 *   BASE_URL=http://127.0.0.1:3010 KEY=sk-... MODEL=qwen3.8-max \
 *     node tools/dev-probes/replay-duplicates.js --limit 6 --out pilot.jsonl
 *
 *   # paired, interleaved: A and B alternate per scenario, same bytes both ways
 *   BASE_URL=http://127.0.0.1:3010 BASE_URL_B=http://127.0.0.1:3011 \
 *   KEY=sk-... MODEL=qwen3.8-max \
 *     node tools/dev-probes/replay-duplicates.js --limit 24 --out paired.jsonl
 *
 * Flags:
 *   --transcript FILE  JSONL session to replay (default: the Qwen2API session)
 *   --mode cross|strict
 *   --limit N          scenarios to run (default 20)
 *   --seed-offset K    rotate the deterministic selection (default 0)
 *   --max-calls N      ceiling on SCENARIOS (default 30); applied during
 *                      selection, so a lowered ceiling still yields a spread
 *   --strata gap|none  spread the sample across gap quartiles (default gap)
 *   --per-target N     max scenarios sharing one target file (default 3, 0=off)
 *   --prefer-collisions  break ties toward onsets with the most same-name
 *                      different-argument calls in between (default on)
 *   --repeat N         trials per scenario per arm (default 1). >1 gives a
 *                      within-arm noise floor and more chances to catch the bug
 *   --budget KIB       per-request byte budget (default 48, threshold is 90)
 *   --result-cap N     truncate each tool_result body to N chars (default 1200)
 *   --think-cap N      truncate each thinking block to N chars (default 400)
 *   --no-thinking      drop inbound thinking blocks entirely
 *   --max-tokens N     response cap (default 2048)
 *   --stream           use the streaming path (what production actually uses)
 *   --out FILE         write one JSONL record per scenario-trial-arm
 *   --dry-run          print the selection and shapes, send nothing
 *   --profile          with --dry-run, print the population profile and exit
 */

const fs = require('fs')
const { buildToolHistoryLedger, canonicalJson, neutraliseUntrustedBody } = require('../../src/utils/agent-turn.js')
const { flattenAnthropicMessages } = require('../../src/controllers/anthropic.js')

const DEFAULT_TRANSCRIPT =
  '/Users/pedro/.claude/projects/-Users-pedro-Documents-git-Prueba-Qwen2API/' +
  '95b7b0c1-da49-459f-8bb3-fab2fd7df7f7.jsonl'

// A call to one of these between j and i means the world may legitimately have
// changed, so re-reading is correct behaviour rather than the failure under test.
const MUTATING = /^(Edit|MultiEdit|Write|NotebookEdit)$/

// --- args -----------------------------------------------------------------

function parseArgs (argv) {
  const o = {
    transcript: DEFAULT_TRANSCRIPT,
    mode: 'cross',
    limit: 20,
    seedOffset: 0,
    maxCalls: 30,
    strata: 'gap',
    perTarget: 3,
    preferCollisions: true,
    repeat: 1,
    budgetKib: 48,
    resultCap: 1200,
    thinkCap: 400,
    thinking: true,
    maxTokens: 2048,
    stream: false,
    out: null,
    dryRun: false,
    profile: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) { throw new Error(`${a} needs a value`) }
      return v
    }
    const num = () => {
      const v = Number(next())
      if (!Number.isFinite(v)) { throw new Error(`${a} needs a number`) }
      return v
    }
    switch (a) {
      case '--transcript': o.transcript = next(); break
      case '--mode': o.mode = next(); break
      case '--limit': o.limit = num(); break
      case '--seed-offset': o.seedOffset = num(); break
      case '--max-calls': o.maxCalls = num(); break
      case '--strata': o.strata = next(); break
      case '--per-target': o.perTarget = num(); break
      case '--no-prefer-collisions': o.preferCollisions = false; break
      case '--repeat': o.repeat = num(); break
      case '--budget': o.budgetKib = num(); break
      case '--result-cap': o.resultCap = num(); break
      case '--think-cap': o.thinkCap = num(); break
      case '--no-thinking': o.thinking = false; break
      case '--max-tokens': o.maxTokens = num(); break
      case '--stream': o.stream = true; break
      case '--out': o.out = next(); break
      case '--dry-run': o.dryRun = true; break
      case '--profile': o.profile = true; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`unknown flag ${a}`)
    }
  }
  if (o.mode !== 'cross' && o.mode !== 'strict') {
    throw new Error(`--mode must be cross or strict, got ${o.mode}`)
  }
  if (o.strata !== 'gap' && o.strata !== 'none') {
    throw new Error(`--strata must be gap or none, got ${o.strata}`)
  }
  if (o.repeat < 1) throw new Error('--repeat must be >= 1')
  // 90 KiB is where the proxy externalises context into an uploaded document,
  // which is a different subsystem with its own invariant. Measuring repetition
  // across that boundary would silently change what is under test.
  if (o.budgetKib > 90) throw new Error('--budget above 90 crosses the externalisation threshold')
  return o
}

// --- canonical signature --------------------------------------------------
// Key order must not decide whether two calls are "the same" call.

function canon (v) {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v === undefined ? null : v)
  }
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}

const sigOf = (name, input) => `${name}|${canon(input ?? {})}`

// The unit of independence. Two onsets that page through the same file are not
// two draws, they are one situation sampled twice; --per-target caps them.
//
// File-level and TOOL-AGNOSTIC on purpose: `Read x.tsx` and `sed -n '20,40p'
// x.tsx` are the same situation, and digits are normalised so that paging the
// same file at twenty different offsets collapses to one cluster rather than
// posing as twenty independent draws. Calls with no file at all fall back to the
// command verb plus its normalised text, because lumping every Bash invocation
// under one `<none>` key would understate independence just as badly as
// overstating it.
function targetOf (input) {
  if (!input || typeof input !== 'object') return '<none>'
  const blob = JSON.stringify(input)
  const m = blob.match(/[\w./-]*\/([\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|ya?ml|py|go|rs|sh))/)
  if (m) return m[1]
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/\d+/g, '#').trim().slice(0, 48)
  if (typeof input.command === 'string' && input.command.trim()) {
    return `cmd:${norm(input.command)}`
  }
  if (typeof input.pattern === 'string' && input.pattern.trim()) {
    return `pat:${norm(input.pattern)}`
  }
  return '<none>'
}

// --- transcript parsing ---------------------------------------------------
// Claude Code writes ONE JSONL record per content block, not per message: a
// turn that thought and then called a tool is two assistant records sharing a
// message.id, and a parallel tool batch is N consecutive user records. Reading
// records as messages produces a transcript where no tool_use is ever preceded
// by its own thinking and no onset is preceded by a tool_result — which is
// exactly the wrong shape to replay. Regroup before doing anything else.

function parseTranscript (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`cannot read transcript ${file}: ${e.message}`)
    console.error('pass --transcript FILE to point at a Claude Code session JSONL.')
    process.exit(2)
  }
  const lines = text.split('\n')
  const raw = []
  let skippedSidechain = 0
  let skippedMeta = 0
  let unparseable = 0
  for (const line of lines) {
    if (!line) continue
    let rec
    try { rec = JSON.parse(line) } catch (_) { unparseable++; continue }
    if (rec.isSidechain === true) { skippedSidechain++; continue }
    if (rec.isMeta === true) { skippedMeta++; continue }
    if (!rec.message || typeof rec.message !== 'object') continue
    const role = rec.message.role
    if (role !== 'user' && role !== 'assistant') continue
    let content = rec.message.content
    if (typeof content === 'string') content = [{ type: 'text', text: content }]
    if (!Array.isArray(content) || content.length === 0) continue
    raw.push({ role, id: rec.message.id || null, content })
  }

  const messages = []
  for (const rec of raw) {
    const prev = messages[messages.length - 1]
    const sameAssistantTurn =
      prev && prev.role === 'assistant' && rec.role === 'assistant' &&
      rec.id && prev.id === rec.id
    const sameResultBatch =
      prev && prev.role === 'user' && rec.role === 'user' &&
      prev.content.every((b) => b.type === 'tool_result') &&
      rec.content.every((b) => b.type === 'tool_result')
    if (sameAssistantTurn || sameResultBatch) {
      prev.content.push(...rec.content)
      continue
    }
    messages.push({ role: rec.role, id: rec.id, content: rec.content.slice() })
  }

  const calls = []
  messages.forEach((m, mi) => {
    if (m.role !== 'assistant') return
    for (const b of m.content) {
      if (b && b.type === 'tool_use') {
        calls.push({
          mi,
          id: String(b.id || ''),
          name: String(b.name || ''),
          input: b.input ?? {},
          sig: sigOf(String(b.name || ''), b.input)
        })
      }
    }
  })

  return {
    messages,
    calls,
    stats: { records: raw.length, messages: messages.length, calls: calls.length, skippedSidechain, skippedMeta, unparseable }
  }
}

// --- onsets ---------------------------------------------------------------

function findOnsets (parsed, mode) {
  const { messages, calls } = parsed
  const firstSeen = new Map()
  const all = []
  calls.forEach((c, i) => {
    if (mode === 'strict') {
      if (i > 0 && calls[i - 1].sig === c.sig) all.push({ i, j: i - 1 })
    } else if (firstSeen.has(c.sig)) {
      all.push({ i, j: firstSeen.get(c.sig) })
    }
    if (!firstSeen.has(c.sig)) firstSeen.set(c.sig, i)
  })
  // The replayed prefix has to END at a real decision point: the model has just
  // been handed a tool_result and picks what to do next. An onset preceded by
  // human text is a different situation and is dropped rather than silently
  // reshaped.
  const eligible = []
  let droppedNotAfterResult = 0
  for (const o of all) {
    const before = messages[calls[o.i].mi - 1]
    const ok = before && before.role === 'user' &&
      before.content.some((b) => b && b.type === 'tool_result')
    if (ok) eligible.push(annotate(parsed, o)); else droppedNotAfterResult++
  }
  return { all, eligible, droppedNotAfterResult }
}

// Everything about an onset that the analyst cannot reconstruct from the JSONL
// afterwards has to be attached here, at selection time, or it is lost.
function annotate (parsed, o) {
  const { calls, messages } = parsed
  const self = calls[o.i]
  // COLLISIONS is the root-cause-1 dose: how many calls to the SAME TOOL with
  // DIFFERENT arguments sit between the original and the repeat. Those are the
  // calls whose results, pre-fix, were all labelled `[TOOL RESULT: <name>]` with
  // nothing to tell them apart. Zero collisions means the numbering fix has
  // nothing to disambiguate and the cell can only exercise the ledger.
  let collisions = 0
  let mutationBetween = false
  for (let k = o.j + 1; k < o.i; k++) {
    if (calls[k].name === self.name && calls[k].sig !== self.sig) collisions++
    if (MUTATING.test(calls[k].name)) mutationBetween = true
  }
  // What the model is looking at when it decides. An empty result means the
  // repeat is a retry-after-no-output, which the numbering fix cannot address.
  const decision = messages[self.mi - 1]
  const resultText = decision.content
    .filter((b) => b && b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string'
      ? b.content
      : Array.isArray(b.content)
        ? b.content.map((x) => (x && x.type === 'text' ? String(x.text || '') : '')).join('')
        : ''))
    .join('\n')
  return {
    ...o,
    gap: o.i - o.j,
    collisions,
    mutationBetween,
    target: targetOf(self.input),
    decisionResultChars: resultText.length,
    decisionResultEmpty: /^\s*$/.test(resultText) || /Bash completed with no output/.test(resultText)
  }
}

// --- block rendering ------------------------------------------------------

function resultText (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b || typeof b !== 'object') return String(b ?? '')
      if (b.type === 'text') return String(b.text || '')
      // An image here would drag the request onto the upload path, which is a
      // different subsystem with its own invariant. Repetition is the subject.
      if (b.type === 'image') return '[image omitted by replay harness]'
      return `[${String(b.type || 'block')} omitted by replay harness]`
    }).join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

function buildMessages (parsed, onset, opts) {
  const { messages, calls } = parsed
  const endExclusive = calls[onset.i].mi
  const anchorMi = calls[onset.j].mi
  const counters = { truncatedResults: 0, truncatedThinking: 0, droppedThinking: 0 }

  const render = (m) => {
    const out = []
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_use') {
        out.push({ type: 'tool_use', id: String(b.id || ''), name: String(b.name || ''), input: b.input ?? {} })
      } else if (b.type === 'tool_result') {
        let text = resultText(b.content)
        if (opts.resultCap > 0 && text.length > opts.resultCap) {
          // A NEUTRAL ellipsis, deliberately. The old banner ("truncated by
          // replay harness: N more chars") is itself a reason to re-fetch: it
          // announces that content is missing, which manufactures the very
          // behaviour being measured. Measured prior-result size at real repeats
          // was p50 897 B / p90 980 B, so the 1200-char default leaves the p90
          // result intact and this branch rarely fires at all.
          text = `${text.slice(0, opts.resultCap)}…`
          counters.truncatedResults++
        }
        const block = { type: 'tool_result', tool_use_id: String(b.tool_use_id || ''), content: text }
        if (b.is_error === true) block.is_error = true
        out.push(block)
      } else if (b.type === 'text') {
        const t = String(b.text || '')
        if (t) out.push({ type: 'text', text: t })
      } else if (b.type === 'thinking') {
        if (!opts.thinking) { counters.droppedThinking++; continue }
        let t = String(b.thinking || '')
        if (!t) continue
        if (opts.thinkCap > 0 && t.length > opts.thinkCap) {
          t = `${t.slice(0, opts.thinkCap)}…`
          counters.truncatedThinking++
        }
        const block = { type: 'thinking', thinking: t }
        if (typeof b.signature === 'string') block.signature = b.signature
        out.push(block)
      } else if (b.type === 'redacted_thinking') {
        if (!opts.thinking) { counters.droppedThinking++; continue }
        out.push({ type: 'thinking', thinking: '[redacted]' })
      }
    }
    return out.length ? { role: m.role, content: out } : null
  }

  const slice = (from) => {
    const out = []
    for (let k = from; k < endExclusive; k++) {
      const m = render(messages[k])
      if (m) out.push(m)
    }
    return out
  }

  const full = slice(0)
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8')
  if (fullBytes <= opts.budgetKib * 1024) {
    return { messages: full, bytes: fullBytes, windowed: false, windowFrom: 0, counters }
  }
  // The full-prefix pass above already ran the renderer over every message, so
  // its truncation tally describes a request we are about to throw away. Only
  // the rendering we actually send may be counted.
  counters.truncatedResults = 0
  counters.truncatedThinking = 0
  counters.droppedThinking = 0
  // Keep the opening task so the model still has a goal, then a contiguous tail
  // starting at the assistant message that made the earlier identical call.
  const tail = slice(anchorMi)
  const head = anchorMi > 0 ? render(messages[0]) : null
  const anchored = head && head.role === 'user' ? [head, ...tail] : tail
  const bytes = Buffer.byteLength(JSON.stringify(anchored), 'utf8')
  return { messages: anchored, bytes, windowed: true, windowFrom: anchorMi, counters }
}

// --- ledger diagnostic ----------------------------------------------------
// The ledger (buildToolHistoryLedger) keeps only the newest entries that fit a
// 6000-byte cap. When the about-to-be-repeated call has been evicted, that half
// of the treatment is SWITCHED OFF for the cell — and nothing in the response
// reveals it. Measured on the default-20 sample: present 18/20 on the Qwen2API
// session but only 11/20 on lohari, where 13/20 ledgers sit at the cap. Without
// this field the analyst cannot tell a treated cell from an untreated one.
//
// Note the scope: this is the LEDGER half only. The numbering fix in
// foldToolMessages has no byte cap and is therefore live on 100% of cells, so
// "the treatment is off" is true of the ledger and false of the numbering.
//
// The real controller flatten is used, not a lookalike, so the diagnostic
// matches what production actually builds.
function ledgerAnchor (messages, expectedName, expectedInput) {
  let ledger
  try {
    ledger = buildToolHistoryLedger(flattenAnthropicMessages(messages)) || ''
  } catch (e) {
    return { present: null, bytes: 0, lines: 0, error: String(e && e.message) }
  }
  if (!ledger) return { present: false, bytes: 0, lines: 0, error: null }
  // The ledger renders `#n <name> <args>` with args truncated and the whole line
  // neutralised, so compare against the same transform and prefix-match to
  // survive the truncation.
  const wantArgs = neutraliseUntrustedBody(canonicalJson(expectedInput ?? {}))
  const lines = ledger.split('\n')
  let present = false
  for (const line of lines) {
    const m = line.match(/^#(\d+)\s+(\S+)\s+(.*)$/)
    if (!m || m[2] !== expectedName) continue
    const got = m[3].split(' -> ')[0].replace(/ \(unanswered; result from #\d+\)$/, '')
    const n = Math.min(got.length, wantArgs.length)
    if (n > 0 && got.slice(0, n) === wantArgs.slice(0, n)) { present = true; break }
  }
  return { present, bytes: Buffer.byteLength(ledger, 'utf8'), lines: lines.length, error: null }
}

// --- tools ----------------------------------------------------------------
// Real names, inferred shapes. A fake name changes what the model is willing to
// do, so the names come straight out of the session.

function buildTools (parsed) {
  const seen = new Map()
  for (const c of parsed.calls) {
    if (!c.name) continue
    if (!seen.has(c.name)) seen.set(c.name, new Map())
    const props = seen.get(c.name)
    const input = c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input : {}
    for (const [k, v] of Object.entries(input)) {
      const t = v === null ? 'null'
        : Array.isArray(v) ? 'array'
          : typeof v === 'number' ? 'number'
            : typeof v === 'boolean' ? 'boolean'
              : typeof v === 'object' ? 'object' : 'string'
      const prior = props.get(k)
      props.set(k, prior === undefined || prior === t ? t : 'mixed')
    }
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, props]) => {
    const properties = {}
    for (const [k, t] of props) {
      properties[k] = (t === 'mixed' || t === 'null') ? {} : { type: t }
    }
    return {
      name,
      description: `${name} tool, as used by the recorded session (schema inferred from observed inputs).`,
      input_schema: { type: 'object', properties, additionalProperties: true }
    }
  })
}

// --- deterministic selection ----------------------------------------------
// floor(k*len/n) for k<n is strictly increasing and collision-free, so adding a
// constant offset modulo len rotates the sample without ever picking the same
// scenario twice. No RNG: both arms must see identical inputs or the comparison
// says nothing.
//
// `cap` is applied HERE and not by slicing the result. Slicing afterwards turns
// a spread sample into a HEAD sample: with 81 fits, `--limit 200 --max-calls 30`
// used to compute a stride over all 81 and then keep the first 30, which is the
// earliest 30 onsets in the session (everything before call#321) rather than 30
// spread across it. An agent that raises --limit for coverage and hits the quota
// ceiling would silently get the opposite of what it asked for.

function selectDeterministic (list, limit, offset, cap = Infinity) {
  const len = list.length
  const want = Math.min(Math.floor(limit), Math.floor(cap))
  if (len === 0 || want <= 0) return []
  const n = Math.min(want, len)
  const off = ((Math.floor(offset) % len) + len) % len
  const picked = []
  for (let k = 0; k < n; k++) {
    picked.push(list[(Math.floor((k * len) / n) + off) % len])
  }
  return picked
}

// Even-stride over session position samples the session, not the phenomenon. In
// both reference transcripts the majority of eligible onsets page through ONE
// file, so a stride returns ~3 behavioural situations sampled 20 times: one
// difference in how the model handles "paging a file" flips a dozen cells at
// once and a naive CI over them is a confident wrong answer.
//
// So: bucket by gap quartile (the dose), take from the buckets round-robin, and
// refuse more than `perTarget` scenarios sharing a target file. Ties inside a
// bucket break toward the highest collision count, which is the onset where the
// numbering fix has the most to disambiguate — the cells with the most headroom
// for the effect under test.
function selectStratified (list, opts) {
  const cap = Math.min(Math.floor(opts.limit), Math.floor(opts.maxCalls))
  if (list.length === 0 || cap <= 0) return { picked: [], clusters: 0 }
  if (opts.strata === 'none' && opts.perTarget <= 0) {
    const picked = selectDeterministic(list, opts.limit, opts.seedOffset, opts.maxCalls)
    return { picked, clusters: new Set(picked.map((s) => s.target)).size, shortfall: cap - picked.length }
  }

  const byGap = [...list].sort((a, b) => a.gap - b.gap || a.i - b.i)
  const buckets = opts.strata === 'gap'
    ? [0, 1, 2, 3].map((q) => byGap.slice(
      Math.floor((q * byGap.length) / 4),
      Math.floor(((q + 1) * byGap.length) / 4)
    ))
    : [byGap]

  // Inside a bucket, richest-in-collisions first; the offset rotates the entry
  // point so --seed-offset still explores a different sample deterministically.
  const ordered = buckets.map((b) => {
    const s = [...b].sort((x, y) =>
      (opts.preferCollisions ? y.collisions - x.collisions : 0) || x.i - y.i)
    if (s.length === 0) return s
    const off = ((Math.floor(opts.seedOffset) % s.length) + s.length) % s.length
    return [...s.slice(off), ...s.slice(0, off)]
  })

  const perTarget = opts.perTarget > 0 ? Math.floor(opts.perTarget) : Infinity
  const used = new Map()
  const picked = []
  const cursors = ordered.map(() => 0)
  // The cap is STRICT: when it binds, the run returns FEWER scenarios and says
  // so. Quietly topping the sample back up with a fourth and fifth onset from
  // the same file would restore the count while destroying the property the cap
  // exists to buy — the count would look like n and behave like the cluster
  // count. A caller who genuinely wants more must raise --per-target on purpose.
  let progress = true
  while (picked.length < cap && progress) {
    progress = false
    for (let b = 0; b < ordered.length && picked.length < cap; b++) {
      const bucket = ordered[b]
      while (cursors[b] < bucket.length) {
        const cand = bucket[cursors[b]++]
        const n = used.get(cand.target) || 0
        if (n >= perTarget) continue
        used.set(cand.target, n + 1)
        picked.push(cand)
        progress = true
        break
      }
    }
  }
  // Session order keeps the printed run readable and comparable across arms.
  picked.sort((a, b) => a.i - b.i)
  return { picked, clusters: new Set(picked.map((s) => s.target)).size, shortfall: cap - picked.length }
}

// --- classification -------------------------------------------------------

function answeredSigs (messages) {
  const byId = new Map()
  const resolved = new Set()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') byId.set(b.id, sigOf(b.name, b.input))
      else if (b.type === 'tool_result') resolved.add(b.tool_use_id)
    }
  }
  const out = new Set()
  for (const id of resolved) {
    const s = byId.get(id)
    if (s) out.add(s)
  }
  return out
}

// Protocol text that reached the client as prose. Two reasons to record it:
// it is a delivery bug in its own right, and it is the only way to tell an
// ANSWERED cell that reasoned from the earlier result from one where the model
// DID emit a call that the parser failed to lift into a tool_use block. The
// numbered-closer fix changes parsing, so the two arms can differ here on
// identical model output; without this field that difference is invisible.
const RESIDUE = /\[TOOL CALL(?: #\d+)?\]|\[END TOOL CALL\]|\[TOOL RESULT(?: #\d+)?:|<\/?agent_final>|<\/?agent_blocked>/
const residueOf = (text) => RESIDUE.test(String(text || ''))

function classify (res, prefixSigs, expectedSig, opts) {
  const emitted = res.calls.map((c) => ({ ...c, sig: sigOf(c.name, c.args) }))
  const repeats = emitted.filter((c) => prefixSigs.has(c.sig))
  // Token-keyed, NOT stop_reason-keyed: see the header. stop_reason is itself
  // changed by the truncation-precedence fix, so keying on it would let a fix
  // under test decide the classification and bias the comparison.
  const outTok = res.usage && Number(res.usage.output_tokens)
  if (Number.isFinite(outTok) && outTok >= opts.maxTokens) {
    return { verdict: 'TRUNCATED', emitted, repeats, repeatedExpected: false }
  }
  if (emitted.length === 0) {
    return { verdict: 'ANSWERED', emitted, repeats, repeatedExpected: false }
  }
  return {
    verdict: repeats.length ? 'REPEATED' : 'MOVED_ON',
    emitted,
    repeats,
    repeatedExpected: emitted.some((c) => c.sig === expectedSig)
  }
}

// --- transport ------------------------------------------------------------

class RateLimited extends Error {}

function shaped (json) {
  const blocks = Array.isArray(json.content) ? json.content : []
  return {
    ok: true,
    status: 200,
    body: '',
    text: blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join(''),
    calls: blocks.filter((b) => b && b.type === 'tool_use')
      .map((b) => ({ id: String(b.id || ''), name: String(b.name || ''), args: b.input ?? {} })),
    stop: json.stop_reason ?? null,
    usage: json.usage ?? null
  }
}

// Production and Claude Code both stream. The fold and the ledger are built in
// buildInternalRequest, upstream of the streaming split, so the TREATMENT is
// identical either way — but delivery and stop_reason have separate code paths
// on each, so a run on the non-streaming path is not evidence about the shipped
// one. --stream measures the shipped one.
function parseSse (raw) {
  const out = { text: '', calls: [], stop: null, usage: null }
  const open = new Map()
  for (const chunk of raw.split('\n\n')) {
    const dataLines = chunk.split('\n').filter((l) => l.startsWith('data:'))
    if (!dataLines.length) continue
    let ev
    try { ev = JSON.parse(dataLines.map((l) => l.slice(5).trim()).join('')) } catch (_) { continue }
    if (ev.type === 'content_block_start' && ev.content_block) {
      if (ev.content_block.type === 'tool_use') {
        open.set(ev.index, { id: String(ev.content_block.id || ''), name: String(ev.content_block.name || ''), json: '' })
      }
    } else if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta') out.text += String(ev.delta.text || '')
      else if (ev.delta.type === 'input_json_delta') {
        const b = open.get(ev.index)
        if (b) b.json += String(ev.delta.partial_json || '')
      }
    } else if (ev.type === 'content_block_stop') {
      const b = open.get(ev.index)
      if (b) {
        let args
        try { args = b.json ? JSON.parse(b.json) : {} } catch (_) { args = { __unparseable: b.json } }
        out.calls.push({ id: b.id, name: b.name, args })
        open.delete(ev.index)
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) out.stop = ev.delta.stop_reason
      if (ev.usage) out.usage = { ...(out.usage || {}), ...ev.usage }
    } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      out.usage = { ...(out.usage || {}), ...ev.message.usage }
    }
  }
  return { ok: true, status: 200, body: '', ...out }
}

async function post (base, key, body, stream) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...body, stream: !!stream })
  })
  const raw = await res.text()
  // Only a FAILED response may be read as a rate limit. A successful answer
  // whose text happens to contain the words "rate limit" is an answer, not a
  // 429, and aborting the run on it would throw away the arm.
  if (!res.ok && (res.status === 429 || /rate.?limit|upper limit for today/i.test(raw))) {
    throw new RateLimited(`HTTP ${res.status} ${raw.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  const fail = () => ({ ok: false, status: res.status, body: raw.replace(/\s+/g, ' ').slice(0, 300), text: '', calls: [], stop: null, usage: null })
  if (!res.ok) return fail()
  if (stream) {
    const parsedSse = parseSse(raw)
    return parsedSse.calls.length || parsedSse.text || parsedSse.stop ? parsedSse : fail()
  }
  let json = null
  try { json = JSON.parse(raw) } catch (_) {}
  return json ? shaped(json) : fail()
}

// --- stats ----------------------------------------------------------------

const q = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

// Exact two-sided McNemar on the discordant pairs: sum of binomial(n, 0.5)
// tails at least as extreme as the observed split. Small n only, which is all
// this harness will ever have.
function mcnemarExact (b, c) {
  const n = b + c
  if (n === 0) return 1
  const lc = (k) => { let s = 0; for (let x = 0; x < k; x++) s += Math.log((n - x) / (x + 1)); return s }
  const lo = Math.min(b, c)
  let tail = 0
  for (let k = 0; k <= lo; k++) tail += Math.exp(lc(k) - n * Math.LN2)
  return Math.min(1, 2 * tail)
}

// --- main -----------------------------------------------------------------

const HELP = `replay-duplicates.js — replay real duplicate-onset points and see if the model repeats.
See the header comment for the full contract, the pre-registration and the caveats.

  node tools/dev-probes/replay-duplicates.js --dry-run --profile
  BASE_URL=http://127.0.0.1:3010 KEY=sk-... MODEL=qwen3.8-max \\
    node tools/dev-probes/replay-duplicates.js --limit 6 --out pilot.jsonl
  BASE_URL=http://127.0.0.1:3010 BASE_URL_B=http://127.0.0.1:3011 KEY=sk-... MODEL=qwen3.8-max \\
    node tools/dev-probes/replay-duplicates.js --limit 24 --out paired.jsonl
`

async function main () {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  if (opts.help) { console.log(HELP); return }

  const parsed = parseTranscript(opts.transcript)
  const { all, eligible, droppedNotAfterResult } = findOnsets(parsed, opts.mode)
  const tools = buildTools(parsed)

  const scenarios = eligible.map((o) => {
    const built = buildMessages(parsed, o, opts)
    return {
      onsetCallIndex: o.i,
      anchorCallIndex: o.j,
      gap: o.gap,
      collisions: o.collisions,
      mutationBetween: o.mutationBetween,
      target: o.target,
      decisionResultChars: o.decisionResultChars,
      decisionResultEmpty: o.decisionResultEmpty,
      tool: parsed.calls[o.i].name,
      expectedName: parsed.calls[o.i].name,
      expectedInput: parsed.calls[o.i].input,
      expectedSig: parsed.calls[o.i].sig,
      ...built
    }
  })
  const fits = scenarios.filter((s) => s.bytes <= opts.budgetKib * 1024)
  const tooBig = scenarios.length - fits.length

  console.log(`transcript      ${opts.transcript}`)
  console.log(`parsed          ${parsed.stats.records} records -> ${parsed.stats.messages} messages, ${parsed.stats.calls} tool calls` +
    ` (skipped ${parsed.stats.skippedSidechain} sidechain, ${parsed.stats.skippedMeta} meta, ${parsed.stats.unparseable} unparseable)`)
  console.log(`mode            ${opts.mode}`)
  console.log(`onsets          ${all.length} total, ${eligible.length} end at a tool_result` +
    ` (${droppedNotAfterResult} dropped), ${fits.length} fit ${opts.budgetKib} KiB (${tooBig} too big)`)
  console.log(`tools           ${tools.map((t) => t.name).join(', ')}`)

  if (opts.profile) {
    // The population profile decides whether this transcript can test the fix at
    // all. Printing it costs nothing and is the cheapest way to avoid spending
    // 40 requests on the wrong natural experiment.
    const ge = eligible.map((s) => s.gap)
    const gf = fits.map((s) => s.gap)
    const byTool = fits.reduce((a, s) => (a[s.tool] = (a[s.tool] || 0) + 1, a), {})
    const byTarget = fits.reduce((a, s) => (a[s.target] = (a[s.target] || 0) + 1, a), {})
    const top = Object.entries(byTarget).sort((a, b) => b[1] - a[1])
    const empty = fits.filter((s) => s.decisionResultEmpty).length
    const cf = fits.map((s) => s.collisions)
    console.log('')
    console.log('POPULATION PROFILE (fitting onsets — the ones that can actually be run)')
    console.log(`  decision tool   ${JSON.stringify(byTool)}`)
    console.log(`  empty results   ${empty}/${fits.length} (${(100 * empty / (fits.length || 1)).toFixed(0)}%) — the numbering fix cannot address these`)
    console.log(`  collisions      p25=${q(cf, 0.25)} p50=${q(cf, 0.5)} p75=${q(cf, 0.75)} max=${Math.max(0, ...cf)}; zero=${cf.filter((x) => x === 0).length}/${cf.length}`)
    console.log(`  gap eligible    p25=${q(ge, 0.25)} p50=${q(ge, 0.5)} p75=${q(ge, 0.75)} max=${Math.max(0, ...ge)}`)
    console.log(`  gap fitting     p25=${q(gf, 0.25)} p50=${q(gf, 0.5)} p75=${q(gf, 0.75)} max=${Math.max(0, ...gf)}  <- the budget drops the high-dose half`)
    console.log(`  distinct targets ${top.length}; top3 ${JSON.stringify(top.slice(0, 3))}`)
    console.log(`  mutation between ${fits.filter((s) => s.mutationBetween).length}/${fits.length} (a repeat here may be CORRECT)`)
    console.log('')
  }

  const { picked: capped, clusters, shortfall } = selectStratified(fits, opts)
  const truncatedResults = capped.reduce((a, s) => a + s.counters.truncatedResults, 0)
  const truncatedThinking = capped.reduce((a, s) => a + s.counters.truncatedThinking, 0)
  const windowed = capped.filter((s) => s.windowed).length
  const maxBytes = capped.reduce((a, s) => Math.max(a, s.bytes), 0)

  // Compute the ledger diagnostic once per scenario: it depends only on the
  // request, which is byte-identical in both arms.
  for (const s of capped) {
    const la = ledgerAnchor(s.messages, s.expectedName, s.expectedInput)
    s.ledgerAnchorPresent = la.present
    s.ledgerBytes = la.bytes
    s.ledgerLines = la.lines
  }
  const anchorYes = capped.filter((s) => s.ledgerAnchorPresent === true).length

  console.log(`selected        ${capped.length} scenarios (limit ${opts.limit}, max-calls ${opts.maxCalls}, strata ${opts.strata}, per-target ${opts.perTarget}, seed-offset ${opts.seedOffset}, deterministic)`)
  console.log(`clusters        ${clusters} distinct targets across ${capped.length} scenarios  <- the honest n for independence`)
  if (shortfall > 0) {
    console.log(`SHORTFALL       asked for ${Math.min(opts.limit, opts.maxCalls)}, got ${capped.length}: --per-target ${opts.perTarget} caps this transcript at that many`)
    console.log(`                distinct onsets. This is the cap doing its job, not a bug. To get more cells,`)
    console.log(`                prefer --repeat (more trials on independent onsets) over --per-target (more`)
    console.log(`                onsets from the SAME file, which adds count without adding independence).`)
  }
  console.log(`ledger anchor   present on ${anchorYes}/${capped.length} (the ledger half of the treatment is OFF on the rest)`)
  console.log(`collisions      p50=${q(capped.map((s) => s.collisions), 0.5)}; zero-collision ${capped.filter((s) => s.collisions === 0).length}/${capped.length} (numbering fix has nothing to disambiguate there)`)
  console.log(`empty results   ${capped.filter((s) => s.decisionResultEmpty).length}/${capped.length}; mutation-between ${capped.filter((s) => s.mutationBetween).length}/${capped.length}`)
  console.log(`truncation      ${truncatedResults} tool_result bodies, ${truncatedThinking} thinking blocks; ${windowed}/${capped.length} windowed; largest request ${(maxBytes / 1024).toFixed(1)} KiB`)
  if (capped.length > 0 && windowed === capped.length) {
    // The header records the measurement: with every cell windowed, both arms
    // came back 0/8 REPEATED at 100% tool-emission, because the window strips
    // the accumulated task state and the model re-orients instead of repeating.
    // Printing it here too so an operator about to spend quota sees it without
    // reading 200 lines of comment first.
    console.log('WARNING         every selected cell is WINDOWED. Measured 2026-09-08: with an all-windowed')
    console.log('                sample the pre-fix arm reproduced the bug 0/8 (and the post-fix arm 0/8),')
    console.log('                because the window removes the task state that drives repetition — the model')
    console.log('                re-orients rather than repeating. A duplicate-RATE comparison on this sample')
    console.log('                is expected to compare 0% against 0%. See MEASURED in the header.')
  }
  console.log('')

  if (opts.dryRun) {
    // --out during a dry run dumps the exact request bodies. That is the only
    // way to inspect what would be sent without spending a single token on it.
    const dryOut = opts.out ? fs.createWriteStream(opts.out, { flags: 'w' }) : null
    for (const s of capped) {
      if (dryOut) {
        dryOut.write(`${JSON.stringify({
          dryRun: true,
          onsetCallIndex: s.onsetCallIndex,
          anchorCallIndex: s.anchorCallIndex,
          gap: s.gap,
          collisions: s.collisions,
          mutationBetween: s.mutationBetween,
          target: s.target,
          tool: s.tool,
          expectedSig: s.expectedSig,
          windowed: s.windowed,
          windowFrom: s.windowFrom,
          requestBytes: s.bytes,
          messageCount: s.messages.length,
          ledgerAnchorPresent: s.ledgerAnchorPresent,
          ledgerBytes: s.ledgerBytes,
          truncatedResults: s.counters.truncatedResults,
          truncatedThinking: s.counters.truncatedThinking,
          request: { model: process.env.MODEL || '<MODEL>', max_tokens: opts.maxTokens, stream: opts.stream, messages: s.messages, tools }
        })}\n`)
      }
      const roles = s.messages.map((m) => (m.role === 'user' ? 'u' : 'a')).join('')
      console.log(
        `DRY  call#${String(s.onsetCallIndex).padStart(3)} dup-of#${String(s.anchorCallIndex).padStart(3)} gap=${String(s.gap).padStart(3)} ` +
        `col=${String(s.collisions).padStart(2)} ${s.tool.padEnd(6)} ${(s.bytes / 1024).toFixed(1).padStart(6)}KiB ` +
        `${s.windowed ? `win@${s.windowFrom}` : 'full'} led=${s.ledgerAnchorPresent ? 'Y' : 'n'} ` +
        `${s.decisionResultEmpty ? 'EMPTY' : `res=${s.decisionResultChars}`} tgt=${s.target.slice(0, 28).padEnd(28)} head=${roles.slice(0, 6)}…`
      )
    }
    if (dryOut) await new Promise((r) => dryOut.end(r))
    const trials = capped.length * opts.repeat * (process.env.BASE_URL_B ? 2 : 1)
    console.log('')
    console.log(`DRY-RUN: nothing sent. ${capped.length} scenarios x ${opts.repeat} trial(s)` +
      `${process.env.BASE_URL_B ? ' x 2 arms' : ''} = ${trials} upstream requests.`)
    if (opts.out) console.log(`wrote ${opts.out} (request bodies, dryRun:true)`)
    return
  }

  const BASE_URL = process.env.BASE_URL
  const BASE_URL_B = process.env.BASE_URL_B || null
  const KEY = process.env.KEY
  const MODEL = process.env.MODEL
  if (!BASE_URL || !KEY || !MODEL) {
    console.error('need BASE_URL, KEY and MODEL in the environment (or pass --dry-run)')
    process.exit(2)
  }
  // Arms INTERLEAVED, not one run then the other. Sequential arms differ in
  // account rotation, upstream drift and time-of-day quota state, and none of
  // that is recoverable afterwards; alternating per scenario spreads any drift
  // across both arms instead of loading it onto the second.
  const arms = [{ arm: 'A', base: BASE_URL.replace(/\/$/, '') }]
  if (BASE_URL_B) arms.push({ arm: 'B', base: BASE_URL_B.replace(/\/$/, '') })

  const out = opts.out ? fs.createWriteStream(opts.out, { flags: 'w' }) : null
  const tallies = new Map(arms.map((a) => [a.arm, { REPEATED: 0, MOVED_ON: 0, ANSWERED: 0, TRUNCATED: 0, ERROR: 0 }]))
  const verdictByKey = new Map()
  let spent = 0
  let rateLimited = null

  outer:
  for (let trial = 0; trial < opts.repeat; trial++) {
    for (const s of capped) {
      const prefixSigs = answeredSigs(s.messages)
      for (const a of arms) {
        const startedAt = Date.now()
        let res
        try {
          res = await post(a.base, KEY, { model: MODEL, max_tokens: opts.maxTokens, messages: s.messages, tools }, opts.stream)
          spent++
        } catch (e) {
          if (e instanceof RateLimited) { rateLimited = e.message; break outer }
          res = { ok: false, status: 0, body: `fetch ${e.message}`, text: '', calls: [], stop: null, usage: null }
          spent++
        }

        let verdict, emitted, repeats, repeatedExpected
        if (!res.ok) {
          verdict = 'ERROR'; emitted = []; repeats = []; repeatedExpected = false
        } else {
          const c = classify(res, prefixSigs, s.expectedSig, opts)
          verdict = c.verdict; emitted = c.emitted; repeats = c.repeats; repeatedExpected = c.repeatedExpected
        }
        tallies.get(a.arm)[verdict]++
        verdictByKey.set(`${a.arm}|${trial}|${s.onsetCallIndex}`, verdict)

        const detail = verdict === 'ERROR'
          ? `HTTP ${res.status} ${res.body.slice(0, 90)}`
          : verdict === 'ANSWERED'
            ? `text ${JSON.stringify(res.text.slice(0, 60))}${residueOf(res.text) ? ' RESIDUE!' : ''}`
            : `${emitted.map((c) => c.name).join(',')}${repeatedExpected ? ' (the SAME call the real model re-issued)' : ''}`
        console.log(
          `${a.arm} t${trial} ${verdict.padEnd(9)} call#${String(s.onsetCallIndex).padStart(3)} ` +
          `gap=${String(s.gap).padStart(3)} col=${String(s.collisions).padStart(2)} led=${s.ledgerAnchorPresent ? 'Y' : 'n'} ` +
          `${s.tool.padEnd(6)} stop=${String(res.stop ?? '-').padEnd(10)} ${detail}`
        )

        if (out) {
          out.write(`${JSON.stringify({
            timestampMs: startedAt,
            durationMs: Date.now() - startedAt,
            arm: a.arm,
            baseUrl: a.base,
            trial,
            transcript: opts.transcript,
            mode: opts.mode,
            model: MODEL,
            stream: opts.stream,
            maxTokens: opts.maxTokens,
            resultCap: opts.resultCap,
            onsetCallIndex: s.onsetCallIndex,
            anchorCallIndex: s.anchorCallIndex,
            gap: s.gap,
            collisions: s.collisions,
            mutationBetween: s.mutationBetween,
            target: s.target,
            decisionResultChars: s.decisionResultChars,
            decisionResultEmpty: s.decisionResultEmpty,
            tool: s.tool,
            expectedSig: s.expectedSig,
            windowed: s.windowed,
            windowFrom: s.windowFrom,
            requestBytes: s.bytes,
            messageCount: s.messages.length,
            ledgerAnchorPresent: s.ledgerAnchorPresent,
            ledgerBytes: s.ledgerBytes,
            ledgerLines: s.ledgerLines,
            truncatedResults: s.counters.truncatedResults,
            truncatedThinking: s.counters.truncatedThinking,
            verdict,
            repeatedExpected,
            stopReason: res.stop ?? null,
            httpStatus: res.status,
            errorBody: res.ok ? null : res.body,
            emitted: emitted.map((c) => ({ name: c.name, sig: c.sig })),
            repeats: repeats.map((c) => c.sig),
            residue: res.ok ? residueOf(res.text) : null,
            // FULL text, not a 500-char slice: separating "reused the earlier
            // result" from "gave up" from "answered off the WRONG numbered
            // result" can only be done by reading it, and the wrong-result case
            // is the most important failure the numbering fix could introduce.
            text: res.ok ? res.text : null,
            usage: res.usage ?? null
          })}\n`)
        }
      }
    }
  }

  if (out) await new Promise((r) => out.end(r))

  console.log('')
  for (const a of arms) {
    const t = tallies.get(a.arm)
    const chose = t.REPEATED + t.MOVED_ON
    const classified = chose + t.ANSWERED
    // PRIMARY: of the turns where the model chose to call something, how often
    // was it a repeat. RAW is printed too but falls when the model merely goes
    // quiet, which the post-fix prompt encourages — so raw alone would score a
    // lazier model as a win.
    const primary = chose ? ((t.REPEATED / chose) * 100).toFixed(1) : 'n/a'
    const raw = classified ? ((t.REPEATED / classified) * 100).toFixed(1) : 'n/a'
    const emis = classified ? ((chose / classified) * 100).toFixed(1) : 'n/a'
    console.log(`arm ${a.arm}  PRIMARY REPEATED/(REPEATED+MOVED_ON) = ${t.REPEATED}/${chose} (${primary}%)`)
    console.log(`arm ${a.arm}  raw REPEATED/classified = ${t.REPEATED}/${classified} (${raw}%) | tool-emission ${emis}% | ` +
      `MOVED_ON ${t.MOVED_ON} ANSWERED ${t.ANSWERED} TRUNCATED ${t.TRUNCATED} ERROR ${t.ERROR}`)
  }

  if (arms.length === 2) {
    // Paired, per scenario-trial. Only cells classified in BOTH arms count.
    let b = 0, c = 0, both = 0
    for (let trial = 0; trial < opts.repeat; trial++) {
      for (const s of capped) {
        const va = verdictByKey.get(`A|${trial}|${s.onsetCallIndex}`)
        const vb = verdictByKey.get(`B|${trial}|${s.onsetCallIndex}`)
        if (!va || !vb) continue
        if (va === 'ERROR' || vb === 'ERROR' || va === 'TRUNCATED' || vb === 'TRUNCATED') continue
        both++
        if (va === 'REPEATED' && vb !== 'REPEATED') b++
        else if (va !== 'REPEATED' && vb === 'REPEATED') c++
      }
    }
    const p = mcnemarExact(b, c)
    console.log('')
    console.log(`paired  ${both} usable pairs; discordant A-only=${b} B-only=${c}; McNemar exact two-sided p=${p.toFixed(4)}`)
    console.log(`        ${clusters} independent target clusters — with this cluster count treat p as DESCRIPTIVE, not proof.`)
  }
  if (opts.repeat > 1) {
    console.log(`        --repeat ${opts.repeat}: compare the same arm's trials against each other for the noise floor before reading any A-vs-B difference.`)
  }
  console.log(`upstream requests spent: ${spent}`)
  if (opts.out) console.log(`wrote ${opts.out}`)

  if (rateLimited) {
    console.error('')
    console.error(`RATE LIMITED — stopped after ${spent} requests. Not retrying.`)
    console.error(rateLimited)
    process.exit(3)
  }
}

// Exported so the analysis and the unit tests can drive the pure parts without
// spending a request. Nothing below runs on require.
module.exports = {
  parseArgs, canon, sigOf, targetOf, parseTranscript, findOnsets, annotate, buildMessages,
  buildTools, selectDeterministic, selectStratified, answeredSigs, classify, residueOf,
  ledgerAnchor, parseSse, mcnemarExact
}

if (require.main === module) {
  main()
    // The Anthropic controller (required for the real flatten used by the ledger
    // diagnostic) leaves handles open, so an explicit exit is needed or the
    // probe hangs after printing its result.
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`FATAL ${e && e.stack ? e.stack : e}`)
      process.exit(1)
    })
}
