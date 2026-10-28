<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

ai-gateway: add one bounded retry for transient upstream 5xx on FIM/edit routes and skip usage parsing of non-JSON error bodies

## Problem

Sentry issue KILOCODE-WEB-1NNV ("FIM provider returned error 503", POST /api/v1/fim/completions) is unresolved and ongoing: 67,491 events and 316 users since 2026-03-31, last seen 2026-10-27. The latest event's captured upstream body is a text/plain edge connection-failure message ("upstream connect error or disconnect/reset before headers. reset reason: remote connection failure") for mistralai/codestral-2508, running in fra1. So the 503 comes from the upstream provider's edge, not from Kilo code. The gateway's handling makes it worse in three ways. First, fim-completions.ts makes one plain `fetch` to the provider with no retry, so a single transient connection reset becomes a failed completion for the user. Second, every such 5xx is reported at level error under a fixed message. Third, the non-streaming usage parser runs `JSON.parse` on the text/plain error body, which throws and adds more Sentry noise ('fim_usage_processing' exception, then 'SUSPICIOUS: No FIM usage information'). edit-completions.ts calls Inception the same way (KILOCODE-WEB-277V "Edit provider returned error 500").

## Evidence

- Sentry KILOCODE-WEB-1NNV (7376729582): 67,491 occurrences, 316 users, first seen 2026-03-31, last seen 2026-10-27, unresolved/ongoing.
- Sentry latest event 2675b2e722834568a90f6dcd2022d0b4: status 503, responseContentType text/plain, first4kOfResponse is an edge 'upstream connect error ... remote connection failure' message, model mistralai/codestral-2508, cloud.region fra1, tag source=openrouter-proxy.
- Triage (Sentry aggregate): over 90 days the same 503 message appears for both mistralai/codestral-2508 and inception/mercury-edit-2, across many releases, at about 23 events/day.
- packages/web-shared/src/lib/ai-gateway/handlers/fim-completions.ts ~L276-341: one bare `fetch(upstreamUrl, ...)`; when status >= 400 it calls captureProxyError with `FIM provider returned error ${status}` and trackInSentry for >= 500; then countAndStoreFimUsage runs and the upstream response is returned as-is.
- packages/web-shared/src/lib/ai-gateway/handlers/edit-completions.ts ~L261-318: the same single-fetch and capture pattern against INCEPTION_EDIT_URL.
- packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.ts: parseMistralFimUsageFromString calls JSON.parse on the whole body with no status guard; on a throw, countAndStoreFimUsage captures an exception and then emits 'SUSPICIOUS: No FIM usage information'.
- packages/web-shared/src/lib/fetchWithBackoff.ts already exists (exponential backoff, configurable retryResponse and maxDelayMs) and is used by providers/upstream-request.ts, but its default 20 s budget is far too long for autocomplete.
- AGENTS.md 'Failure UX': retry transient conditions within a bound, fail fast with a specific reason, and state both effects in verification.
- fim-completions.test.ts already mocks globalThis.fetch, so retry behaviour can be unit-tested there.

## Desired outcome

If the FIM or edit provider fails once in a transient way (502/503/504 or a network-level fetch failure before headers), the gateway retries once after a short delay, so most of these blips no longer reach the editor. If the retry also fails, the editor gets the upstream status straight away, with no extra waiting beyond one short delay. That case is still reported to Sentry, now with the attempt count. Usage accounting no longer throws, and no longer reports duplicate noise, on non-JSON upstream error bodies.

## Scope

- Add a small bounded-retry helper for direct-provider calls (or call fetchWithBackoff with tight options). At most 2 attempts total, retrying only on 502/503/504 and on fetch rejections. Add a short fixed delay (about 100–250 ms), and keep the whole retry budget to about 1 s or less.
- Use it for the upstream call in fim-completions.ts and edit-completions.ts.
- Record the attempt count on the Sentry capture (extra/tag) and on the request span, so persistent provider failures can be told apart from blips.
- Guard non-streaming FIM usage parsing (and the matching edit usage parsing, if it has the same JSON.parse pattern) for status >= 400 and non-JSON bodies. Produce an error usage record (hasError true, zero tokens and cost) without throwing.
- Add unit tests in fim-completions.test.ts (and the edit handler tests, if they exist) covering retry success, retry exhaustion, non-retryable statuses, and parsing of non-JSON error bodies.

## Exclusions

- Changing which upstream provider or endpoint is used, or adding provider failover.
- Changing the chat path (providers/upstream-request.ts) or the OpenRouter proxy.
- Rewriting the upstream error body into a Kilo-shaped payload or adding Retry-After headers. The status passthrough stays as it is.
- Lowering the Sentry level or muting KILOCODE-WEB-1NNV / 277V. Capture stays, but only fires after retries are used up.
- Changing the legacy 'openrouter-proxy' source tag or the streaming 'No usage info in FIM stream' message (an ignored issue, tracked separately).
- Escalating to the provider or investigating with Axiom logs.

## Approach

- Prefer reusing fetchWithBackoff with options { baseDelayMs: ~150, maxDelayMs: ~1000, retryResponse: r => [502,503,504].includes(r.status) }, if its arithmetic gives exactly one retry within that budget. Otherwise add a tiny `fetchDirectProviderWithRetry` helper next to the handlers with an explicit attempt cap of 2. An explicit attempt cap is easier to reason about and test, so it is the preferred fallback.
- Before retrying, drain or cancel the body of the discarded 5xx response so its connection is released.
- Run the retry before emitApiMetricsForResponse, so metrics, usageContext.status_code and Sentry capture all reflect only the final response. Pass the attempt count into captureProxyError's extra data (add an optional field) and set a span attribute such as 'fim.upstream_attempts'.
- Do not retry on 4xx, 500, or other statuses, and do not retry once a response body has started streaming. Retries only happen before headers or on a whole 502/503/504 response, so the client never gets duplicated output.
- In countAndStoreFimUsage's non-stream branch: when statusCode >= 400, or the text does not parse as JSON, return an error MicrodollarUsageStats (hasError true, zero tokens and cost, status_code set) instead of throwing. Billing stays zero, and the parse-error exception plus the 'No FIM usage information' noise go away. Check countAndStoreEditUsage and apply the same guard if it has the same pattern.
- Tests use the existing mockedFetch in fim-completions.test.ts with fake timers or a very short delay.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/handlers/fim-completions.ts
- packages/web-shared/src/lib/ai-gateway/handlers/edit-completions.ts
- packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.ts (captureProxyError extra field, FIM/edit non-stream usage parsing)
- packages/web-shared/src/lib/fetchWithBackoff.ts or a new small retry helper
- packages/web-shared/src/lib/ai-gateway/handlers/fim-completions.test.ts and edit handler tests

## Acceptance criteria

### ac-1: When the first upstream FIM call returns 503 (or 502/504, or fetch rejects before headers) and the second returns 200, the handler returns the 200 response to the client, makes exactly 2 upstream fetch calls, and calls captureProxyError zero times. A unit test asserts this.

**Verification:** Code review

### ac-2: When both attempts return 503, the handler returns the 503 status to the client after exactly 2 fetch calls. It reports to Sentry once, with the existing 'FIM provider returned error 503' message plus an attempt count of 2, and the added wait is bounded by one short delay (about 1 s or less total retry budget, as a code constant). A unit test asserts the call count and the single capture.

**Verification:** Code review

### ac-3: Non-retryable upstream statuses (any 4xx, and 500) produce exactly one upstream fetch call, and behaviour is otherwise unchanged. A unit test covers at least 400 and 500.

**Verification:** Code review

### ac-4: The edit completions route uses the same retry policy, and its tests or source show the same 2-attempt cap and retryable-status set.

**Verification:** Code review

### ac-5: When the non-streaming FIM upstream response has status >= 400 and a text/plain body, usage processing does not throw and does not emit a 'fim_usage_processing' exception or 'SUSPICIOUS: No FIM usage information'. Instead it stores an error usage record with zero cost. A unit test asserts that captureException is not called with that tag.

**Verification:** Code review

### ac-6: After deployment, KILOCODE-WEB-1NNV's event rate in Sentry drops noticeably compared with its roughly 23/day 90-day baseline. Any remaining events carry the attempt count and represent persistent provider failures.

**Verification:** Manual: compare KILOCODE-WEB-1NNV event rate in Sentry for 7 days after deploy against the prior 90-day baseline

## Risks

- Added latency: a failing request now waits up to one short delay plus a second attempt before failing. This is acceptable for autocomplete only if kept to about 1 s or less; the change's verification must state both effects (fewer spurious failures, slightly longer genuine failures).
- Retry amplification during a real provider outage doubles upstream request volume. This is limited by the 2-attempt cap.
- If the editor client already retries 503s, the gateway retry is partly redundant (not verified from this repo).
- Retrying a POST is safe here because FIM/edit completions are idempotent generations and retries only happen before any response body reaches the client. Billing comes only from the final response.

## Assumptions

- The upstream 503s are mostly transient connection resets at the provider edge that often clear within a few hundred milliseconds. This is not verified, because no Axiom logs or provider incident data were available.
- Unit tests for web-shared handlers run through the repository's existing jest setup. web-shared has no test script of its own, so the implementer should pick the right runner using the repository-verification skill.

## Decisions

### d-1: How aggressive should the gateway retry be for latency-sensitive FIM/edit requests?

**Answer:** At most 2 attempts, retrying only on 502/503/504 and network errors before headers, with a short delay of about 100–250 ms and a total budget of about 1 s or less. This is a conservative default under AGENTS.md Failure UX; operators may tune the constants.

**Blocking:** no

### d-2: Should Sentry capture of upstream 5xx be lowered or muted?

**Answer:** No. Keep level error, but capture only after retries are used up and include the attempt count, so the remaining events are actionable.

**Blocking:** no
