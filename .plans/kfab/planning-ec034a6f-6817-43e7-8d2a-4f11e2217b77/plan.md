<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(ai-gateway): treat non-JSON upstream error bodies as error usage rows in edit/FIM accounting instead of SUSPICIOUS alarms

## Problem

Sentry KILOCODE-WEB-277W ("SUSPICIOUS: No edit usage information", POST /api/v1/edit/completions, 47,610 occurrences, 0 users impacted, ongoing since 2026-06-22) is a self-reported error-level alarm from best-effort usage accounting, not a crash. In packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.ts, parseEditUsageFromResponse calls JSON.parse on the upstream body with no guard. When the upstream provider fails with a non-JSON body (an HTML edge error page, a plain-text "upstream connect error ..." / "upstream request timeout" body, or an empty body), the parse throws. countAndStoreEditUsage then sends a SyntaxError captureException (source edit_usage_processing), resolves null, and also emits the SUSPICIOUS captureMessage. One upstream 5xx therefore produces up to three error events, counting captureProxyError's "Edit provider returned error 5xx". The latest event is a 503 from provider inception (inception/mercury-edit-2). Because real lost-usage cases on successful responses go through the same message, the alarm can't be trusted. The non-streamed FIM branch of countAndStoreFimUsage has the same shape: parseMistralFimUsageFromString also dereferences json.usage, so it throws on JSON error bodies too. The embedding parser in the same file already handles this case (parseEmbeddingResponse returns {} for status >= 400 when the body is not JSON).

## Evidence

- sentry: Issue anaconda-nq/7568841932 (KILOCODE-WEB-277W). Message 'SUSPICIOUS: No edit usage information', tag source=edit_usage_processing, level error, 47,610 occurrences, 0 users, first seen 2026-06-22, last seen 2026-10-27. The latest event 392d711a36694e82a8bdda83eed85f1b is a captureMessage with no stack trace. Its usageContext shows status_code 503, provider inception, model inception/mercury-edit-2, isStreaming false, function region sfo1.
- sentry: Errors in kilocode-web with tag source:edit_usage_processing, last 90d, grouped by title: SyntaxError 'Unexpected token '<', "<!DOCTYPE "... is not valid JSON' 1189; SUSPICIOUS message 1141; process.processTicksAndRejections 371; 'Unexpected token 'u', "upstream r"...' 197; 'Unexpected token 'u', "upstream c"...' 120; 'Unexpected end of JSON input' 5; 'TypeError: terminated' 1. Almost every failure is a non-JSON upstream error body.
- file: packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.ts. parseEditUsageFromResponse (~L1287) calls JSON.parse with no guard. countAndStoreEditUsage (~L1322-1362) catches, sends captureException, returns null, then emits captureMessage('SUSPICIOUS: No edit usage information') and skips the usage write.
- file: Same file, parseEmbeddingResponse (~L1400). It wraps JSON.parse and returns {} when statusCode >= 400, with a comment explaining that edge proxies return HTML or empty error bodies. The embedding SUSPICIOUS message fires only when !usage && !hasError.
- file: Same file, countAndStoreFimUsage non-streamed branch (~L1174-1225) and parseMistralFimUsageFromString (~L1049). Both use an unguarded JSON.parse and read json.usage.prompt_tokens directly, so they throw on JSON and non-JSON error bodies alike, then emit 'SUSPICIOUS: No FIM usage information'.
- file: packages/web-shared/src/lib/ai-gateway/handlers/edit-completions.ts (~L269-318). It sets usageContext.status_code from proxyRes.status. It already returns 500 when the upstream body is missing. For status >= 400 it awaits captureProxyError (sent to Sentry for >= 500) and then calls countAndStoreEditUsage on a clone.
- file: packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.test.ts. The edit tests cover the happy path, timing, BYOK/free, and a bodyless 502. The FIM test 'reports a JSON response it cannot parse instead of rejecting' currently expects a TypeError captureException for a JSON 429 error body.
- pull_request: Kilo-Org/cloud#8963 (per triage) made non-streamed FIM read/parse failures report to Sentry with fim_usage_processing, 'like edit'. Reporting genuine read/parse failures is intended. The status-blind SUSPICIOUS emission is the defect.

## Desired outcome

When an upstream edit or non-streamed FIM call returns an HTTP error (status >= 400) with a body that isn't valid usage JSON (HTML, plain text, empty, or a JSON error object), usage accounting records a zero-cost row with hasError=true. This matches what the edit path already does for JSON error bodies. It sends no captureException and no "SUSPICIOUS: No edit/FIM usage information" message. The upstream failure is still reported once, through captureProxyError. Successful responses (status < 400) whose body can't be read or parsed are still reported: captureException plus the error-level SUSPICIOUS message. That keeps the alarm meaningful for possibly lost billable usage.

## Scope

- Edit usage parsing: make parseEditUsageFromResponse (or a small helper it calls) status-aware. If the status is >= 400 and the body is not valid JSON (including the empty string), treat it as an empty error response and return stats with hasError true, zero tokens and zero cost. If the status is < 400, keep throwing.
- FIM non-streamed usage parsing: apply the same guard in parseMistralFimUsageFromString. Also handle a missing json.usage / json.choices without throwing when the status is >= 400, so that JSON error bodies (e.g. 429 {error:...}) and non-JSON error bodies both produce a zero-cost error row.
- Unit tests in llm-proxy-helpers.test.ts covering edit and non-streamed FIM: 503 with an HTML body, 503 with a plain-text body, and an error status with an empty body (no SUSPICIOUS message, no captureException, zero-cost hasError row logged). Also a 200 with an unparseable body (captureException and SUSPICIOUS both still emitted, no usage row). Update the existing FIM 429 test to the new behavior.

## Exclusions

- Changing captureProxyError or how upstream 5xx outages are reported. 'Edit/FIM provider returned error 5xx' stays the single signal for an outage (see #9031 for FIM outage volume).
- Streamed FIM parsing (parseMistralFimUsageFromStream), which already tracks reportedError from statusCode.
- Billing or pricing changes. Error responses stay zero-cost, as they are today for JSON error bodies on edit.
- Retry or fallback behavior toward the upstream provider, and any change to the client-visible response.
- The bodyless-response path (no clonedResponse.body). The edit handler already returns 500 before usage counting when the upstream body is missing, so it is effectively unreachable there. It is left unchanged.

## Approach

- Add a small shared helper in llm-proxy-helpers.ts, e.g. parseUpstreamJsonOrErrorBody<T>(text, statusCode): T | {}. It returns the parsed JSON when the body is valid. On a parse failure it returns {} when statusCode >= 400 and rethrows otherwise. Reuse it from parseEmbeddingResponse if that is a straightforward refactor, or leave parseEmbeddingResponse as-is to keep the diff small.
- parseEditUsageFromResponse: replace the raw JSON.parse with the helper. The rest of the function already copes with a missing usage/model/choices (hasError = !json.model || statusCode >= 400, tokens default to 0).
- parseMistralFimUsageFromString: replace the raw JSON.parse with the helper. Use optional access for json.usage and json.choices, and set tokens and cost to 0 when usage is absent (only call computeFimMicrodollarCost when usage is present). For status < 400 with JSON that has no usage, keep the current behavior of treating it as a failure: throw so the existing captureException and SUSPICIOUS reporting applies. Successful responses without usage stay visible and are never silently billed at zero.
- Leave countAndStoreEditUsage and countAndStoreFimUsage control flow unchanged. Once the parsers stop throwing for error statuses, the catch and the SUSPICIOUS message only fire for genuine read failures (e.g. 'terminated') or successful responses that can't be parsed.
- Add or adjust tests in llm-proxy-helpers.test.ts as described in scope, using the existing waitForUsageWrite / setImmediate pattern and the mocked captureMessage / captureException / logMicrodollarUsage.
- Include 'Fixes KILOCODE-WEB-277W' in the commit/PR so Sentry resolves the issue on merge.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.ts (parseEditUsageFromResponse, parseMistralFimUsageFromString, optional shared parse helper / parseEmbeddingResponse)
- packages/web-shared/src/lib/ai-gateway/llm-proxy-helpers.test.ts (countAndStoreEditUsage and countAndStoreFimUsage suites)
- Indirectly: apps/ai-gateway /api/v1/edit/completions and /api/v1/fim/completions via handleEditCompletionsRequest / handleFimCompletionsRequest (no code changes expected)

## Acceptance criteria

### ac-1: For countAndStoreEditUsage with usageContext.status_code >= 400 and an upstream body that is HTML, plain text, or the empty string: no 'SUSPICIOUS: No edit usage information' captureMessage, no captureException tagged edit_usage_processing, and exactly one logged usage row with hasError true, zero input/output tokens and cost_mUsd 0. Unit tests in llm-proxy-helpers.test.ts cover the 503 HTML and 503 plain-text cases at minimum.

**Verification:** Code review

### ac-2: For the non-streamed countAndStoreFimUsage path with status >= 400 and a JSON error object, HTML, or plain-text body: no 'SUSPICIOUS: No FIM usage information' message, no captureException tagged fim_usage_processing, and one zero-cost hasError usage row logged. The existing FIM 429 test is updated to this behavior.

**Verification:** Code review

### ac-3: For both the edit and non-streamed FIM paths, a response with status < 400 whose body is not valid JSON (or, for FIM, has no usage) still triggers captureException with the existing source tag and the error-level SUSPICIOUS message, and logs no usage row. Unit tests assert this for a 200 with an unparseable body on each path.

**Verification:** Code review

### ac-4: Successful responses with valid usage are billed exactly as before: the existing edit and FIM cost, BYOK/free zeroing, market_cost and timing tests stay unchanged and keep their asserted values.

**Verification:** Code review

### ac-5: After deployment, the KILOCODE-WEB-277W event rate during upstream provider failures drops to near zero, while 'Edit provider returned error 5xx' events keep reporting outages.

**Verification:** Manual: monitor Sentry kilocode-web for source:edit_usage_processing and the SUSPICIOUS message for about a week after release, comparing against captureProxyError 5xx volume

## Risks

- Hiding a real problem: if a provider ever returns status >= 400 together with billable usage in a non-JSON format, it would now be recorded at zero cost silently. This is low risk because error responses are already zero-cost for JSON error bodies, and captureProxyError still reports 5xx.
- FIM behavior change against the intent of #8963: JSON error bodies with status >= 400 used to produce a captureException and now produce a zero-cost error row. The intent of #8963 (don't reject, surface read/parse failures) still holds for successful responses.
- Error usage rows from non-JSON error bodies will now appear in usage tables (hasError true, zero cost) where previously nothing was written. Edit already writes these rows for JSON error bodies, so downstream consumers already handle them.

## Assumptions

- Status codes >= 400 never carry billable usage for the inception/mistral edit and FIM endpoints, consistent with the existing hasError/zero-cost treatment of JSON error bodies.
- Writing a zero-cost hasError usage row for upstream error responses is acceptable and matches existing edit behavior for JSON error bodies.
- The package's existing jest test setup for llm-proxy-helpers.test.ts is the verification vehicle. No configured baseline command was established from the pinned config, so criteria use code review.

## Decisions

### d-1: How should edit/FIM usage accounting treat upstream error responses (status >= 400) whose body can't be parsed as usage JSON?

**Answer:** Mirror the embedding parser: treat the body as an empty error response and log a zero-cost hasError row, with no captureException and no SUSPICIOUS message. Genuine failures on status < 400 keep the current reporting.

**Blocking:** no

### d-2: Should the non-streamed FIM path be fixed in the same change?

**Answer:** Yes. It has the same unguarded parse and SUSPICIOUS shape, and it also throws on JSON error bodies. Fixing both keeps the autocomplete accounting paths consistent.

**Blocking:** no

### d-3: Should captureProxyError's 5xx reporting be reduced as well?

**Answer:** No. It is the single intended outage signal. This change only removes the redundant parse exception and SUSPICIOUS message.

**Blocking:** no
