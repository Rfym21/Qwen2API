# Qwen2API

Reverse proxy that exposes Qwen chat through OpenAI-compatible and Anthropic-compatible endpoints, rotating several Qwen accounts behind one API key.

## Language

### Usage accounting

**Upstream usage**:
The token counts Qwen itself reports in an SSE frame's `usage` field (cumulative per attempt).
_Avoid_: real usage, Qwen usage, actual tokens

**Estimated usage**:
Token counts produced by the local tokenizer when no upstream usage arrived for the response.
_Avoid_: fallback usage, computed usage, approximate tokens

**Reported usage**:
The `usage` object the proxy sends to the client; sourced from upstream usage, falling back to estimated usage.
_Avoid_: response usage, final usage, client usage

**Attempt**:
One upstream generation round for a single client request. A request may run several attempts when the runtime retries (missing tool call, empty output, tool error).
_Avoid_: retry, round, pass

### Egress

**Egress**:
The network identity an upstream request leaves through: the account's proxy, or the host's own connection ("direct"). Qwen's WAF judges by egress IP, never by account.
_Avoid_: proxy (when the IP is meant), exit, route

**Burnt egress**:
An egress whose IP currently gets a parse challenge. Every account behind it fails the same way until the challenge clears or the egress changes.
_Avoid_: banned IP, blocked account, bad account

### WAF challenges

**WAF challenge**:
Qwen's anti-bot answering an upstream request with a verification demand instead of a result. Comes in two kinds: parse challenge and chat challenge.
_Avoid_: captcha error, ban, account verification

**Parse challenge**:
A WAF challenge on a document parse: a captcha page instead of a result. Happens per egress and clears after a few quiet minutes.
_Avoid_: parse down, parse outage, 500, ban

**Chat challenge**:
A WAF challenge on chat generation itself (Qwen's wording: "被挤爆啦", retry later). Follows the time of day, not the account or the egress; creating the chat and uploading files still succeed.
_Avoid_: context too large, account needs verification, upstream error

### Upstream failures

**Quota exhaustion**:
Qwen refusing this account for a period: the daily allowance is spent, or it is rate-limiting the account outright. It clears on a clock, not by retrying, and a fresh account serves the same request unchanged.
_Avoid_: captcha, ban, server error (a rate limit and a spent allowance are the same thing to us — the proxy cannot tell them apart, and both mean "rest this account")

**Overloaded upstream**:
The upstream is temporarily unable to serve this request at all — a WAF challenge on parse or chat, or a context attachment that could not be uploaded. Nothing about the request is wrong and the same account may serve it minutes later.
_Avoid_: quota, rate limit, bad account, upstream error

**Upstream failure classification**:
The proxy's single reading of why an upstream exchange failed — quota exhaustion, overloaded upstream, transport interruption, or unclassified — which every client surface then states in its own vocabulary.
_Avoid_: error code, upstream status, error type
