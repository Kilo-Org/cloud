<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(ai-gateway): stop firewall rate-limit transport failures from escaping the LLM proxy as unhandled 500s

## Problem

Sentry KILOCODE-WEB-1W27 ("TypeError: fetch failed", culprit POST /api/v1/[...path], 648 events since 2026-04-21, still occurring) is an unhandled error on the AI gateway chat-completions route, reported through Next.js onRequestError, and the caller gets HTTP 500. Triage thought the cause was the upstream provider call or the response-stream read. New evidence points somewhere else. The failing invocations end in 48–200 ms, which is too early to reach the upstream call. One that hit a connect timeout ended in about 10.3 s, and the 10 s is undici's connect timeout. No line from upstreamRequest's 'AI gateway upstream fetch failed' handler or from the stream handler appears for these requests. The only outbound fetches that run this early in handleLlmProxyRequest, and that have no error handling, are the Vercel Firewall rate-limit checks. isFirewallRateLimited calls @vercel/firewall checkRateLimit with no try/catch. The account cap calls it first (gateway-inference, before the body is read and before auth). The free-model limits call it after the catalog lookup (free-model-inference / free-model-inference-user). The Sentry model tags are mostly free models, which fits both call sites. Every other early fetch already catches its own errors: bouncer postWithResult, the auto-routing decision, api-metrics, the custom-LLM catalog, and the upstream fetch. The AUTH-FAIL log seen on one request comes from the auth promise, which started in parallel, so it does not mean auth threw.

## Evidence

- sentry: KILOCODE-WEB-1W27 (anaconda-nq/7428911441) latest event acc07e94…: handled=no, mechanism auto.function.nextjs.on_request_error, TypeError 'fetch failed' caused by undici SocketError 'other side closed', no first-party stack frames, transaction POST /api/v1/[...path], release ebf5c14b, fra1.
- sentry: 30-day ui.ai_model breakdown for the issue is mostly free models (nemotron :free, step-5-preview-free, laguna :free, reflection/beam-free…), with a few paid/embedding models and one empty value.
- axiom (vercel dataset, kilocode-ai-gateway): request ghkdv-…d79a: status=500 with function duration 113 ms. The raw fetch-failed (UND_ERR_SOCKET) log appears after the response. No upstream-failure or stream-error log.
- axiom: requests 9pqnp-… (90 ms, ECONNRESET), w5drq-… (198 ms, UND_ERR_SOCKET) and xtdht-… (48 ms, ECONNRESET) all returned 500 on /api/v1/chat/completions. Request 7skvw-… returned 500 after 10,348 ms with ConnectTimeoutError (10000 ms) to the same 64.239.109.x range as the socket-closed cases.
- axiom: over 7 days the gateway logged 51 raw ECONNRESET, 5 ConnectTimeout to 64.239.109.193, and 2 socket-closed fetch failures. Separately, a ConnectTimeout to 104.18.x happened on GET /api/v1/models and a HeadersTimeout on /api/v1/audio/transcriptions (302 s). Those two are separate call sites.
- file: packages/web-shared/src/lib/ai-gateway/firewall-rate-limit.ts: isFirewallRateLimited awaits checkRateLimit(...) with no try/catch. It only handles the returned error === 'not-found'.
- file: packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.ts:283: `await isGatewayAccountRateLimited(request, accountKey)` is the first await in the handler, before request.text() and auth. Lines 683–690 call isFreeModelRateLimited for publicly free models. handleLlmProxyRequest has no top-level try/catch.
- file: bouncer/client.ts postWithResult, auto-routing-decision.ts postDecision, o11y/api-metrics.server.ts sendApiMetrics, custom-llm-catalog getCustomLlmCatalog and upstream-request.ts upstreamRequest all catch fetch errors already.
- file: apps/web/src/lib/auth/firewall-rate-limit.ts already distinguishes 'allowed' | 'limited' | 'unavailable' and reports throttled Sentry messages. That is prior art for treating a limiter that cannot answer explicitly.
- history: PRs #7534, #8456 and #8559 added these gateway firewall rules and said a missing rule means 'not limited' (fail open). None of them handles a transport failure from checkRateLimit.

## Desired outcome

If the Vercel Firewall rate-limit check throws a transport error, the AI gateway LLM proxy no longer returns an unhandled 500 or files an unhandled Sentry event. The check fails open, the same way a missing rule already does. The request carries on to auth and the upstream call. One throttled, tagged Sentry report per rule per instance per minute keeps the limiter outage visible. A request that is genuinely rate-limited still gets the existing 429.

## Scope

- Make isFirewallRateLimited in packages/web-shared/src/lib/ai-gateway/firewall-rate-limit.ts catch errors thrown by checkRateLimit. On a throw it returns false (not limited), logs one structured warning with the rule id, error name and cause code (no headers and no key values), and sends a captureMessage throttled per rule (reuse the existing per-rule interval map with a separate key, e.g. '<id>:unavailable'). The message names the rule as unreachable and carries the existing sentrySource tag.
- This covers all three gateway callers through the shared helper: gateway-inference (account cap), free-model-inference and free-model-inference-user. The openai-chatgpt-inference limiter covers itself only if it uses the same helper.
- Extend firewall-rate-limit.test.ts with transport-failure cases: rejection with TypeError('fetch failed') plus an undici-style cause.
- Add an llm-proxy handler test: when the account-cap check throws, the request is not answered with a 500 or a rejection and it proceeds past the cap.

## Exclusions

- The upstream provider fetch and response-stream classifiers in upstream-request.ts, rewriteModelResponse.shared.ts and processUsage.shared.ts. Evidence shows these failures happen before the upstream call. Broadening UND_ERR_SOCKET classification there is separate work.
- The GET /api/v1/models connect timeouts and the /api/v1/audio/transcriptions headers timeout. These are other call sites and stay as follow-ups.
- A generic route-level try/catch on POST /api/v1/[...path]. It would hide other real defects, and it is not needed once the throwing call is handled.
- Adding a Sentry beforeSend filter for 'fetch failed'.
- Changing apps/web's firewall-rate-limit helper or the auth limiters, which fail closed by design.
- Shortening the 10 s undici connect timeout of checkRateLimit. The library exposes no timeout or signal option at the pinned version, and the pinned checkout has no node_modules to confirm otherwise.
- Post-deploy production monitoring of Sentry/Axiom is not an acceptance criterion of this change; it remains an optional operational follow-up.

## Approach

- Wrap the `await checkRateLimit(...)` call in isFirewallRateLimited in try/catch. In the catch: build a sanitized summary (error name, message and cause code, read safely with fallbacks), log it once through the existing warn/error helper, and report it through a throttled captureMessage(`Firewall rate limit '<id>' could not be checked`, { level: 'warning' or 'error', tags: { source: rule.sentrySource, reason: 'transport' } }). Then return false.
- Keep the existing not-found path unchanged. Share the throttle map, but give the unavailable report its own key so it cannot suppress the missing-rule alarm, or be suppressed by it.
- Update the module doc comment: a limiter that is unreachable is treated like a missing rule (not limited), and the gateway takes this tradeoff on purpose so a firewall API blip does not fail inference. Mention that apps/web's auth limiters fail closed instead.
- Tests: (a) checkRateLimit rejects with TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }), so the helper resolves false and captureMessage is called once with the source tag and no credential headers. (b) Repeated rejections within the interval report only once per rule. (c) A rejection and a not-found on the same rule are reported independently. (d) In llm-proxy.test.ts, mock checkRateLimit to reject: the handler does not throw and gets past the cap. Assert this the way existing tests assert the request passes the limiter, e.g. the upstream mock is called or the handler goes on to auth.
- Verify with the web-shared jest suites for firewall-rate-limit and llm-proxy, plus web-shared typecheck, using the repository-verification skill to pick the commands.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/firewall-rate-limit.ts
- packages/web-shared/src/lib/ai-gateway/firewall-rate-limit.test.ts
- packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.test.ts (or the nearest existing handler test that mocks @vercel/firewall)
- Indirectly: gateway-account-rate-limit.ts, free-model-rate-limit.ts and any other caller of isFirewallRateLimited (behavior only, no code change)

## Acceptance criteria

### ac-1: When @vercel/firewall checkRateLimit rejects (for example TypeError 'fetch failed' with an UND_ERR_SOCKET or ECONNRESET cause), isFirewallRateLimited resolves to false instead of rejecting. A unit test with a rejecting checkRateLimit mock covers this.

**Verification:** Code review

### ac-2: A transport failure is reported to Sentry as a captureMessage carrying the rule's sentrySource tag. Reports are throttled to at most one per rule per instance per interval, and they are throttled independently of the existing 'not configured' report for the same rule. Unit tests cover the throttling and the independence from not-found.

**Verification:** Code review

### ac-3: The failure report and log contain no authorization header, cookie, token, rate-limit key or client IP. They contain only the rule id, error name/message and cause code.

**Verification:** Source review

### ac-4: handleLlmProxyRequest no longer throws when the account-cap firewall check rejects. A handler test with a rejecting checkRateLimit shows the request proceeds past the cap and is not answered with a 500. An existing or added test shows a firewall response with rateLimited: true still produces the 429 rate_limit_exceeded response.

**Verification:** Code review

## Risks

- The attribution comes from timing and elimination, not a stack trace (Sentry has no first-party frames). If some events come from a different early call site, they will keep occurring; watching KILOCODE-WEB-1W27 after deploy (outside this plan's acceptance criteria) would reveal that, and the remaining cases can be followed up separately.
- Failing open means that while the firewall API is unreachable, the account cap and free-model abuse limits stop applying. That is the same exposure as today's missing-rule behavior, and the throttled Sentry report keeps it visible.
- A connect timeout to the firewall API still costs up to about 10 s before failing open, because checkRateLimit offers no timeout option. Users get a slow success instead of a slow 500. Bounding that latency is out of scope.
- Throttle state is per instance, so a fleet-wide outage still produces up to N reports per minute. This matches the existing pattern.

## Assumptions

- The deployed release (ebf5c14b) has the same rate-limit call order in llm-proxy.ts as the pinned commit e08d9cab.
- @vercel/firewall 1.2.1 checkRateLimit performs an HTTP fetch and lets undici transport errors propagate instead of returning { error }. The early, raw 'fetch failed' 500s support this, but it is not confirmed from library source because node_modules is not in the checkout.
- Existing llm-proxy handler tests already mock @vercel/firewall or the rate-limit modules, so a rejecting variant can be added without new test infrastructure.

## Decisions

### d-1: When the firewall rate-limit API cannot be reached, should the gateway fail open (serve the request, not limited) or fail closed (return a 503 or 429)?

**Answer:** Fail open, matching the gateway's existing handling of a missing rule (PRs #7534/#8456/#8559) and the Failure UX guidance not to fail a turn on a transient condition. A throttled Sentry report keeps it visible. apps/web's auth limiters keep failing closed. An operator can override this before approval.

**Blocking:** no

### d-2: Where should the fix go: the shared helper, each caller, or a route-level boundary?

**Answer:** The shared isFirewallRateLimited helper. One change covers every gateway limiter, and a route-level boundary would hide unrelated defects.

**Blocking:** no
