<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(ai-gateway): fingerprint upstream fetch failure Sentry events by failure family and provider

## Problem

Sentry issue KILOCODE-WEB-28H1 (stub #9033) is titled 'TypeError: fetch failed' at POST /api/v1/chat/completions, with about 1,075 events since 2026-10-27T18:58Z. About 99% of them are undici header timeouts (UND_ERR_HEADERS_TIMEOUT) to the upstream host ai-gateway.vercel.sh, reached through both the `vercel` provider and custom-provider routes for Kilo-exclusive/stealth models such as reflection/beam-free. The gateway already classifies these failures, logs them, and answers with a specific 503 (or 499 when the client disconnected). No gateway logic defect has been shown. The repo defect is in how failures reach Sentry. upstream-request.ts reports every transport failure as a synthetic Error that reuses the original name and message (almost always 'TypeError' / 'fetch failed') and sets no fingerprint. Sentry therefore groups unrelated failure families and providers by stack trace alone. Every new bundle or stack shape creates another identical-looking group: 22 unresolved groups carry source=ai-gateway-upstream-fetch, several with tens of thousands of events. Each new group can open another production-error work item, and the dominant failure is hidden behind a generic title.

## Evidence

- Sentry issue anaconda-nq/7815324948 (KILOCODE-WEB-28H1). Latest event ba9014d23bf148bb8f28c3694f10bd66: tags source=ai-gateway-upstream-fetch, provider=custom, failure_family=headers_timeout, ui.ai_model=reflection/beam-free. Extras: causeCode UND_ERR_HEADERS_TIMEOUT, targetHost ai-gateway.vercel.sh, path /chat/completions, cloud.region sfo1. The stack trace shows only minified Next.js route frames.
- Triage aggregates from Sentry: by failure family, headers_timeout 1,062, connect_timeout 2, unknown 2, conn_reset 1, read_timeout 1. By provider, custom 711, vercel 322, direct-byok 30, openrouter 7. A one-hour burst of 660 events at 2026-10-28T14:00Z was mostly reflection/beam-free. Events span at least eight releases.
- Sentry search tags[source]:ai-gateway-upstream-fetch returns 22 unresolved groups, nearly all titled 'TypeError: fetch failed' (for example KILOCODE-WEB-28GB, 2836, 28DQ, 287W).
- packages/web-shared/src/lib/ai-gateway/providers/upstream-request.ts: createLoggedFetchFailure(errorName, errorMessage) builds an Error with the original name and message, and captureException passes tags and extra but no fingerprint. classifyUpstreamFetchFailure already produces the failure family.
- apps/web/src/tests/openrouterApi.timeout.test.ts asserts that captureException receives an error with name 'TypeError' and message 'fetch failed', plus source, provider and failure_family tags, safe extras, and no secrets in the captured options.
- PR #7349 deliberately relies on undici's 300s headersTimeout and adds no gateway header timer. PR #3286 introduced the current safe instrumentation. A history search found no later change to the capture shape.

## Desired outcome

Each AI-gateway upstream transport failure reaches Sentry under a stable group key built from the failure family and provider id, with a title that names both (for example, a header timeout from the custom provider). Groups no longer split by stack trace or bundle hash, and different families or providers no longer merge into one 'TypeError: fetch failed' group. Client-visible responses, logging, the 499/503 mapping and secret redaction stay the same.

## Scope

- Change the Sentry capture in upstreamRequest (upstream-request.ts) to set an explicit fingerprint built from the constant source, the failure family and the provider id.
- Replace the synthetic error's name and message with a descriptive, non-sensitive form that includes the failure family and provider id. The original errorName and errorMessage stay available in the extra data.
- Update the existing capture assertions in apps/web/src/tests/openrouterApi.timeout.test.ts and add coverage for the fingerprint.

## Exclusions

- No change to undici's 300s header bound, UPSTREAM_DURATION_BUDGET_MS, or retry or fallback behavior in llm-proxy.ts. Shortening time-to-first-byte is a separate product tradeoff that PR #7349 previously declined.
- No upstream remediation for ai-gateway.vercel.sh or the Kilo-exclusive model routing.
- No bulk merge or resolution of the existing 22 Sentry groups through the Sentry UI. That is an operator action after deploy.
- No change to the 'AI gateway upstream fetch failed' console log line or its metadata.

## Approach

- In upstream-request.ts, change createLoggedFetchFailure (or replace it with a small helper) to take failureFamily and providerId. Name the error something stable such as 'UpstreamFetchFailure', with a message such as `AI gateway upstream fetch failed: ${failureFamily} (${providerId})`. Use only already-sanitized values: the family is a closed union and the provider id is a configured identifier, never a URL, key or user content.
- Pass `fingerprint: ['ai-gateway-upstream-fetch', failureFamily, provider.id]` to captureException next to the existing tags and extra. Keep the tags (source, provider, failure_family) and the failureMetadata extra unchanged, so dashboards and saved searches on those tags keep working.
- Keep the existing skip for client-disconnect aborts and the try/catch that guarantees a caller-visible response even when enrichment throws.
- Update the timeout tests. The headers_timeout, read_timeout and other capture tests should assert the new error name and message and the fingerprint array. Add a case showing that two different families, or two different providers, produce different fingerprints. Keep the existing assertions that no secrets appear in the captured options.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/providers/upstream-request.ts (Sentry capture of upstream transport failures)
- apps/web/src/tests/openrouterApi.timeout.test.ts (capture contract tests)
- Sentry grouping for source=ai-gateway-upstream-fetch in project kilocode-web

## Acceptance criteria

### ac-1: For every captured upstream transport failure (any family except a client-disconnect abort), captureException receives `fingerprint: ['ai-gateway-upstream-fetch', <failureFamily>, <provider.id>]`. The tests assert this fingerprint for a headers_timeout failure from one provider, and also assert that a different family or a different provider produces a different fingerprint.

**Verification:** Code review

### ac-2: The captured error's name and message no longer default to 'TypeError' / 'fetch failed'. They identify the failure family and provider id, for example 'UpstreamFetchFailure: AI gateway upstream fetch failed: headers_timeout (custom)'. The original errorName and errorMessage still appear in the extra metadata, and the tags source, provider and failure_family are unchanged.

**Verification:** Code review

### ac-3: Behavior other than Sentry capture is unchanged: the client response is still 503 upstream_disconnect for transport failures and 499 client_disconnect for client aborts, client-disconnect aborts still are not captured, and the console log line and its metadata are unchanged. The existing timeout tests for these paths pass without changes to their response assertions.

**Verification:** Code review

### ac-4: The new title, message and fingerprint contain no secrets or request content. The existing test still asserts that the provider API key, URL query secrets, search string, request body and extra header values are absent from the captured arguments, and it now covers the fingerprint and error message as well.

**Verification:** Code review

### ac-5: After deploy, new source=ai-gateway-upstream-fetch events in Sentry land in groups keyed by family and provider, with descriptive titles. Header-timeout events from the custom provider and from the vercel provider fall into separate, stable groups, and later releases do not create new groups for the same family and provider.

**Verification:** Manual: after deploy, check kilocode-web in Sentry for tags[source]:ai-gateway-upstream-fetch and confirm new events group by family and provider across at least two releases

## Risks

- One-time regrouping: after deploy, every family and provider pair opens a new Sentry group, which may create a short burst of new-issue alerts or kfab stubs. Mitigation: merge or resolve the old 'TypeError: fetch failed' groups once new events are flowing.
- Coarser groups could hide a new failure mode inside an existing family and provider pair, for example a new cause in the 'unknown' family. Mitigation: causeCode and causeName stay in extra and remain searchable. The 'unknown' family could include causeCode in the fingerprint if review prefers.
- Alerts or saved searches matching the title 'fetch failed' would stop matching. Tag-based searches keep working.
- This plan does not shorten the roughly 300s wait callers see on a stuck upstream. Failure UX for those callers is unchanged (neither better nor worse).

## Assumptions

- Provider ids (for example custom, vercel, openrouter, direct-byok) form a small, bounded set and contain no secrets or per-user data, so they are safe to put in titles and fingerprints.
- The main failure here (header timeouts at ai-gateway.vercel.sh) is upstream-caused. Fixing it lies outside this repo change.
- The ai-gateway app's Sentry setup has no beforeSend that would override event fingerprints. A search of apps/ai-gateway for beforeSend found no matches.

## Decisions

### d-1: Should this work item add a gateway time-to-first-byte bound shorter than undici's 300s headersTimeout, or a transport retry?

**Answer:** No. That is out of scope here. PR #7349 deliberately relies on undici's defaults, and changing them is a product tradeoff that needs its own decision. This plan fixes only the observability churn that created the work item.

**Blocking:** no

### d-2: Which dimensions make up the Sentry fingerprint for upstream transport failures?

**Answer:** The source constant, the failure family and the provider id. Target host is left out to keep cardinality low; it stays in extra.

**Blocking:** no
