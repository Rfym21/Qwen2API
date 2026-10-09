# Upstream failures reach the client classified, not as a blanket 500

Status: accepted

When Qwen refuses a request — quota exhaustion, an overloaded upstream, a dead
transport — the proxy used to answer `500`/`502` with `"Request failed"`, so an
agentic client could not tell "the proxy is broken" from "come back later" and
retried into a wall, burning another account per attempt. We decided that one
classification, computed once in `utils/upstream-error.js`, is what every
surface translates into its own wire vocabulary: quota exhaustion → `429`
(`insufficient_quota` / `rate_limit_error`), overloaded upstream → `529`
(`overloaded_error`) on the Anthropic surface and `503` (`upstream_unavailable`)
on the OpenAI one, transport interruption → `503`, unclassified → `502`.
`Retry-After` is emitted only when the upstream actually supplied a wait.

## Considered options

- **Pass the upstream status through verbatim** — rejected: it hands a Qwen
  `403` to the client as `invalid_request_error`, blaming the caller for
  something the caller did not do. (The CLI surface does pass through; that is
  a separate, pre-existing policy, not the rule.)
- **Keep `500` for anything unclassified** — rejected: `500` means the proxy
  broke. An unclassified upstream refusal is `502`.
- **Read the upstream error body to classify HTTP failures** — rejected for
  now: the request module streams responses and never reads a non-200 body;
  it buys nothing until there is evidence of a body-borne quota on that
  channel.

## Consequences

- An upstream `HTTP 429` is now read as quota exhaustion, so the account that
  served it is marked quota-exhausted and cools down. With no wait in the body
  that means the default one-hour quota cooldown, not an end-of-day ban — a
  transient upstream rate limit therefore rests an account for an hour.
- A quota verdict does **not** yet make the request fail over to another
  account on the non-streaming return path; only the throw path does that.
  Deliberate: failover multiplies upstream calls and is a product decision,
  not part of stating why a failure failed.
- `Retry-After` is never invented. A client that respects an invented wait
  waits for a wall that is not there.

## Where the verdict travels

Two failure channels carry it. The **throw** path already had it (chat
challenge, context attachment, quota-in-a-payload). The **return** path —
`{status: false, response: null}` — now carries it too, on every exit, and the
three callers translate it. A second return-path exit exists deeper in the agent
runtime: when a rejected turn's correction resend cannot even start, its failure
verdict is propagated rather than flattened into an opaque 502. The runtime's
*account failover* exit was listed in the review as a third such site; it is
unreachable (the switch is only entered for quota or chat challenge, both of
which rethrow the original error there), so it was left alone.

`Retry-After` comes from the upstream twice over: `data.num` hours inside a quota
payload, or a `Retry-After` header (seconds) on an HTTP 429. Neither is invented.

## Unproven

Quota has been observed live arriving as an upstream error payload, which the
throw path already classifies. That it can also arrive as a non-200 HTTP
status is asserted, not measured; the mapping above covers it either way. The
same goes for a `Retry-After` header on that channel — handled, never seen.
