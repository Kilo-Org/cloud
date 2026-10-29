<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(stripe): enable bounded SDK network retries on shared Stripe client to absorb transient lock contention

## Problem

Sentry KILOCODE-WEB-28H0 (2 events, 0 users, production, first seen 2026-10-27) reports Stripe's transient object-contention error ("This object cannot be accessed right now because another API request or Stripe process is currently accessing it ... retry the request") from `client.paymentIntents.retrieve` in `handleSuccessfulCharge` (apps/web/src/lib/stripe/index.ts:978) during a `charge.succeeded` webhook. The shared Stripe client (packages/web-shared/src/lib/stripe-client.ts) is built with only `apiVersion` and no explicit `maxNetworkRetries`, so the SDK's built-in retry for retryable responses is never relied on deliberately. Each occurrence fails the whole webhook back to Stripe with a 400 and files a production Sentry error. Stripe's redelivery usually recovers it, but sustained contention could leave a paid top-up uncredited. The same message appeared twice more in the last 90 days on other releases, and those two events had no first-party frame, so other Stripe call sites hit it too.

## Evidence

- sentry: anaconda-nq KILOCODE-WEB-28H0 (7815142289), latest event 132bb8906993457faf6f268c5da10ed2: handled error on POST /api/stripe/webhook, fra1, release e009d438. Stack: route.ts:52 -> processStripePaymentEventHook index.ts:1357 -> handleSuccessfulCharge index.ts:978 -> stripe@23.0.0 (patched) RequestSender/Error.
- sentry (triage context): a 90-day search found 4 events with this message, all on POST /api/stripe/webhook (2026-10-24, -26, -27, -28). The earlier two had no first-party frame.
- file packages/web-shared/src/lib/stripe-client.ts:13-15: `new Stripe(stripeSecretKey, { apiVersion: '2026-09-30.endive' })`, with no maxNetworkRetries. The pinned repository has no matches for `maxNetworkRetries`, and the provider history has no prior Stripe retry change.
- file apps/web/src/app/api/stripe/webhook/route.ts:52-56: any handler error is passed to captureException and returns 400, so Stripe redelivers.
- file apps/web/src/lib/stripe/index.ts:971-982: the retrieve is the first statement, so a failure leaves no partial state. Line 1362 also calls `getStripeChargeInvoice(client, charge)` through the same client.

## Desired outcome

Transient Stripe lock-contention and other SDK-retryable failures get a few bounded, backed-off retries inside the request. A `charge.succeeded` webhook that meets brief contention then completes with 200 instead of failing and filing a Sentry error. Non-retryable errors keep failing immediately, and errors that persist after the retries still surface through the existing 400 + captureException path.

## Scope

- Set an explicit, small `maxNetworkRetries` (proposed: 2) on the shared Stripe client in packages/web-shared/src/lib/stripe-client.ts. The value should be a named constant with a short comment explaining why: Stripe's transient lock contention and its retry advice.
- Extend packages/web-shared/src/lib/stripe-client.test.ts to assert that the Stripe constructor receives the explicit retry option alongside the existing apiVersion.

## Exclusions

- No hand-rolled retry wrapper around individual call sites (index.ts:978/1362/2803/2962, affiliate-sale.ts). The SDK option covers all of them.
- No change to the webhook route's 400/captureException behavior, and no Sentry throttling or classification of residual errors. That is deferred until the retry's effect is observed.
- No investigation or serialization of Kilo-originated concurrent PaymentIntent access (triage hyp-3, unverified).
- No reconciliation of past events or ledger audit (triage mi-1). This needs access to the ledger and the Stripe dashboard.
- No manual acceptance criteria (operator request). Post-deploy Sentry monitoring and PR-description review are not acceptance gates for this plan.

## Approach

- In stripe-client.ts, add `const STRIPE_MAX_NETWORK_RETRIES = 2` and pass `maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES` in the `new Stripe(...)` options. The SDK then retries connection errors and responses it marks as retryable (409 conflicts, `Stripe-Should-Retry: true`, which Stripe sends for lock timeouts, and 5xx on safe requests) with exponential backoff and jitter. It also adds idempotency keys automatically to retried POSTs, so mutating calls stay safe to retry.
- Before setting the value, the implementer must confirm in the installed stripe@23 SDK source (RequestSender `_shouldRetry` / default `maxNetworkRetries`) that this error's response is classed as retryable and that the explicit value is not lower than the SDK default. If the SDK does not retry this case, stop and report back instead of adding a custom wrapper.
- Update stripe-client.test.ts: the existing `jest.mock('stripe')` default constructor mock already records its calls. Assert it was called with the secret key and an options object containing `apiVersion` and `maxNetworkRetries: 2`.
- Following the repository's Failure UX guidance, the change description should state both effects. Brief contention is absorbed in-process. Non-retryable errors still fail on the first attempt, and persistent retryable errors add at most the SDK's bounded backoff before the unchanged 400 path.

## Affected areas

- packages/web-shared/src/lib/stripe-client.ts (shared Stripe client options; affects every server-side Stripe call in apps/web, packages/web-shared, and packages/trpc consumers of this client)
- packages/web-shared/src/lib/stripe-client.test.ts

## Acceptance criteria

### ac-1: The shared Stripe client in packages/web-shared/src/lib/stripe-client.ts is constructed with an explicit bounded `maxNetworkRetries` value (2), defined as a named constant with a comment citing transient Stripe lock contention, while keeping the existing `apiVersion`.

**Verification:** Source review

### ac-2: packages/web-shared/src/lib/stripe-client.test.ts asserts that the Stripe constructor receives an options object containing both the existing apiVersion and `maxNetworkRetries: 2`, so removing or changing the retry option fails the test.

**Verification:** Code review

## Risks

- Global blast radius: retries apply to every Stripe call made through this client, including user-facing ones (checkout, payment-method lookups). Worst-case added latency is bounded by 2 backed-off retries. A Vercel function near its timeout could be pushed over it, but this is unlikely at 2 retries.
- Retried mutating POSTs rely on the SDK's automatic idempotency keys. Call sites that already pass their own idempotencyKey keep it. No duplicate charges are expected, but reviewers should confirm no call site depends on a single non-idempotent attempt.
- If the installed SDK does not class this response as retryable, the option will not silence the issue. The approach requires confirming this first and stopping rather than widening scope.
- With the manual post-deploy criterion removed, whether the Sentry issue actually stops recurring is not gated by this plan.

## Assumptions

- Stripe's lock-contention response is retryable by the Node SDK (Stripe sends `Stripe-Should-Retry` for lock timeouts and documents retrying). This must be confirmed against the installed SDK source during implementation.
- Stripe webhook redelivery remains the backstop for failures that persist after the in-process retries.

## Decisions

### d-1: Where to add retry: an SDK-level `maxNetworkRetries` on the shared client, or a custom retry wrapper at index.ts:978/1362?

**Answer:** SDK-level option on the shared client. It is a one-line change, covers the other call sites that produced the frameless occurrences, uses Stripe's own retry classification and idempotency handling, and avoids a new helper.

**Blocking:** no

### d-2: Should residual Stripe transient errors in the webhook route be throttled or downgraded in Sentry now?

**Answer:** No. Keep the existing capture-and-400 path. Revisit only if occurrences persist after the retry ships.

**Blocking:** no

### d-3: Should the plan include manual acceptance criteria (PR-description review, post-deploy Sentry recurrence check)?

**Answer:** No. The operator asked to remove them; only source/code-review criteria remain.

**Blocking:** no
