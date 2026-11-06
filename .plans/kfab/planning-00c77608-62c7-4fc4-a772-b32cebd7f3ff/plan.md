<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Handle unknown or foreign Stripe checkout sessions in organizations.subscription.getByStripeSessionId without a 500

## Problem

`organizations.subscription.getByStripeSessionId` (apps/web/src/routers/organizations/organization-subscription-router.ts, around line 248) calls `client.checkout.sessions.retrieve(sessionId)` with no error handling. When Stripe answers `No such checkout.session` (a `StripeInvalidRequestError` with code resource_missing), the error leaves the resolver unhandled. The tRPC Sentry middleware then reports it and the request returns HTTP 500 (Sentry KILOCODE-WEB-28HG). The procedure is also a bare `baseProcedure` whose input is only `sessionId: z.string().min(1)`. It never checks that the checkout session belongs to the caller's organization, so any signed-in caller can ask whether any session id was paid. On the client, `useStripeSessionStatus` retries every error up to 10 times at 1s intervals before `StripeSessionStatusChecker` redirects. A session that can never resolve therefore costs the user about 10s of spinner and produces repeated server errors.

## Evidence

- Sentry KILOCODE-WEB-28HG (anaconda-nq/7817322160, kilocode-web, production): TRPCError wrapping Stripe's `No such checkout.session`. Culprit is GET /api/trpc/organizations.subscription.getByStripeSessionId. 2 events between 2026-10-28T20:59Z and 2026-10-29T01:37Z, 0 users impacted, tags handled:no and mechanism auto.rpc.trpc.middleware. The caller's user agent was curl.
- Latest Sentry event a1f0238bd35e492b821d321be51b346c: the first-party frame is organization-subscription-router.ts:253, `const session = await client.checkout.sessions.retrieve(sessionId);`, called from the resolver at line 250.
- Pinned source: `getByStripeSessionId: baseProcedure.input(z.object({ sessionId: z.string().min(1) }))`. There is no try/catch, no id-shape check and no ownership check. The resolver throws NOT_FOUND only for a non-paid session or a missing subscription, and those messages echo the session id.
- Precedent in apps/web/src/app/payments/topup/success/actions.tsx: `STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,255}$/` rejects malformed ids before calling Stripe. Stripe failures are caught; permanent ones (StripeInvalidRequestError and similar) map to `unavailable` and transient ones stay retryable. It also checks that the session belongs to the caller or an organization where they have a billing role. actions.test.ts covers the unknown-id case with a mocked resource_missing error.
- Only in-product caller: /payments/subscriptions/success (auth-gated) reads `organizationId` and the session id from the query string and renders StripeSessionStatusChecker. That component calls useStripeSessionStatus (apps/web/src/app/payments/hooks.ts, `retry: 10, retryDelay: 1000`) and redirects to /organizations/{organizationId} however the query ends.
- Checkout creation (apps/web/src/lib/stripe/index.ts getStripeSeatsCheckoutUrl) creates the session with `customer: stripeCustomerId`, which is the organization's Stripe customer, and puts organizationId only in `subscription_data.metadata`. Top-level session metadata holds only `isSubscription: 'yes'`. The success URL already includes `organizationId`.
- packages/web-shared/src/lib/trpc/init.ts: baseProcedure includes sentryMiddleware. A code comment there says the Sentry `beforeSend` drops tRPC 4xx errors, so mapping expected failures to a 4xx TRPCError keeps them out of Sentry error traffic.
- Triage context: Axiom `vercel` request logs show the two 500s matching the Sentry timestamps, sent by scripted curl/Python callers using made-up session ids. Neighbouring burst issues (#9060, #9064) have different root causes.
- services/kilo-mcp/catalog.json has an entry for this procedure path describing its input. The .github/workflows/kilo-mcp-catalog.yml workflow regenerates it and fails when it is stale.

## Desired outcome

An unknown, expired, malformed or foreign checkout session id returns a stable 4xx TRPCError. It no longer produces an unhandled 500 or a Sentry error event, and it does not reveal whether a session belonging to someone else was paid. A paid session for the caller's own organization still resolves to `{ status: 'paid' }`. Transient Stripe failures are still retried by the client within the existing bound. When the outcome is already known to be permanent, the success page stops retrying and redirects at once instead of showing a spinner for about 10s.

## Scope

- Resolver `organizations.subscription.getByStripeSessionId` in apps/web/src/routers/organizations/organization-subscription-router.ts.
- Client hook apps/web/src/app/payments/hooks.ts and its callers StripeSessionStatusChecker and the subscriptions success page, which pass organizationId through.
- Unit tests in apps/web/src/routers/organizations/organization-subscription-router.test.ts.
- Matching update to this procedure's input description in services/kilo-mcp/catalog.json, if the catalog workflow requires it.

## Exclusions

- Neighbouring burst issues #9060 (Invalid integer in changeAutoTopUpPaymentMethod) and #9064 (cookie serialize via /api/user).
- Changing the top-up success flow or sharing its helper beyond what is needed. A small shared constant or helper is fine but not required.
- Changing how `no_payment_required` sessions (for example 100% promotion codes) are treated. The current behaviour throws NOT_FOUND and still redirects, and this change keeps that behaviour.
- Changing Sentry configuration, beforeSend filtering, or the shared tRPC middleware stack.
- Rate limiting or blocking the probing traffic.

## Approach

- Input: change the procedure to `organizationBillingProcedure`. Use `OrganizationIdInputSchema` extended with `sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,255}$/)`, matching the top-up pattern. Malformed ids then fail zod validation with BAD_REQUEST before any Stripe call, and callers without a billing role in the organization are rejected by the existing middleware.
- Wrap `client.checkout.sessions.retrieve` in try/catch. Map `Stripe.errors.StripeInvalidRequestError` (resource_missing and other invalid-request responses that repeat identically) to `TRPCError({ code: 'NOT_FOUND', message: 'Checkout session not found' })`. Rethrow every other error unchanged: transport errors, rate limits, Stripe 5xx, and authentication or permission errors, which indicate a misconfigured key. Those remain genuine 5xx, are reported, and are retried by the client.
- Ownership: load the organization (`getOrganizationById`). Compare the session's customer id (a string, or `.id` if expanded) with `organization.stripe_customer_id`. If they differ or either is missing, throw the same NOT_FOUND 'Checkout session not found' error so that foreign sessions cannot be told apart from unknown ones.
- Keep the paid and subscription-exists checks. Remove the session id from the NOT_FOUND messages so ids are not echoed back.
- Client: pass `organizationId` from StripeSessionStatusChecker into `useStripeSessionStatus` and into the query input. Replace `retry: 10` with a predicate that retries up to 10 times only when the error is not a tRPC client error (no `data.httpStatus`, or `httpStatus >= 500`). 4xx outcomes stop at once, and the existing redirect to /organizations/{organizationId} happens without the spinner. Keep `retryDelay: 1000`.
- Tests: extend the router test's stripe-client mock with `checkout.sessions.retrieve`. Cover these cases: unknown id (resource_missing) gives NOT_FOUND; malformed id gives BAD_REQUEST and Stripe is not called; a session whose customer differs from the organization's gives NOT_FOUND; a non-member or non-billing caller is rejected; a paid owned session gives `{ status: 'paid' }`; a StripeConnectionError propagates rather than becoming NOT_FOUND.
- Update the services/kilo-mcp/catalog.json entry for the new `organizationId` input if the catalog workflow flags it as stale.

## Affected areas

- apps/web/src/routers/organizations/organization-subscription-router.ts
- apps/web/src/routers/organizations/organization-subscription-router.test.ts
- apps/web/src/app/payments/hooks.ts
- apps/web/src/components/payment/StripeSessionStatusChecker.tsx
- services/kilo-mcp/catalog.json (procedure input description only)

## Acceptance criteria

### ac-1: When Stripe rejects `checkout.sessions.retrieve` with a StripeInvalidRequestError (resource_missing), getByStripeSessionId throws a TRPCError with code NOT_FOUND. The error does not escape as an unhandled or 500 error, and its message does not contain the session id. A router unit test with a mocked resource_missing rejection asserts this.

**Verification:** Code review

### ac-2: A sessionId that does not match `^cs_[A-Za-z0-9_]{1,255}$` is rejected with BAD_REQUEST and Stripe is never called. A unit test asserts that `checkout.sessions.retrieve` was not called.

**Verification:** Code review

### ac-3: The procedure requires an organizationId and rejects callers without an organization billing role. A session whose customer does not match the organization's stripe_customer_id returns the same NOT_FOUND error as an unknown session, whatever that session's payment status. Unit tests cover both the foreign-customer case and the non-billing-caller case.

**Verification:** Code review

### ac-4: A paid checkout session whose customer matches the organization's Stripe customer, and whose subscription exists, still resolves to `{ status: 'paid' }`. A unit test covers this.

**Verification:** Code review

### ac-5: Transient Stripe failures (for example StripeConnectionError, rate limit, or Stripe 5xx), and Stripe authentication or permission errors, are not converted to NOT_FOUND. They propagate as server errors, so a real paid user hitting a temporary outage is still retried. A unit test asserts that a StripeConnectionError propagates.

**Verification:** Code review

### ac-6: The success-page hook passes organizationId and retries only non-4xx failures, at most 10 times with a 1s delay. After a 4xx (unknown, foreign, malformed or unpaid session) StripeSessionStatusChecker redirects to /organizations/{organizationId} without the roughly 10s retry spinner. After a transient 5xx it keeps retrying within the existing bound before redirecting.

**Verification:** Source review

### ac-7: After deployment, requests to this procedure with unknown session ids no longer produce new KILOCODE-WEB-28HG events or HTTP 500 responses for the procedure path in production request logs.

**Verification:** Manual: after release, check Sentry KILOCODE-WEB-28HG for new events and the Axiom `vercel` dataset for 5xx on paths containing getByStripeSessionId

## Risks

- Breaking input change: callers that omit organizationId fail. The only in-product caller is updated in the same change. The kilo-mcp catalog entry has to be refreshed, and the catalog workflow fails if it is stale.
- Ownership check by Stripe customer: if an organization's stripe_customer_id changed after checkout (rare), the user sees NOT_FOUND and is still redirected to the organization page. Display is unaffected because the page redirects in every case.
- Unpaid sessions are no longer retried by the client. For card subscriptions Stripe already marks the session paid by redirect time, and asynchronous payment methods stay unpaid far longer than 10s, so the old retries did not help. The redirect itself is unchanged.
- If the beforeSend filter for tRPC 4xx ever changes, NOT_FOUND errors could reach Sentry again. That is out of scope here and relies on the existing filter.

## Assumptions

- The Sentry `beforeSend` filter drops tRPC 4xx errors, as the comment in packages/web-shared/src/lib/trpc/init.ts says, so NOT_FOUND and BAD_REQUEST do not create Sentry error events.
- Every subscription checkout session created by getStripeSeatsCheckoutUrl sets `customer` to the organization's stripe_customer_id, which getOrCreateStripeCustomerIdForOrganization persists on the organization row.
- The user who returns from checkout holds an organization billing role, since the same role is needed to create the checkout (getSubscriptionStripeUrl uses organizationBillingProcedure).

## Decisions

### d-1: Should the fix also add an organization ownership check, rather than only catching the Stripe error?

**Answer:** Yes. Switch to organizationBillingProcedure with organizationId and compare session.customer with the organization's Stripe customer. Foreign sessions get the same NOT_FOUND as unknown ones, which removes the payment-status oracle with little extra scope.

**Blocking:** no

### d-2: Which Stripe errors count as permanent (mapped to NOT_FOUND) and which are surfaced?

**Answer:** Only StripeInvalidRequestError maps to NOT_FOUND. Authentication and permission errors mean a misconfigured key and stay reported 5xx errors. This differs from the top-up flow, which treats them as `unavailable`. Transport, rate-limit and Stripe 5xx errors stay retryable 5xx errors.

**Blocking:** no

### d-3: How should the client retry behave?

**Answer:** Retry only non-4xx errors, up to 10 times with a 1s delay. Redirect immediately on 4xx so known-permanent outcomes fail fast.

**Blocking:** no
