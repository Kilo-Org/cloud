# Impact Advocate Referral Implementation Plan for KiloClaw

## Scope

This plan implements the KiloClaw referral program defined in `.specs/kiloclaw-referrals.md`.
That spec is authoritative for business rules, eligibility, attribution, reward semantics, reversals, and GDPR behavior. This document covers implementation shape only.

Program scope for implementation:

- Impact Advocate powers referral sharing, participant registration, and Impact-side reporting.
- Kilo owns the authoritative referral touch capture, affiliate/referral attribution resolution, first-paid conversion detection, reward grant idempotency, reward caps, and billing fulfillment.
- The program is double-sided: one free KiloClaw month for the referee and one free KiloClaw month for the referrer when an eligible referee reaches their first confirmed paid personal KiloClaw conversion.
- Referral rewards apply only to personal KiloClaw subscriptions.
- Rewards are fulfilled by delaying the beneficiary's next unpaid KiloClaw renewal boundary by one calendar month per reward.
- Affiliate and referral attribution are resolved together at conversion time under the spec's referral-priority rules, not generic first-touch rules.

## Executive Recommendation

Use a hybrid architecture with app-owned state and Impact-owned sharing UX:

1. Use the Impact Advocate Verified Access widget `p/51699/w/referrerWidget` as the logged-in referral experience.
2. Load the Impact UTT when configured and invoke `identify` on referral-program pages for both anonymous and logged-in users.
3. Capture affiliate and referral touches in a chronological local ledger, preserve them across auth flows, and associate anonymous touches to the created user.
4. On signup with `_saasquatch`, enqueue a server-side Register Participant upsert using the captured `_saasquatch` value as opaque cookie attribution.
5. On the referee's first monetized personal KiloClaw payment period, resolve attribution using the referral-priority model from the spec:
   - valid referral wins over valid affiliate,
   - unless an affiliate touch had already been sale-attributed before the referral touch,
   - otherwise oldest valid referral wins, then oldest valid affiliate, else none.
6. Atomically record both beneficiary reward decisions for a qualified referral conversion, including granted, cap-limited, and disqualified outcomes.
7. Fulfill granted rewards locally by delaying the next unpaid KiloClaw renewal boundary, keeping local billing state and Stripe state consistent.
8. Continue using the existing Impact Performance conversion pipeline, with `Sale (71659)` as the paid conversion event that drives Impact referral conversion reporting.
9. Keep Impact delivery, retries, and reconciliation out of the critical path for billing settlement and user access.

The hardest implementation area remains reward fulfillment for Stripe-funded and hybrid subscriptions while preserving current KiloClaw billing invariants.

## Current State

### Existing Impact Affiliate Integration

Relevant files:

- `apps/web/src/lib/impact.ts`
- `apps/web/src/lib/affiliate-events.ts`
- `apps/web/src/lib/affiliate-attribution.ts`
- `apps/web/src/lib/impact-affiliate-utils.ts`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/components/ImpactIdentify.tsx`
- `apps/web/src/app/users/after-sign-in/route.tsx`
- `apps/web/src/lib/user.ts`
- `packages/db/src/schema.ts`

Current behavior:

- UTT is globally loaded when `NEXT_PUBLIC_IMPACT_UTT_ID` is configured.
- Authenticated users are identified with `window.ire('identify', ...)` using `customerId` and SHA-1 hashed email.
- Affiliate touches are captured from `im_ref` or `impact_click_id` and stored as `user_affiliate_attributions`.
- Affiliate events are queued in `user_affiliate_events` and dispatched by cron.
- Existing Impact event IDs include `signup`, `trial_start`, `trial_end`, and `sale`.
- KiloClaw already emits affiliate events from trial start, trial end, and sale paths.

Current gaps relative to the referral spec:

- Existing affiliate attribution is not a chronological touch ledger suitable for conversion-time shared attribution resolution.
- Current attribution does not model 30-day expiration or referral-priority override.
- The schema cannot represent referral touches, participant registration state, referral relationships, reward decisions, reward states, or reward-application audit data.
- Current KiloClaw affiliate sale reporting exists, but referral rewards must be first-paid-conversion-only.
- Current flows do not record whether an affiliate touch has already been sale-attributed for later renewal protection.

### Existing KiloClaw Billing Hooks

Relevant files:

- `apps/web/src/routers/kiloclaw-router.ts`
- `apps/web/src/lib/kiloclaw/credit-billing.ts`
- `apps/web/src/lib/kiloclaw/stripe-handlers.ts`
- `apps/web/src/app/api/internal/kiloclaw/billing-side-effects/route.ts`
- `services/kiloclaw-billing/*`
- `.specs/kiloclaw-billing.md`

Current useful hooks:

- Trial creation and trial-to-paid conversion paths already exist.
- Stripe invoice settlement is handled centrally.
- Pure-credit and hybrid billing paths already produce billing side effects.
- `services/kiloclaw-billing` calls the web app internal side-effect route instead of contacting Impact directly.

Referral implementation should reuse these billing hooks to detect the referee's first confirmed paid personal KiloClaw conversion and to apply renewal-boundary extensions idempotently.

## Authoritative Rules From the Spec

These rules are already decided and should not be reopened in implementation:

- Program constants:
  - Impact Account `7138521`
  - Performance CampaignId `50754`
  - Advocate ProgramId `51699`
  - UTT UUID `A7138521-9724-4b8f-95f4-1db2fbae81141`
  - Widget `p/51699/w/referrerWidget`
- Verified Access identity contract:
  - `id = Kilo user ID`
  - `accountId = Kilo user ID`
  - `email = plain user email`
- Register Participant requests are server-side and use Kilo user ID for `id` and `accountId`, with plain-text email only as the contact email.
- Referral touch validity requires non-empty `_saasquatch` and expires exactly 30 days after touch time using server UTC.
- Affiliate and referral attribution are resolved together at first paid conversion time.
- Referral has priority over affiliate unless the affiliate touch had already been sale-attributed before the referral touch occurred.
- The first paid conversion is the referee's first confirmed paid personal KiloClaw subscription payment period, including Stripe-settled, hybrid-settled, or pure-credit-funded periods.
- Trial start, trial end, signup, zero-dollar invoices, fully comped periods, admin adjustments, and non-KiloClaw purchases are not qualifying conversions.
- Referrer rewards cap at 12 total free months; referee rewards do not count toward that cap.
- Reward states must support `pending`, `earned`, `applied`, `reversed`, `expired`, `canceled`, and `review_required`.
- Reward fulfillment is app-owned and delays the next unpaid renewal boundary by one calendar month per reward.
- Impact webhooks are not a source of truth and must not be required for eligibility, granting, billing fulfillment, or reconciliation.
- Existing internal referral-code logic must not double-reward KiloClaw conversions governed by this program.

## Impact Advocate Findings

### Confirmed Program Values

Impact's technical notes and the spec align on these values:

- Account: `7138521`
- Performance CampaignId: `50754`
- Advocate ProgramId: `51699`
- UTT script: `https://utt.impactcdn.com/A7138521-9724-4b8f-95f4-1db2fbae81141.js`
- Advocate widget: `p/51699/w/referrerWidget`
- Domain: `kilo.ai`

Performance action tracker IDs:

| Event       | ActionTrackerId | Trigger                                     |
| ----------- | --------------- | ------------------------------------------- |
| VISIT       | `71668`         | Visitor lands on `kilo.ai` with `im_ref`    |
| SIGNUP      | `71655`         | New user creation with attribution          |
| TRIAL_START | `71656`         | KiloClaw trial subscription becomes active  |
| TRIAL_END   | `71658`         | KiloClaw trial subscription ends            |
| SALE        | `71659`         | Monetized KiloClaw payment period is funded |

### UTT, Identify, and Opaque Tracking Values

Implementation requirements:

- Load the UTT only when the public UTT identifier is configured.
- Invoke `identify` on pages used by the referral program.
- Anonymous `identify` calls must pass empty strings for unknown `customerId` and `customerEmail`.
- Logged-in `identify` calls must pass stable customer ID and SHA-1 hashed email.
- `identify` calls must include a stable `customProfileId` derived from the Kilo user ID for logged-in users and a stable first-party anonymous ID for anonymous users.
- Treat `_saasquatch`, `rsCode`, `rsShareMedium`, `rsEngagementMedium`, `im_ref`, and related tracking values as opaque.
- Document and enforce a maximum accepted length for opaque tracking values; values above that limit are stored only as diagnostics or ignored for attribution, and logs must redact or truncate them.

### Advocate Widget

Use the Verified Access widget as the launch path.

Implementation contract:

- Server issues a short-lived JWT.
- Client sets `window.impactToken`.
- UI renders:

```html
<impact-embed widget="p/51699/w/referrerWidget">
  <div>Loading...</div>
</impact-embed>
```

JWT/user payload should include the Impact-required fields where available, but the identity mapping must follow the spec: Kilo user ID for `id` and `accountId`, plain email only in `email`.

### Referred Participant Registration

When signup occurs with `_saasquatch` attribution:

- Associate the referral touch to the user.
- Enqueue server-side Register Participant delivery before signup is considered complete.
- External Impact delivery must not block user access.
- Pass the exact `_saasquatch` value as opaque `cookies` attribution.
- Include locale and country code when available.
- Keep failures retryable unless configuration or payload is permanently invalid.

### Conversion Reporting

Implementation contract:

- Continue using the existing Performance Conversions API integration.
- Use `Sale (71659)` as the paid conversion event for first paid periods and renewals.
- Do not add client-side `trackConversion` for referrals while server-side Performance conversion is the configured mechanism.
- Use deterministic order identifiers where possible.
- Impact delivery failure must not block billing settlement, local reward decisions, or user access.
- If a referral wins attribution, ensure the first qualifying paid conversion is still reported to Impact through the existing server-side pipeline.

## Product Rules To Encode

### Eligibility

Referee eligibility:

- Must be a brand-new Kilo account.
- Existing users and previously deleted users are disqualified.
- Disqualification for previously deleted users must use the legal-approved normalized-email hash tombstone.
- Must convert on a personal KiloClaw subscription.
- Must reach a first confirmed paid monetized KiloClaw payment period.
- Trial start, trial end, signup, zero-dollar invoices, comped periods, admin adjustments, and later renewals do not qualify.
- Self-referrals are disqualified.
- Fraudulent, test, admin-created, or manually adjusted subscriptions do not qualify unless explicitly overridden through an authorized support process.

Referrer eligibility:

- Must be a Kilo user who is registered or registerable as an Advocate participant.
- Current subscription state does not block reward earning.
- If there is no active eligible personal KiloClaw subscription when the reward is earned, keep the reward pending until the referrer starts or reactivates an eligible paid personal KiloClaw subscription.
- If that never happens, cancel/expire the pending inactive-referrer reward 12 months after it was earned.
- Referrer rewards do not apply to trials; they apply to the next unpaid renewal boundary after paid activation/reactivation.
- Referrer can receive at most 12 total free months.

Reward rules:

- Qualified referral conversion grants one free-month reward to the referee.
- Qualified referral conversion grants one free-month reward to the referrer unless cap-limited or otherwise disqualified.
- Both beneficiary outcomes must be recorded atomically.
- Fulfillment is not complete until required KiloClaw billing state, and any needed Stripe state, are updated successfully.

### Attribution

The implementation must follow the referral-priority model from the spec, not generic first-touch attribution.

Rules to encode:

- Referral and affiliate share the same 30-day conversion-time window.
- Attribution is resolved at first paid KiloClaw conversion time.
- A valid referral touch wins over a valid affiliate touch unless the affiliate touch had already been sale-attributed before the referral touch.
- If multiple valid referral touches exist and no preserved sale-attributed affiliate touch blocks them, the oldest valid referral touch wins.
- If no valid referral touch exists, the oldest valid affiliate touch wins.
- If all touches are invalid or expired, no attribution wins.
- If affiliate wins, no referral rewards are granted.
- If referral wins, that first paid conversion must not generate affiliate payout attribution.
- The system must record when an affiliate touch becomes sale-attributed so later renewals can preserve affiliate attribution where required.

Required scenario tests:

| Scenario                                                                     | Expected winner |
| ---------------------------------------------------------------------------- | --------------- |
| Affiliate first, referral second, both valid, no prior affiliate SALE        | Referral        |
| Affiliate first, referral second, both valid, affiliate SALE before referral | Affiliate       |
| Referral first, affiliate second, both valid, no prior affiliate SALE        | Referral        |
| Only affiliate valid                                                         | Affiliate       |
| Only referral valid                                                          | Referral        |
| All touches expired or invalid                                               | None            |

## Data Model Plan

Add new referral-specific tables rather than overloading current affiliate tables.

### 1. Attribution Touch Ledger

Add a table such as `kiloclaw_attribution_touches` with fields along these lines:

- `id`
- `anonymous_id` nullable
- `user_id` nullable until association
- `touch_type` (`affiliate` | `referral`)
- `provider` (`impact_performance` | `impact_advocate`)
- `opaque_tracking_value`
- `tracking_value_truncated` or length metadata if needed
- referral metadata fields when present:
  - `rs_code`
  - `rs_share_medium`
  - `rs_engagement_medium`
- affiliate metadata fields when present:
  - `im_ref`
- shared sanitized metadata:
  - `utm_*`
  - landing path
- `touched_at`
- `expires_at`
- `sale_attributed_at` nullable for affiliate touches
- `created_at`

This is the source for KiloClaw conversion-time attribution resolution.

### 2. Participant Registration and Referral Relationship State

Add local tables for:

- Advocate participant registration/upsert attempts and retry state
- local referral relationships between referrer and referee when known
- Impact-facing identifiers and statuses used only for support/reporting
- conversion reporting attempts and retry state

Suggested separation:

- `impact_advocate_participants`
- `impact_advocate_registration_attempts`
- `kiloclaw_referrals`
- `impact_conversion_reports`

Keep Impact-facing fields clearly non-authoritative.

### 3. Conversion Decision Ledger

Add a conversion-level table to represent the result of evaluating a candidate first paid conversion, for example `kiloclaw_referral_conversions`:

- `id`
- `referee_user_id`
- `referrer_user_id` nullable
- `source_touch_id` nullable
- `winning_touch_type` (`referral` | `affiliate` | `none`)
- `source_payment_id` / invoice / billing-period identity
- `qualified` boolean
- disqualification reason nullable
- `converted_at`
- `created_at`

This lets the system atomically record the conversion evaluation even when no reward is granted.

### 4. Beneficiary Decision Ledger

Add a table such as `kiloclaw_referral_reward_decisions` to record both beneficiary outcomes atomically:

- `id`
- `conversion_id`
- `beneficiary_user_id`
- `beneficiary_role` (`referrer` | `referee`)
- `outcome` (`granted` | `cap_limited` | `disqualified`)
- `reason` nullable
- `months_granted`
- unique key on `conversion_id + beneficiary_role`

### 5. Reward Ledger

Add a table such as `kiloclaw_referral_rewards` for granted rewards only:

- `id`
- `conversion_id`
- `decision_id`
- `beneficiary_user_id`
- `beneficiary_role`
- `months_granted`
- `status` (`pending` | `earned` | `applied` | `reversed` | `expired` | `canceled` | `review_required`)
- `applies_to_subscription_id` nullable
- `earned_at`
- `applied_at` nullable
- `reversed_at` nullable
- `expires_at` nullable
- `review_reason` nullable
- unique key on conversion + beneficiary role

### 6. Reward Application Audit

Add a table such as `kiloclaw_referral_reward_applications`:

- `id`
- `reward_id`
- `beneficiary_user_id`
- `subscription_id`
- previous renewal / period boundary
- new renewal / period boundary
- local billing operation identifiers
- Stripe identifiers / idempotency keys where applicable
- `applied_at`

## Billing Design

The free month is a renewal-boundary extension, not an account credit.

### General Rules

- Each reward delays the next unpaid renewal boundary by exactly one calendar month.
- Rewards must not modify finalized invoices or already-funded periods.
- Rewards apply only to KiloClaw billing, not inference usage, Kilo Pass, team plans, or non-KiloClaw purchases.
- Multiple rewards may stack.
- Reward application must be idempotent and auditable.
- If the beneficiary is canceled or canceling before application, keep the reward pending until they again have an active eligible personal KiloClaw subscription.

### Month-to-Month

- One reward delays the next monthly renewal by one calendar month.
- Stacking delays by one calendar month per reward.

### Six-Month Commitment

- One reward delays the next six-month renewal by one calendar month.
- Rewards do not change commitment shape and do not prorate the next invoice.

### Pure-Credit KiloClaw

- Update local renewal state so the credit-renewal sweep does not deduct hosting credits until the extended renewal time.
- Keep this entirely in local billing state.

### Stripe-Funded or Hybrid KiloClaw

- Reward application must keep local billing state and Stripe billing state consistent.
- Do not allow a local-only renewal delay while Stripe still charges on the original schedule.
- Use deterministic idempotency keys for Stripe operations.
- Design choice for the Stripe mechanism remains an implementation task, but the outcome is fixed by the spec: one calendar-month delay at the next unpaid renewal boundary without breaking current billing invariants.

## Attribution and Conversion Flow

### Landing / Touch Capture

1. Visitor lands from an affiliate or referral link.
2. Capture the touch with `touched_at` and `expires_at = touched_at + 30 days`.
3. Preserve the touch across auth redirects and callback URLs.
4. Associate anonymous touches to the user during signup or first authenticated request after signup.
5. Treat tracking identifiers as opaque; enforce max length and redact logs.
6. Do not grant anything at capture time.

### Signup

1. Create the Kilo user.
2. Associate captured touches with the user.
3. If `_saasquatch` is present, enqueue Register Participant delivery before signup completes.
4. Persist registration retry state.
5. Do not block user access on external Impact delivery.
6. Do not grant free months at signup.

### First Paid KiloClaw Conversion

1. Detect the referee's first confirmed paid personal KiloClaw payment period.
2. Verify referee eligibility, including brand-new-account checks and previously deleted-user disqualification.
3. Resolve attribution using the referral-priority model.
4. If affiliate wins:
   - record the affiliate touch as sale-attributed for future protection,
   - emit existing affiliate Performance conversion behavior,
   - do not grant referral rewards.
5. If referral wins:
   - ensure the qualifying `Sale (71659)` conversion is reported through the existing server-side Performance pipeline,
   - create the local conversion record,
   - atomically record both beneficiary outcomes,
   - create reward ledger rows for granted outcomes,
   - leave reward application to the next unpaid renewal boundary.
6. If no touch wins:
   - record the evaluation result,
   - do not grant referral rewards,
   - do not create affiliate payout attribution.

### Reward Application

1. A billing job or side-effect handler processes earned/pending rewards.
2. When the beneficiary has an eligible unpaid renewal boundary, extend that boundary by one calendar month.
3. Update reward status and write audit rows.
4. Keep retryable failures pending unless they are permanent and auditable.

### Refunds, Chargebacks, and Fraud

1. If the qualifying Stripe payment is charged back, cancel pending or earned-but-unapplied rewards.
2. If a qualifying payment is refunded or fraud-marked before application, cancel the unapplied rewards.
3. If a reward was already applied, move it to `review_required` instead of automatically clawing it back.
4. Reverse Impact actions with Impact's reverse-action mechanism when needed.
5. Make reversal handling idempotent.

## Impact Integration Details

### Environment Variables

Likely required env vars:

- `IMPACT_ADVOCATE_TENANT_ALIAS`
- `IMPACT_ADVOCATE_PROGRAM_ID=51699`
- `IMPACT_ADVOCATE_ACCOUNT_SID`
- `IMPACT_ADVOCATE_AUTH_TOKEN`
- `IMPACT_ADVOCATE_WIDGET_ID=p/51699/w/referrerWidget`
- `NEXT_PUBLIC_IMPACT_UTT_ID=A7138521-9724-4b8f-95f4-1db2fbae81141`

Existing Performance values remain in use:

- `IMPACT_CAMPAIGN_ID=50754`
- `IMPACT_ACTION_TRACKER_*` for `71655`, `71656`, `71658`, and `71659`

If reward-bearing referral configuration is absent in an environment where the referral program is enabled, fail closed for reward issuance and log the configuration failure.

### Server-Only Advocate Client

Add a server-only module such as `apps/web/src/lib/impact-advocate.ts`.

Responsibilities:

- build Register Participant requests
- sign Verified Access JWTs
- manage retryable registration state
- optionally fetch support/reconciliation data from Impact APIs
- reverse Impact actions when required
- redact sensitive data in logs

### Verified Access JWT Issuing

Add a server route or tRPC procedure to issue short-lived widget JWTs.

Requirements:

- include Account SID as `kid` header
- sign with server-side credentials only
- set the `user` payload using the spec's identity contract
- do not let the client alter the identity payload

### Reconciliation

Do not make webhooks part of the core design.

Instead:

- keep local state authoritative
- use dashboard exports or Impact API reads for manual reconciliation and support investigation
- optionally store Impact-facing status fields only for comparison and support
- never let Impact-facing status override local eligibility, cap, attribution, or billing fulfillment rules

## Spec Alignment Work

`.specs/kiloclaw-referrals.md` already exists and is authoritative.

Implementation follow-up should update sibling specs only where cross-domain behavior now needs explicit references:

- `.specs/impact-affiliate-tracking.md`
  - document that KiloClaw referral-program conversions use the referral-priority override from the referral spec
- `.specs/kiloclaw-billing.md`
  - document the billing-extension fulfillment behavior and any new invariants needed for reward application

Do not restate or redefine referral business rules outside the referral spec.

## GDPR and PII

Any new tables storing user IDs, emails, referral relationships, IPs, cookies, or Impact identifiers must be included in GDPR deletion/anonymization flows.

Required code updates:

- `apps/web/src/lib/user.ts`
- `apps/web/src/lib/user.test.ts`

Implementation requirements:

- anonymize or delete Advocate participant records, touches, referral relationships, reconciliation payloads containing PII, and reward records as required by policy
- delete or anonymize plain email retained for Advocate compatibility
- retain only the legal-approved non-PII tombstone / irreversible hash needed for previously deleted-user disqualification
- never log referral tracking values or sensitive headers in raw form

## Operational Considerations

### Configuration Safety

- Add explicit checks for missing Advocate credentials and required reward-bearing configuration.
- Do not silently mark registration, conversion delivery, or reward application as complete when configuration is missing.
- Expose operator-visible retryable versus terminal failure states.

### Observability

Track at minimum:

- referral touch captured
- affiliate touch captured
- touch associated to user
- participant registration enqueued / succeeded / retrying / terminal failure
- attribution winner at conversion time
- conversion report queued / delivered / failed
- reward decision recorded
- referrer cap limited
- reward applied
- reward canceled
- reward moved to `review_required`

### Internal Referral System Isolation

Before launch, ensure the existing internal referral-code system cannot grant additional KiloClaw rewards for conversions governed by this program.

## Implementation Phases

### Phase 0 - Confirm External Contract and Launch Inputs

- Confirm tenant alias, credentials, Verified Access setup, and required dashboard configuration with Impact.
- Confirm the launch uses widget `p/51699/w/referrerWidget`.
- Confirm manual reconciliation path via exports/API reads.
- Confirm launch feature flag and environment gating.
- Confirm operator process for explicit support overrides on otherwise ineligible conversions.

### Phase 1 - Schema and Spec Cross-References

- Add referral tables for touches, participant registration state, referrals, conversion decisions, beneficiary decisions, rewards, and reward application audit.
- Update sibling specs to reference the referral spec where needed.
- Generate migrations with `pnpm drizzle generate`.
- Update GDPR deletion flow and tests.

### Phase 2 - Touch Capture and Identity

- Capture referral and affiliate touches with exact 30-day expiry.
- Preserve touches across auth flows.
- Associate anonymous touches to users on signup / first authenticated request.
- Update `ImpactIdentify` behavior for anonymous empty strings, logged-in SHA-1 email, and stable `customProfileId`.
- Add max-length enforcement and log redaction for opaque values.

### Phase 3 - Advocate Widget and Participant Registration

- Add the server-only Advocate client.
- Add Verified Access JWT issuance.
- Add the referral UI entry point that renders the widget.
- Add Register Participant enqueueing and retry handling for `_saasquatch` signups.
- Add tests for JWT payload/header and registration payload construction.

### Phase 4 - Conversion-Time Attribution and Reward Decisions

- Implement first paid personal KiloClaw conversion detection.
- Implement the referral-priority attribution resolver.
- Record sale-attributed affiliate touches.
- Atomically persist the conversion record and both beneficiary decisions.
- Queue or dispatch the corresponding Impact Performance conversion.
- Add tests for all required attribution scenarios and ineligibility paths.

### Phase 5 - Billing Fulfillment

- Implement the reward ledger state machine.
- Apply rewards to the next unpaid renewal boundary.
- Handle inactive/canceling beneficiaries by keeping rewards pending.
- Enforce the 12-month referrer cap atomically.
- Implement month-to-month, six-month, pure-credit, Stripe-funded, and hybrid fulfillment paths.
- Add audit trails and idempotency protections.

### Phase 6 - Reversals and Support Workflows

- Implement chargeback/refund/fraud handling.
- Move already-applied rewards to `review_required`.
- Add operator-visible support state and reason capture.
- Implement Impact reverse-action support where needed.

### Phase 7 - Verification and Launch

- Run `pnpm typecheck` at minimum.
- Run targeted tests for referral, affiliate, billing, and GDPR changes.
- Run `pnpm format`.
- Run `pnpm validate` before launch if the scope warrants it.
- Execute the Impact E2E checklist:
  - load widget,
  - copy share link,
  - open share link in incognito,
  - verify `_saasquatch` capture,
  - sign up referee,
  - confirm participant registration,
  - complete first paid personal KiloClaw conversion,
  - confirm local conversion decision,
  - confirm local reward decisions and billing application,
  - confirm Impact reporting landed.

## Test Plan

Add tests for:

- referral parameter capture with `_saasquatch` treated as opaque
- affiliate parameter capture with 30-day expiry
- cross-auth touch preservation
- anonymous-to-user touch association
- `ImpactIdentify` anonymous empty-string behavior
- `ImpactIdentify` logged-in SHA-1 email behavior
- stable anonymous and logged-in `customProfileId`
- Verified Access JWT payload/header generation
- Register Participant payload and retry behavior
- conversion-time attribution resolver
- the six required attribution scenarios from the spec
- brand-new referee eligibility
- previously deleted-user disqualification via tombstone hash
- self-referral disqualification
- personal subscription only
- first paid monetized conversion only
- no reward on trial start, signup, comped periods, or renewals
- atomic dual-beneficiary decision recording
- referrer 12-month cap enforcement under concurrency
- month-to-month reward application
- six-month commitment reward application
- pure-credit reward application
- Stripe-funded / hybrid reward application
- cancellation / pending reward behavior
- chargeback / refund / fraud handling
- `review_required` transitions for already-applied rewards
- GDPR deletion / anonymization of referral data
- internal referral system isolation for KiloClaw conversions

Regression tests:

- existing affiliate dispatch flows
- existing KiloClaw trial/start/sale behavior
- existing credit billing lifecycle
- existing Stripe handlers

## Open Implementation Questions

These are implementation questions only; business rules remain fixed by the spec.

- What exact maximum length should be enforced for opaque tracking values?
- Which existing user/session identifier is the best source for the stable anonymous `customProfileId`?
- What is the safest Stripe mechanism for delaying the next unpaid renewal boundary for Stripe-funded and hybrid subscriptions?
- Which worker/job boundary should own reward application retries versus conversion-report retries?
- Do we want a dedicated conversion-decision table plus decision table, or can the same atomic guarantees be achieved cleanly with a narrower schema?
- Which admin surface should expose retryable registration/reporting failures and `review_required` rewards?

## Rollout Plan

1. Ship behind a feature flag.
2. Enable in staging/test Impact environment first.
3. Run end-to-end referral and affiliate-vs-referral attribution tests.
4. Enable for internal users.
5. Enable for a small production cohort.
6. Monitor attribution outcomes, reward decision counts, reward application correctness, retry queues, and support volume.
7. Roll out broadly once local state and Impact reporting reconcile cleanly.

## Final Notes

The implementation should keep local state authoritative at every critical decision point:

- touch capture
- user association
- conversion-time attribution
- referee/referrer eligibility
- cap enforcement
- reward decision recording
- billing fulfillment
- reversal handling

Impact Advocate remains a valuable integration for sharing UX, participant registration, and reporting, but it should not own the product logic or billing effects governed by `.specs/kiloclaw-referrals.md`.
