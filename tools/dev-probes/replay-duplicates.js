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
 * WHAT COUNTS AS A DUPLICATE-ONSET POINT
 *
 *   cross  (default) call[i] is byte-identical (name + canonical arguments) to
 *          some earlier call[j], and the message before call[i] is the user
 *          message carrying tool_result. The replayed prefix therefore ends at
 *          exactly the decision point where the real model chose to repeat.
 *   strict            call[i] is byte-identical to call[i-1] — the model called,
 *          got the result, and immediately re-issued the same call.
 *
 * READ THIS BEFORE TRUSTING A NUMBER. In the reference transcript there is
 * exactly ONE strict-immediate onset and 177 eligible cross onsets. The figure
 * "326 immediate repeats" is a whole-corpus number (192 sessions, 15,337 calls),
 * not a property of this file. `--mode strict` here has a sample size of 1 and
 * is useful only as a spot check; `--mode cross` is the arm with statistical
 * power, and it is the default.
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
 * CLASSIFICATION (exactly one per scenario)
 *   REPEATED  emitted a tool_use byte-identical to a call already answered in
 *             the replayed prefix
 *   MOVED_ON  emitted tool_use, none of them a repeat
 *   ANSWERED  text only, no tool_use
 *   ERROR     non-2xx or unparseable — status and body recorded
 *
 * Selection is deterministic: no RNG anywhere. The same invocation picks the
 * same scenarios on every run and in every arm, which is the only way the
 * pre-fix and post-fix numbers are comparable.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3010 KEY=sk-... MODEL=qwen3.8-max \
 *     node tools/dev-probes/replay-duplicates.js --limit 20 --out arm.jsonl
 *
 *   node tools/dev-probes/replay-duplicates.js --dry-run    (no env, no spend)
 *
 * Flags:
 *   --transcript FILE  JSONL session to replay (default: the lohari session)
 *   --mode cross|strict
 *   --limit N          scenarios to run (default 20)
 *   --seed-offset K    rotate the deterministic selection (default 0)
 *   --max-calls N      hard ceiling on upstream requests (default 30)
 *   --budget KIB       per-request byte budget (default 48, threshold is 90)
 *   --result-cap N     truncate each tool_result body to N chars (default 400)
 *   --think-cap N      truncate each thinking block to N chars (default 400)
 *   --no-thinking      drop inbound thinking blocks entirely
 *   --max-tokens N     response cap (default 1024)
 *   --out FILE         write one JSONL record per scenario
 *   --dry-run          print the selection and shapes, send nothing
 */

const fs = require('fs')

const DEFAULT_TRANSCRIPT =
  '/Users/pedro/.claude/projects/-Users-pedro-Documents-git-NextJS-lohari/' +
  '33f8544e-be41-4d75-82f3-9164085244b5.jsonl'

// --- args -----------------------------------------------------------------

function parseArgs (argv) {
  const o = {
    transcript: DEFAULT_TRANSCRIPT,
    mode: 'cross',
    limit: 20,
    seedOffset: 0,
    maxCalls: 30,
    budgetKib: 48,
    resultCap: 400,
    thinkCap: 400,
    thinking: true,
    maxTokens: 1024,
    out: null,
    dryRun: false
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
      case '--budget': o.budgetKib = num(); break
      case '--result-cap': o.resultCap = num(); break
      case '--think-cap': o.thinkCap = num(); break
      case '--no-thinking': o.thinking = false; break
      case '--max-tokens': o.maxTokens = num(); break
      case '--out': o.out = next(); break
      case '--dry-run': o.dryRun = true; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`unknown flag ${a}`)
    }
  }
  if (o.mode !== 'cross' && o.mode !== 'strict') {
    throw new Error(`--mode must be cross or strict, got ${o.mode}`)
  }
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
    if (ok) eligible.push(o); else droppedNotAfterResult++
  }
  return { all, eligible, droppedNotAfterResult }
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
          text = `${text.slice(0, opts.resultCap)}\n…[truncated by replay harness: ${text.length - opts.resultCap} more chars]`
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

function selectDeterministic (list, limit, offset) {
  const len = list.length
  if (len === 0 || limit <= 0) return []
  const n = Math.min(Math.floor(limit), len)
  const off = ((Math.floor(offset) % len) + len) % len
  const picked = []
  for (let k = 0; k < n; k++) {
    picked.push(list[(Math.floor((k * len) / n) + off) % len])
  }
  return picked
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

function classify (parsedResponse, prefixSigs, expectedSig) {
  const emitted = parsedResponse.calls.map((c) => ({ ...c, sig: sigOf(c.name, c.args) }))
  const repeats = emitted.filter((c) => prefixSigs.has(c.sig))
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

async function post (base, key, body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  let json = null
  try { json = JSON.parse(raw) } catch (_) {}
  // Only a FAILED response may be read as a rate limit. A successful answer
  // whose text happens to contain the words "rate limit" is an answer, not a
  // 429, and aborting the run on it would throw away the arm.
  if (!res.ok && (res.status === 429 || /rate.?limit|upper limit for today/i.test(raw))) {
    throw new RateLimited(`HTTP ${res.status} ${raw.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  if (!res.ok || !json) {
    return { ok: false, status: res.status, body: raw.replace(/\s+/g, ' ').slice(0, 300), text: '', calls: [], stop: null }
  }
  const blocks = Array.isArray(json.content) ? json.content : []
  return {
    ok: true,
    status: res.status,
    body: '',
    text: blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join(''),
    calls: blocks.filter((b) => b && b.type === 'tool_use')
      .map((b) => ({ id: String(b.id || ''), name: String(b.name || ''), args: b.input ?? {} })),
    stop: json.stop_reason ?? null,
    usage: json.usage ?? null
  }
}

// --- main -----------------------------------------------------------------

const HELP = `replay-duplicates.js — replay real duplicate-onset points and see if the model repeats.
See the header comment for the full contract. Common invocations:

  node tools/dev-probes/replay-duplicates.js --dry-run
  BASE_URL=http://127.0.0.1:3010 KEY=sk-... MODEL=qwen3.8-max \\
    node tools/dev-probes/replay-duplicates.js --limit 20 --out arm.jsonl
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
      gap: o.i - o.j,
      tool: parsed.calls[o.i].name,
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

  const selected = selectDeterministic(fits, opts.limit, opts.seedOffset)
  const capped = selected.slice(0, Math.max(0, Math.floor(opts.maxCalls)))
  if (capped.length < selected.length) {
    console.log(`max-calls       ceiling ${opts.maxCalls} trims the sample from ${selected.length} to ${capped.length}`)
  }
  const truncatedResults = capped.reduce((a, s) => a + s.counters.truncatedResults, 0)
  const truncatedThinking = capped.reduce((a, s) => a + s.counters.truncatedThinking, 0)
  const windowed = capped.filter((s) => s.windowed).length
  const maxBytes = capped.reduce((a, s) => Math.max(a, s.bytes), 0)
  console.log(`selected        ${capped.length} scenarios (limit ${opts.limit}, seed-offset ${opts.seedOffset}, deterministic)`)
  console.log(`truncation      ${truncatedResults} tool_result bodies, ${truncatedThinking} thinking blocks; ${windowed}/${capped.length} windowed; largest request ${(maxBytes / 1024).toFixed(1)} KiB`)
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
          tool: s.tool,
          expectedSig: s.expectedSig,
          windowed: s.windowed,
          windowFrom: s.windowFrom,
          requestBytes: s.bytes,
          messageCount: s.messages.length,
          truncatedResults: s.counters.truncatedResults,
          truncatedThinking: s.counters.truncatedThinking,
          request: { model: process.env.MODEL || '<MODEL>', max_tokens: opts.maxTokens, stream: false, messages: s.messages, tools }
        })}\n`)
      }
      const roles = s.messages.map((m) => (m.role === 'user' ? 'u' : 'a')).join('')
      const lastBlocks = [...new Set(s.messages[s.messages.length - 1].content.map((b) => b.type))].join('+')
      console.log(
        `DRY  call#${String(s.onsetCallIndex).padStart(3)} dup-of#${String(s.anchorCallIndex).padStart(3)} gap=${String(s.gap).padStart(3)} ` +
        `${s.tool.padEnd(6)} msgs=${String(s.messages.length).padStart(3)} ${(s.bytes / 1024).toFixed(1).padStart(6)}KiB ` +
        `${s.windowed ? `window@${s.windowFrom}` : 'full-prefix'} ends=${lastBlocks} trunc=${s.counters.truncatedResults} ` +
        `head=${roles.slice(0, 8)}… args=${s.expectedSig.split('|')[1].slice(0, 60)}`
      )
    }
    if (dryOut) await new Promise((r) => dryOut.end(r))
    console.log('')
    console.log(`DRY-RUN: nothing sent. ${capped.length} scenarios would cost ${capped.length} upstream requests.`)
    if (opts.out) console.log(`wrote ${opts.out} (request bodies, dryRun:true)`)
    return
  }

  const BASE_URL = process.env.BASE_URL
  const KEY = process.env.KEY
  const MODEL = process.env.MODEL
  if (!BASE_URL || !KEY || !MODEL) {
    console.error('need BASE_URL, KEY and MODEL in the environment (or pass --dry-run)')
    process.exit(2)
  }
  const base = BASE_URL.replace(/\/$/, '')

  const out = opts.out ? fs.createWriteStream(opts.out, { flags: 'w' }) : null
  const tally = { REPEATED: 0, MOVED_ON: 0, ANSWERED: 0, ERROR: 0 }
  let spent = 0
  let rateLimited = null

  for (const s of capped) {
    const prefixSigs = answeredSigs(s.messages)
    let res
    try {
      res = await post(base, KEY, {
        model: MODEL,
        max_tokens: opts.maxTokens,
        stream: false,
        messages: s.messages,
        tools
      })
      spent++
    } catch (e) {
      if (e instanceof RateLimited) { rateLimited = e.message; break }
      res = { ok: false, status: 0, body: `fetch ${e.message}`, text: '', calls: [], stop: null }
      spent++
    }

    let verdict, emitted, repeats, repeatedExpected
    if (!res.ok) {
      verdict = 'ERROR'; emitted = []; repeats = []; repeatedExpected = false
    } else {
      const c = classify(res, prefixSigs, s.expectedSig)
      verdict = c.verdict; emitted = c.emitted; repeats = c.repeats; repeatedExpected = c.repeatedExpected
    }
    tally[verdict]++

    const detail = verdict === 'ERROR'
      ? `HTTP ${res.status} ${res.body.slice(0, 100)}`
      : verdict === 'ANSWERED'
        ? `text ${JSON.stringify(res.text.slice(0, 70))}`
        : `${emitted.map((c) => c.name).join(',')}${repeatedExpected ? ' (the SAME call the real model re-issued)' : ''}`
    console.log(
      `${verdict.padEnd(9)} call#${String(s.onsetCallIndex).padStart(3)} dup-of#${String(s.anchorCallIndex).padStart(3)} ` +
      `${s.tool.padEnd(6)} ${(s.bytes / 1024).toFixed(1).padStart(6)}KiB ${s.windowed ? 'win ' : 'full'} ` +
      `stop=${String(res.stop ?? '-').padEnd(10)} ${detail}`
    )

    if (out) {
      out.write(`${JSON.stringify({
        transcript: opts.transcript,
        mode: opts.mode,
        model: MODEL,
        onsetCallIndex: s.onsetCallIndex,
        anchorCallIndex: s.anchorCallIndex,
        gap: s.gap,
        tool: s.tool,
        expectedSig: s.expectedSig,
        windowed: s.windowed,
        windowFrom: s.windowFrom,
        requestBytes: s.bytes,
        messageCount: s.messages.length,
        truncatedResults: s.counters.truncatedResults,
        truncatedThinking: s.counters.truncatedThinking,
        verdict,
        repeatedExpected,
        stopReason: res.stop ?? null,
        httpStatus: res.status,
        errorBody: res.ok ? null : res.body,
        emitted: emitted.map((c) => ({ name: c.name, sig: c.sig })),
        repeats: repeats.map((c) => c.sig),
        text: res.ok ? res.text.slice(0, 500) : null,
        usage: res.usage ?? null
      })}\n`)
    }
  }

  if (out) await new Promise((r) => out.end(r))

  const m = tally.REPEATED + tally.MOVED_ON + tally.ANSWERED + tally.ERROR
  const pct = m ? ((tally.REPEATED / m) * 100).toFixed(1) : '0.0'
  console.log('')
  console.log(`REPEATED ${tally.REPEATED}/${m} (${pct}%) | MOVED_ON ${tally.MOVED_ON} | ANSWERED ${tally.ANSWERED} | ERROR ${tally.ERROR}`)
  console.log(`upstream requests spent: ${spent}`)
  if (opts.out) console.log(`wrote ${opts.out}`)

  if (rateLimited) {
    console.error('')
    console.error(`RATE LIMITED — stopped after ${spent} requests, ${m} scenarios classified. Not retrying.`)
    console.error(rateLimited)
    process.exit(3)
  }
}

main().catch((e) => {
  console.error(`FATAL ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
