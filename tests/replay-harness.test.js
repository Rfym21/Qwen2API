'use strict'

// The replay harness is the instrument the duplicate-rate claim rests on. An
// instrument with no tests is an assertion, not a measurement — and every case
// below pins a defect that a design review actually found in it.

const test = require('node:test')
const assert = require('node:assert/strict')

const H = require('../tools/dev-probes/replay-duplicates.js')

const mkList = (n) => Array.from({ length: n }, (_, i) => ({ i, gap: i, collisions: 0, target: `t${i}` }))

test('selectDeterministic: the ceiling is applied DURING selection, not by slicing after', () => {
  // The bug: select a stride over all 81, then .slice(0, 30) -> the EARLIEST 30
  // onsets, i.e. a head sample of the session, while the printed message claims
  // it merely "trims the sample". An agent that raises --limit for coverage and
  // hits the quota ceiling would get the opposite of what it asked for.
  const list = mkList(81)
  const capped = H.selectDeterministic(list, 200, 0, 30)
  assert.equal(capped.length, 30)
  const headSample = list.slice(0, 30).map((s) => s.i)
  assert.notDeepEqual(capped.map((s) => s.i), headSample, 'capped selection must not be the head of the list')
  // A real spread reaches the end of the session, not just its first third.
  assert.ok(capped[capped.length - 1].i > 60, `expected spread to reach the tail, got ${capped[capped.length - 1].i}`)
  // And it must equal asking for that many directly.
  assert.deepEqual(capped.map((s) => s.i), H.selectDeterministic(list, 30, 0).map((s) => s.i))
})

test('selectDeterministic: no scenario is picked twice at any offset', () => {
  for (const off of [0, 1, 13, 40, 80]) {
    const picked = H.selectDeterministic(mkList(81), 20, off)
    assert.equal(picked.length, 20)
    assert.equal(new Set(picked.map((s) => s.i)).size, 20, `offset ${off} produced a duplicate`)
  }
})

test('selectStratified: refuses more than per-target scenarios from one cluster', () => {
  // 30 onsets, only 2 targets: an unstratified stride returns 20 pseudo-replicates
  // of 2 situations and a naive CI over them is a confident wrong answer.
  const list = Array.from({ length: 30 }, (_, i) => ({ i, gap: i, collisions: i % 5, target: i % 2 ? 'a.js' : 'b.js' }))
  const { picked } = H.selectStratified(list, { limit: 6, maxCalls: 30, strata: 'gap', perTarget: 2, seedOffset: 0, preferCollisions: true })
  const counts = picked.reduce((a, s) => (a[s.target] = (a[s.target] || 0) + 1, a), {})
  for (const [t, n] of Object.entries(counts)) assert.ok(n <= 2, `target ${t} appeared ${n} times, cap was 2`)
})

test('selectStratified: a binding per-target cap returns FEWER scenarios and reports it', () => {
  // Quietly topping the sample back up from the same file would restore the
  // count while destroying the property the cap buys: the count would look like
  // 8 and behave like 2. Returning 4 with a declared shortfall is the honest
  // answer, and the caller can raise --per-target deliberately.
  const list = Array.from({ length: 30 }, (_, i) => ({ i, gap: i, collisions: 0, target: i % 2 ? 'a.js' : 'b.js' }))
  const { picked, clusters, shortfall } = H.selectStratified(list, { limit: 8, maxCalls: 30, strata: 'gap', perTarget: 2, seedOffset: 0, preferCollisions: true })
  assert.equal(picked.length, 4, '2 targets x cap 2 = 4, not 8')
  assert.equal(clusters, 2)
  assert.equal(shortfall, 4)
  const counts = picked.reduce((a, s) => (a[s.target] = (a[s.target] || 0) + 1, a), {})
  for (const n of Object.values(counts)) assert.equal(n, 2)
})

test('selectStratified: spreads across gap quartiles instead of session position', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ i, gap: i, collisions: 0, target: `t${i}` }))
  const { picked } = H.selectStratified(list, { limit: 8, maxCalls: 30, strata: 'gap', perTarget: 3, seedOffset: 0, preferCollisions: true })
  const gaps = picked.map((s) => s.gap)
  assert.ok(Math.min(...gaps) < 10, 'low-gap quartile unrepresented')
  assert.ok(Math.max(...gaps) >= 30, 'high-gap quartile unrepresented')
})

test('selectStratified: honours the max-calls ceiling as well as the limit', () => {
  const list = mkList(40)
  const { picked } = H.selectStratified(list, { limit: 30, maxCalls: 5, strata: 'gap', perTarget: 3, seedOffset: 0, preferCollisions: true })
  assert.equal(picked.length, 5)
})

test('classify: TRUNCATED is keyed on output tokens, NOT on stop_reason', () => {
  // stop_reason is itself under test: the truncation-precedence fix makes a cut
  // off tool turn report max_tokens where the pre-fix build reports tool_use.
  // Keying the verdict on it would let a fix under test decide the
  // classification and bias the very comparison this harness exists to make.
  const opts = { maxTokens: 100 }
  const atCap = { calls: [{ name: 'Read', args: { file_path: '/a' } }], usage: { output_tokens: 100 } }
  const preFix = H.classify({ ...atCap, stop: 'tool_use' }, new Set(), 'x', opts)
  const postFix = H.classify({ ...atCap, stop: 'max_tokens' }, new Set(), 'x', opts)
  assert.equal(preFix.verdict, 'TRUNCATED')
  assert.equal(postFix.verdict, 'TRUNCATED')
  assert.equal(preFix.verdict, postFix.verdict, 'the two arms must classify identical output identically')
})

test('classify: an uncapped turn is judged on what it emitted', () => {
  const opts = { maxTokens: 2048 }
  const sig = H.sigOf('Read', { file_path: '/a' })
  const prefix = new Set([sig])
  const repeated = H.classify({ calls: [{ name: 'Read', args: { file_path: '/a' } }], usage: { output_tokens: 10 } }, prefix, sig, opts)
  assert.equal(repeated.verdict, 'REPEATED')
  assert.equal(repeated.repeatedExpected, true)
  const movedOn = H.classify({ calls: [{ name: 'Read', args: { file_path: '/b' } }], usage: { output_tokens: 10 } }, prefix, sig, opts)
  assert.equal(movedOn.verdict, 'MOVED_ON')
  const answered = H.classify({ calls: [], text: 'done', usage: { output_tokens: 10 } }, prefix, sig, opts)
  assert.equal(answered.verdict, 'ANSWERED')
})

test('classify: argument key order does not decide whether a call is a repeat', () => {
  const opts = { maxTokens: 2048 }
  const sig = H.sigOf('Read', { a: 1, b: 2 })
  const res = H.classify({ calls: [{ name: 'Read', args: { b: 2, a: 1 } }], usage: { output_tokens: 5 } }, new Set([sig]), sig, opts)
  assert.equal(res.verdict, 'REPEATED')
})

test('residueOf: protocol markers delivered as prose are detected', () => {
  // An ANSWERED cell that actually leaked `[TOOL CALL]` is a call the parser
  // failed to lift, not a model that reused the earlier result. The numbered
  // closer fix changes parsing, so the arms can differ here on identical output.
  assert.equal(H.residueOf('all done'), false)
  assert.equal(H.residueOf('text [END TOOL CALL] more'), true)
  assert.equal(H.residueOf('[TOOL CALL #3]'), true)
  assert.equal(H.residueOf('see [TOOL RESULT #2: Read]'), true)
  assert.equal(H.residueOf('<agent_final>x</agent_final>'), true)
})

test('mcnemarExact: matches the exact binomial tail', () => {
  assert.ok(Math.abs(H.mcnemarExact(10, 0) - 0.001953125) < 1e-9)
  assert.ok(Math.abs(H.mcnemarExact(9, 1) - 0.021484375) < 1e-9)
  assert.ok(Math.abs(H.mcnemarExact(8, 2) - 0.109375) < 1e-9)
  assert.equal(H.mcnemarExact(0, 0), 1)
  // Symmetric: the test is two-sided, so direction must not change the p-value.
  assert.equal(H.mcnemarExact(3, 7), H.mcnemarExact(7, 3))
})

test('targetOf: paging one file at many offsets is ONE cluster, not many', () => {
  const a = H.targetOf({ command: "sed -n '300,350p' /repo/src/Shell.tsx" })
  const b = H.targetOf({ command: "sed -n '250,300p' /repo/src/Shell.tsx" })
  assert.equal(a, b)
  assert.equal(a, 'Shell.tsx')
  // And a Read of the same file is the same situation as sed-ing it.
  assert.equal(H.targetOf({ file_path: '/repo/src/Shell.tsx' }), 'Shell.tsx')
})

test('targetOf: fileless commands do not all collapse into one bucket', () => {
  const a = H.targetOf({ command: 'tail -500 /tmp/server.log' })
  const b = H.targetOf({ command: 'docker ps -a' })
  assert.notEqual(a, b)
  assert.notEqual(a, '<none>')
  assert.notEqual(b, '<none>')
  // but the same command at different numeric arguments still collapses
  assert.equal(H.targetOf({ command: 'tail -500 /tmp/server.log' }), H.targetOf({ command: 'tail -200 /tmp/server.log' }))
})

test('annotate: collisions count same-tool different-argument calls in between', () => {
  // This is the root-cause-1 dose. Zero collisions means the numbering fix has
  // nothing to disambiguate and the cell can only ever exercise the ledger.
  const mk = (name, input) => ({ name, input, sig: H.sigOf(name, input), mi: 0 })
  const parsed = {
    calls: [
      mk('Read', { file_path: '/a' }),   // 0  <- anchor
      mk('Read', { file_path: '/b' }),   // 1  collision
      mk('Bash', { command: 'ls' }),     // 2  different tool, not a collision
      mk('Read', { file_path: '/c' }),   // 3  collision
      mk('Read', { file_path: '/a' })    // 4  <- onset
    ],
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }]
  }
  parsed.calls.forEach((c) => { c.mi = 1 })
  const a = H.annotate(parsed, { i: 4, j: 0 })
  assert.equal(a.collisions, 2)
  assert.equal(a.gap, 4)
  assert.equal(a.mutationBetween, false)
})

test('annotate: a mutating call in between marks the repeat as possibly CORRECT', () => {
  const mk = (name, input) => ({ name, input, sig: H.sigOf(name, input), mi: 1 })
  const parsed = {
    calls: [mk('Read', { file_path: '/a' }), mk('Edit', { file_path: '/a' }), mk('Read', { file_path: '/a' })],
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }]
  }
  const a = H.annotate(parsed, { i: 2, j: 0 })
  assert.equal(a.mutationBetween, true, 're-reading after an edit is correct behaviour, not the failure under test')
})

test('annotate: an empty decision-point result is flagged', () => {
  const mk = (name, input) => ({ name, input, sig: H.sigOf(name, input), mi: 1 })
  const parsed = {
    calls: [mk('Bash', { command: 'x' }), mk('Bash', { command: 'x' })],
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: '(Bash completed with no output)' }] }]
  }
  assert.equal(H.annotate(parsed, { i: 1, j: 0 }).decisionResultEmpty, true)
})

test('parseSse: streaming tool calls are reconstructed with their arguments', () => {
  // Production streams. A harness that only ever measured the non-streaming
  // path is not evidence about the shipped one.
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`
  const raw =
    ev({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) +
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } }) +
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path"' } }) +
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"/a"}' } }) +
    ev({ type: 'content_block_stop', index: 0 }) +
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })
  const out = H.parseSse(raw)
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].name, 'Read')
  assert.deepEqual(out.calls[0].args, { file_path: '/a' })
  assert.equal(out.stop, 'tool_use')
  assert.equal(out.usage.output_tokens, 7)
})

test('parseSse: text deltas are concatenated and unparseable arguments are preserved', () => {
  const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
  const raw =
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }) +
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } }) +
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 'Bash' } }) +
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{oops' } }) +
    ev({ type: 'content_block_stop', index: 1 })
  const out = H.parseSse(raw)
  assert.equal(out.text, 'hello')
  assert.equal(out.calls[0].args.__unparseable, '{oops')
})

test('ledgerAnchor: reports whether the about-to-be-repeated call survived the ledger cap', () => {
  // When the anchor has been evicted by the 6000-byte cap, the ledger half of
  // the treatment is switched OFF for that cell and nothing in the response
  // reveals it. Without this field a treated cell is indistinguishable from an
  // untreated one.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'body of a' }] }
  ]
  const hit = H.ledgerAnchor(messages, 'Read', { file_path: '/a.js' })
  assert.equal(hit.present, true)
  assert.ok(hit.bytes > 0)
  const miss = H.ledgerAnchor(messages, 'Read', { file_path: '/never-called.js' })
  assert.equal(miss.present, false)
})

test('ledgerAnchor: no tool history means no ledger and no anchor', () => {
  const out = H.ledgerAnchor([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'Read', { file_path: '/a' })
  assert.equal(out.present, false)
  assert.equal(out.bytes, 0)
})

test('parseArgs: the budget cannot be raised past the externalisation threshold', () => {
  // Above 90 KiB the proxy uploads the context as a document, which is a
  // different subsystem. Measuring repetition across that boundary would
  // silently change what is under test.
  assert.throws(() => H.parseArgs(['--budget', '120']), /externalisation threshold/)
  assert.equal(H.parseArgs(['--budget', '90']).budgetKib, 90)
})

test('parseArgs: defaults target the population the numbering fix is aimed at', () => {
  const o = H.parseArgs([])
  // No built-in transcript default: transcripts are the operator's own sessions, so the harness
  // refuses to run rather than shipping somebody's absolute path. --transcript / TRANSCRIPT supply it.
  assert.equal(o.transcript, '', 'there must be no hardcoded transcript path')
  assert.match(H.parseArgs(['--transcript', '/tmp/s.jsonl']).transcript, /s\.jsonl$/)
  assert.equal(o.resultCap, 1200, 'the p90 real result is 980 B and must survive intact')
  assert.equal(o.strata, 'gap')
  assert.equal(o.perTarget, 3)
})
