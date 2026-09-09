#!/usr/bin/env node
'use strict'
/**
 * probe-agent-loop.js — live agent-loop protocol probe.
 *
 * The other probes in this directory all test image delivery and context size.
 * None of them tests the tool protocol, which is the part Claude Code actually
 * lives on. This one does, against real Qwen, on both API paths.
 *
 * Cells (one printed line each, PASS/FAIL + the observed value):
 *   A  one tool round-trip: model calls Read, gets a tool_result, answers from it
 *   B  correlation: five Read calls with different paths, then "what did the
 *      SECOND one return?" — FAIL if it re-reads instead of using the result
 *   C  repetition: a successful Bash call comes back, the next turn must not
 *      re-issue the identical call
 *   D  stop_reason: tool_use on a tool turn, end_turn on a final answer
 *   E  every emitted tool_use id carries the path's native prefix
 *   F  no tool-protocol marker leaks into visible text — the BARE forms
 *      ([TOOL CALL] / [END TOOL CALL] / <agent_final>) and the NUMBERED family
 *      ([TOOL CALL #3] / [END TOOL CALL #3]). foldToolMessages writes the
 *      numbered opener into every folded history block, so this cell is also
 *      the acceptance gate for the open question: does Qwen imitate the
 *      ordinal? The printed value is the exact text that leaked, so a PASS
 *      means "not imitated or fully consumed" and a FAIL names the form.
 *   G  the same six cells against /v1/chat/completions (call_ prefix, tool_calls)
 *
 * D, E and F are read off the responses A/B/C already paid for — the probe
 * spends four model calls per path, eight in total.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 KEY=sk-... MODEL=qwen3-max \
 *     node tools/dev-probes/probe-agent-loop.js
 *
 * Optional: MAX_TOKENS (default 512 — enough headroom that a truncated turn
 * does not make cell D fail for the wrong reason).
 */

const BASE_URL = process.env.BASE_URL
const KEY = process.env.KEY
const MODEL = process.env.MODEL
if (!BASE_URL || !KEY || !MODEL) {
  console.error('need BASE_URL, KEY and MODEL in the environment')
  process.exit(2)
}
const BASE = BASE_URL.replace(/\/$/, '')
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 512)

// Distinct, unguessable payloads: the model has to correlate, not pattern-match.
const FILES = [
  { path: '/srv/probe/alpha.txt', body: 'SENTINEL-ONE-4718' },
  { path: '/srv/probe/bravo.txt', body: 'SENTINEL-TWO-2093' },
  { path: '/srv/probe/charlie.txt', body: 'SENTINEL-THREE-8354' },
  { path: '/srv/probe/delta.txt', body: 'SENTINEL-FOUR-6620' },
  { path: '/srv/probe/echo.txt', body: 'SENTINEL-FIVE-1175' }
]
const BASH_CMD = 'git status --short'
const BASH_OUT = '?? notes.txt'
// </agent_final> is the same leak class as its opener, so it is in the list too.
//
// Patterns, not literals: the folded history teaches `[TOOL CALL #n]`, and the
// natural imitation mirrors the ordinal onto the closer (`[END TOOL CALL #3]`).
// A literal scan reports "clean" on exactly the form that leaked in production,
// which is how the blind spot survived the unit suite in the first place. The
// decoration class stops at ']' and at the end of the line so a marker mentioned
// inside a sentence still gets named rather than swallowing the sentence.
const LEAK_PATTERNS = [
  // `(?!\()` drops `[tool calls](https://…)`, an ordinary markdown link. The parser
  // deliberately refuses this lookahead (a stream can split before the '(' and the two
  // parse paths would then disagree — tool-prompt.js:78-81); the probe sees whole
  // responses, so here it is safe and it keeps the gate from failing on prose.
  ['tool-call marker', /\[[ \t]{0,4}tool[ \t_-]{1,2}calls?[^\]\r\n]{0,24}\](?!\()/gi],
  ['tool-call closer', /\[[ \t]{0,4}(?:end[ \t_-]{1,2}|\/[ \t]{0,4})tool[ \t_-]{1,2}calls?[^\]\r\n]{0,24}\]/gi],
  ['agent_final', /<\/?[ \t]{0,4}agent_final[^>\r\n]{0,24}>/gi]
]

const READ_DESC = 'Read a file from disk'
const BASH_DESC = 'Run a shell command'
const READ_SCHEMA = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
const BASH_SCHEMA = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }

const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}
const sig = (call) => `${call.name}|${canon(call.args ?? {})}`
// 24 hex chars, same shape as the real ids. Collisions among cell B's five
// synthetic ids would break the very correlation this probe measures.
const hex12 = () => require('crypto').randomBytes(12).toString('hex')

// --- adapters -------------------------------------------------------------
// Everything path-specific lives here; the cells below are written once.

const anthropic = {
  key: 'anthropic',
  path: '/v1/messages',
  idPrefix: /^toolu_/,
  toolFinish: 'tool_use',
  finalFinish: 'end_turn',
  headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
  mkId: () => `toolu_${hex12()}`,
  body: (messages) => ({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: false,
    messages,
    tools: [
      { name: 'Read', description: READ_DESC, input_schema: READ_SCHEMA },
      { name: 'Bash', description: BASH_DESC, input_schema: BASH_SCHEMA }
    ]
  }),
  parse: (j) => {
    const blocks = Array.isArray(j?.content) ? j.content : []
    return {
      text: blocks.filter(b => b?.type === 'text').map(b => String(b.text || '')).join(''),
      calls: blocks.filter(b => b?.type === 'tool_use').map(b => ({
        id: String(b.id || ''), name: String(b.name || ''), args: b.input ?? {}, raw: JSON.stringify(b.input ?? {})
      })),
      finish: j?.stop_reason ?? null
    }
  },
  user: (text) => [{ role: 'user', content: [{ type: 'text', text }] }],
  assistantCalls: (calls) => [{
    role: 'assistant',
    content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} }))
  }],
  results: (pairs) => [{
    role: 'user',
    content: pairs.map(p => ({ type: 'tool_result', tool_use_id: p.id, content: p.body }))
  }]
}

const openai = {
  key: 'openai',
  path: '/v1/chat/completions',
  idPrefix: /^call_/,
  toolFinish: 'tool_calls',
  finalFinish: 'stop',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  mkId: () => `call_${hex12()}`,
  body: (messages) => ({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: false,
    messages,
    tools: [
      { type: 'function', function: { name: 'Read', description: READ_DESC, parameters: READ_SCHEMA } },
      { type: 'function', function: { name: 'Bash', description: BASH_DESC, parameters: BASH_SCHEMA } }
    ]
  }),
  parse: (j) => {
    const choice = j?.choices?.[0] || {}
    const msg = choice.message || {}
    const list = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      calls: list.map(c => {
        const raw = typeof c?.function?.arguments === 'string'
          ? c.function.arguments
          : JSON.stringify(c?.function?.arguments ?? {})
        let args
        try { args = JSON.parse(raw || '{}') } catch (_) { args = null }
        return { id: String(c?.id || ''), name: String(c?.function?.name || ''), args, raw }
      }),
      finish: choice.finish_reason ?? null
    }
  },
  user: (text) => [{ role: 'user', content: text }],
  assistantCalls: (calls) => [{
    role: 'assistant',
    content: null,
    tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) } }))
  }],
  results: (pairs) => pairs.map(p => ({ role: 'tool', tool_call_id: p.id, content: p.body }))
}

// --- transport ------------------------------------------------------------
// One retry, then give up. Every run costs real Qwen quota.

async function post (adapter, messages) {
  const payload = JSON.stringify(adapter.body(messages))
  let last = 'no attempt'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}${adapter.path}`, { method: 'POST', headers: adapter.headers, body: payload })
      const raw = await r.text()
      let json = null
      try { json = JSON.parse(raw) } catch (_) { json = null }
      if (r.ok && json) return { ok: true, status: r.status, err: null, ...adapter.parse(json) }
      last = `HTTP ${r.status} ${raw.replace(/\s+/g, ' ').slice(0, 120)}`
    } catch (e) {
      last = `fetch ${e.message}`
    }
  }
  return { ok: false, status: 0, err: last, text: '', calls: [], finish: null }
}

const mkCall = (adapter, name, args) => ({ id: adapter.mkId(), name, args, raw: JSON.stringify(args) })

// --- cells ----------------------------------------------------------------

async function runPath (adapter, prefix) {
  const seen = []          // { cell, response } — cells E and F read this back
  const cells = []
  const record = (cell, response) => { seen.push({ cell, response }); return response }
  const emit = (id, title, pass, observed) => {
    cells.push(Boolean(pass))
    console.log(`${`${prefix}${id} [${adapter.key}] ${title}`.padEnd(52)} ${pass ? 'PASS' : 'FAIL'}  ${observed}`)
  }

  // A — one tool round-trip.
  const askRead = `Read the file ${FILES[0].path} and then reply with its exact contents and nothing else.`
  const a1 = record('A', await post(adapter, adapter.user(askRead)))
  const a1Read = a1.calls.find(c => c.name === 'Read')
  let a2 = null
  if (a1Read) {
    a2 = record('A', await post(adapter, [
      ...adapter.user(askRead),
      ...adapter.assistantCalls([a1Read]),
      ...adapter.results([{ id: a1Read.id, body: FILES[0].body }])
    ]))
  }
  const aSentinel = Boolean(a2 && a2.text.includes(FILES[0].body))
  const aPass = Boolean(a1Read && a2 && a2.ok && a2.calls.length === 0 && aSentinel)
  emit('A', 'one tool round-trip', aPass, a1.ok
    ? (a1Read
        ? `turn1=Read turn2-calls=${a2.calls.length} sentinel=${aSentinel ? 'yes' : 'no'} ${a2.ok ? '' : `err=${a2.err}`}`.trim()
        : `turn1 emitted no Read (calls=${a1.calls.map(c => c.name).join(',') || 'none'})`)
    : `err=${a1.err}`)

  // B — five Read calls, then "what did the SECOND one return?".
  // The prompt deliberately does NOT say "do not read again": that would test
  // instruction-following, not whether the results are addressable.
  const bCalls = FILES.map(f => mkCall(adapter, 'Read', { file_path: f.path }))
  const b = record('B', await post(adapter, [
    ...adapter.user(`Read these five files: ${FILES.map(f => f.path).join(', ')}`),
    ...adapter.assistantCalls(bCalls),
    ...adapter.results(bCalls.map((c, i) => ({ id: c.id, body: FILES[i].body }))),
    ...adapter.user('What were the exact contents returned by the SECOND Read call? Reply with only those contents.')
  ]))
  const bHit = FILES.map((f, i) => (b.text.includes(f.body) ? i : -1)).filter(i => i >= 0)
  const bReread = b.calls.some(c => c.name === 'Read')
  const bPass = b.ok && !bReread && bHit.length === 1 && bHit[0] === 1
  emit('B', 'second-of-five result is addressable', bPass, b.ok
    ? (bReread
        ? `re-read instead of using the result (calls=${b.calls.length})`
        : `matched=[${bHit.map(i => i + 1).join(',') || 'none'}] want=[2]`)
    : `err=${b.err}`)

  // C — a successful Bash result comes back; the identical call must not repeat.
  const cCall = mkCall(adapter, 'Bash', { command: BASH_CMD })
  const c = record('C', await post(adapter, [
    ...adapter.user(`Run \`${BASH_CMD}\` and tell me whether the working tree is clean.`),
    ...adapter.assistantCalls([cCall]),
    ...adapter.results([{ id: cCall.id, body: BASH_OUT }])
  ]))
  const cRepeat = c.calls.some(x => sig(x) === sig(cCall))
  emit('C', 'no identical re-issue after a result', c.ok && !cRepeat, c.ok
    ? `calls=${c.calls.map(x => x.name).join(',') || 'none'} identical-repeat=${cRepeat ? 'yes' : 'no'}`
    : `err=${c.err}`)

  // D — finish reason on a tool turn vs a final answer.
  const dTool = a1.ok ? a1.finish : `err(${a1.err})`
  const dFinal = a2 ? (a2.ok ? a2.finish : `err(${a2.err})`) : '(skipped)'
  emit('D', 'finish reason tool turn / final turn',
    dTool === adapter.toolFinish && dFinal === adapter.finalFinish,
    `tool=${dTool} want=${adapter.toolFinish} | final=${dFinal} want=${adapter.finalFinish}`)

  // E — id namespace. A vacuous pass would hide a path that emitted nothing,
  // so "no ids at all" counts as FAIL.
  const ids = seen.flatMap(s => s.response.calls.map(c => c.id))
  const badId = ids.find(id => !adapter.idPrefix.test(id))
  emit('E', `tool id prefix ${adapter.idPrefix.source}`,
    ids.length > 0 && badId === undefined,
    ids.length === 0 ? 'no tool ids observed' : `n=${ids.length} ${badId === undefined ? `sample=${ids[0]}` : `bad=${badId}`}`)

  // F — protocol residue in delivered text. The observed value carries the exact
  // leaked text (not just the cell), because whether the ordinal shows up in it is
  // the one question the unit suite cannot answer.
  const leaks = []
  for (const { cell, response } of seen) {
    for (const [, pattern] of LEAK_PATTERNS) {
      for (const hit of String(response.text || '').match(pattern) || []) {
        leaks.push(`${cell}:${JSON.stringify(hit)}`)
      }
    }
  }
  const numbered = leaks.filter(l => /#[ \t]{0,2}\d/.test(l))
  emit('F', 'no protocol markers in visible text', leaks.length === 0,
    leaks.length === 0
      ? `clean over ${seen.length} responses`
      : `leaks=${[...new Set(leaks)].join(' ')}${numbered.length ? ' ORDINAL-IMITATED' : ''}`)

  return cells
}

;(async () => {
  console.log(`probe-agent-loop  base=${BASE} model=${MODEL} max_tokens=${MAX_TOKENS}`)
  const results = []
  results.push(...await runPath(anthropic, ''))
  // G — the same cells on the OpenAI path, with its own id prefix and finish reasons.
  results.push(...await runPath(openai, 'G-'))
  const pass = results.filter(Boolean).length
  console.log(`CELLS: ${pass}/${results.length} PASS`)
  process.exitCode = pass === results.length ? 0 : 1
})().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exitCode = 2
})
