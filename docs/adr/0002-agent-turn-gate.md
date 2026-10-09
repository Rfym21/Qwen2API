# One gate decides whether an agent turn is acceptable

Status: accepted

"Is this upstream attempt acceptable?" used to be answered in four places — the
OpenAI runtime and three loops inside the two controllers — in two reason
vocabularies, with attempt budgets that meant two different things. The rule that
kept the copies equal lived in comments: seventy-two of them said "twin of …,
both parts must change together", and where a comment could not be trusted, a
test read the source file as text and matched a literal. The cost was paid by
whoever fixed the next defect: a tool loop or a malformed call was found once and
fixed once per surface and once per streaming mode, and a fix that landed in one
copy left the others shipping the old rule.

We decided that one pure function owns the decision. An attempt snapshot and the
surface's policy go in; one verdict comes out. Nothing else about a turn is the
gate's business: the loops keep their budgets, their mutable flags and their
delivery machinery, and each surface keeps how it reads its own stream and how it
states the verdict in its own wire vocabulary — the split ADR 0001 established
for failures.

## The verdict

```
gate(snapshot, policy) -> {
  verdict: 'accept' | 'retry',
  finishReason,          // on accept
  reason,                // the vocabulary token, on retry
  suppressVisibleText,   // on accept: this attempt's text must not be delivered
}
```

There is no `fail(code)`. "Attempts exhausted" is a property of the loop's
budget, not of the attempt, so the gate cannot see it; and the terminal codes are
wire vocabulary, which belongs to the surfaces. A gate that could fail would pull
`502 invalid_tool_call` or `502 upstream_agent_turn_incomplete` back into a shared
module, which is the leak ADR 0001 spent a change removing.

## The snapshot, and the one field that matters

One snapshot describes exactly one attempt. The field that makes the streaming
and non-streaming loops the same decision is `callsDelivered`: true once a
`tool_use` block has reached the client, because a snapshot cannot retract what
the client already holds. Everything else the two loops differ in — which tool
calls they have merged, which text they judge — is an input difference, not a
rule difference, and the parity test asserts that on the wire.

Facts that span attempts stay in the loops: the protocol-recovery allowance and
whether any text was ever delivered. The gate sees one attempt.

## The vocabulary

One token set, one meaning each: `empty`, `bare`, `invalid_control`,
`required_tool`, `tool_error`, `prose_with_tools`, `intercepted`,
`malformed_protocol`, `thought_tool_call`, `missing_tool`. The true synonym pair
merges (`required` / `required_tool`). The OpenAI surface's `invalid_tool_call`
splits into `tool_error` plus the `prose_with_tools` token, because merging them
whole would silently widen a rule — that token covers two different conditions.
Tokens only one surface can emit stay that surface's: `bare`, `invalid_control`
and `prose_with_tools` are OpenAI-only; `thought_tool_call` and `missing_tool`
are Anthropic-only.

Both maps keyed by that vocabulary live with the gate: the retry hint and the
exhausted-turn message. The module defines what a reason *is*, so "and here is
what we tell the model" belongs beside it. The retry hint text unifies across
surfaces — a decided consequence, not a side effect: the OpenAI surface's
tool-error hint gained the appendix naming unknown tool names and invalid
arguments, which is the only text that makes an invented name recoverable.

## Policy as named fields, not a rule list

Per-surface differences enter as named fields, never as an ordered precedence
array — a rule engine nobody can debug at 3am. Four of them, each a real
difference between shipping surfaces:

| field | OpenAI | Anthropic |
|---|---|---|
| `proseWithTools` | retry | accept |
| `acceptBareFinal` | config-driven | n/a (no bare-final concept) |
| `toolErrorsBeforeRequired` | tool errors veto first | `required_tool` first |
| `toolErrorsVetoWithCalls` | a parsed call beside a tool error is retried | accepted; the good call ships |

The last one is not decoration. An Anthropic client receives discrete `tool_use`
blocks and can act on what arrived; an OpenAI client receives a `tool_calls`
array it executes as a set, so a partial set is a silently wrong action rather
than a partial one. That is why these are policy and not drift.

## Where the gate stops and delivery starts

The gate owns the stateless per-attempt decision to withhold an attempt's text.
Everything mid-stream stays in the handlers: the text-channel runaway guard, the
output suppressors, banked narration. Those are byte-position mechanics —
consequences of bytes already gone — not of a turn verdict. Both surfaces express
the same intent by different means (OpenAI retracts a buffer; the Anthropic
stream never writes), and nobody should unify two things that differ because the
streams do.

## `empty` is attempt-scoped, and it is invisible

The streaming Anthropic gate read text accumulated across attempts; the
non-streaming one read the round's own text. The unified rule is attempt-scoped.
This was expected to be a named behaviour change and is not one: whenever the two
rules would disagree the accumulated text is non-empty, and at that same moment
the loop's compensation guard is already evaluating that same text, so it has
either broken the loop or spent its one post-text retry. Measured on the
characterisation corpus: mutating the judgement leaves all 64 cells
byte-identical. It ships as an internal cleanup, and a diff there is a finding.

## Consequences

- A new acceptance rule, or a change to one, ships once. That was the point.
- The terminal rule — a finish the upstream already explained is accepted — now
  sits explicitly in the gate rather than being one surface's first statement and
  the other's implicit fall-through. The OpenAI surface consequently retries a
  terminal round whose `tool_choice` went unsatisfied, where it used to deliver.
  The conservative rule is the one the Anthropic surfaces already shipped.
- A spent protocol-recovery allowance stops the *retry* for malformed residue; it
  does not stop the suppression of that residue from a delivered round. Getting
  this wrong once put protocol bytes back in front of the client.
- The characterisation corpus (`tests/agent-turn-corpus.test.js`) freezes the
  observable outcome of every decided case across four handler cells. It records
  the wire finish reason only through `delivered`, and no scenario ends on a
  terminal finish — a coverage hole, not a blind spot, and worth closing.

## Superseded in part: the loop-unification plan

`spec-qwen2api-unify-agent-loop.md` (lohari repository, 2026-08-31, `status:
draft`, branch never created, never executed) planned one loop engine behind
per-surface adapters. Its loop half stays valid in intent and unexecuted; this
ADR does not do it and does not pre-empt it. Two of its constraints are overruled
here: it forbade harmonising the per-surface asymmetries, and this change makes
them named policy instead, because an undocumented difference cannot be told from
drift. Its stale claims are corrected: the constants it counted as six copies are
one, and `requiresToolCall` is three copies of which one died with the
unreachable path.

## Considered options

- **Merge only the two near-copy Anthropic loops** — rejected as insufficient:
  it would leave the OpenAI surface's decision separate, so a new rule still had
  two homes, and the vocabulary would still have two spellings.
- **One gate with one policy** — rejected: the four differences above are real,
  and flattening them would change what a client receives on one surface or the
  other. One implementation, not one policy.
- **Wait for the loop unification** — rejected: the loop engine is a larger
  change, and the decision is the half that defects keep being fixed in.
