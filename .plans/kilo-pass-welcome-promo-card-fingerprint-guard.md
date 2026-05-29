# Kilo Pass Welcome Promo Reusable Payment-Fingerprint Guard

## Status

Implementation-ready plan. The product-policy and UX decisions from the review session are confirmed below.

## Confirmed Decisions

- A reusable payment instrument's one-time Kilo Pass welcome-promo opportunity is claimed by the first account whose positively paid monthly Stripe Kilo Pass invoice settles using a supported Stripe fingerprint (`card`, `sepa_debit`, `us_bank_account`, `bacs_debit`, or `au_becs_debit`).
- The welcome-promo credits are still issued at the existing usage-threshold crossing, not immediately at invoice settlement.
- A second account that buys with an already-claimed supported payment fingerprint must be told that it does not qualify for the welcome promo.
- The ineligibility warning may be shown after successful payment on the existing `/payments/kilo-pass/awarding` return flow; a pre-payment warning is not required because Stripe-hosted Checkout does not expose the chosen funding instrument to Kilo before payment.
- A second account funded by an already-claimed instrument receives base credits and loses the introductory `50%` welcome promo; it follows the same ordinary monthly-ramp behavior as a returning subscriber on the same account (`5%` in streak month 1 currently).
- The fingerprint restriction applies only to monthly Kilo Pass first-issuance free credits; annual Kilo Pass monthly benefits remain unchanged.
- Shared household, company, or other jointly used payment instruments intentionally receive only one introductory monthly free-credit opportunity total; later legitimate users of the same instrument are ineligible under this anti-abuse policy.
- Once claimed by a positively paid qualifying monthly purchase, the instrument's introductory opportunity is not restored by a later refund, dispute, fraud determination, cancellation, or unused bonus; adverse-payment credit recovery is a separate concern.
- A monthly purchase using an already-claimed supported payment fingerprint is not an eligible Kilo Pass referral conversion and creates no Kilo Pass referral reward for either the referee or referrer.
- A confirmed payment method without a supported reusable fingerprint remains subject to account-level history only. An unresolvable paid settlement must not be treated as confirmed welcome-promo eligibility.
- A zero-value invoice must not claim a fingerprint or unlock the introductory promo. A later positively paid settlement can still claim its instrument fingerprint for future cross-account enforcement.
- The durable claimed fingerprint remains retained after account deletion so deleting an account cannot restore introductory or referral-conversion eligibility for that instrument; direct user identity references in the new claim record must be removed or nulled during soft deletion if stored.
- Customer-facing surfaces show only eligibility and warning language; they never expose the fingerprint or another account. Support/admin uses decision/audit context and existing restricted payment-method tooling rather than new fingerprint disclosure.
- Settled-payment claim timing means a first purchaser reserves eligibility even if another account crosses the usage threshold sooner.

## Goal

Prevent a reusable Stripe payment instrument from unlocking the Kilo Pass initial-month welcome bonus more than once across Kilo accounts, while keeping ordinary Kilo Pass purchases and non-welcome recurring bonus behavior working as intended.

## Current Behavior

- Monthly Stripe Kilo Pass purchase settlement runs through `handleKiloPassInvoicePaid()` in `apps/web/src/lib/kilo-pass/stripe-handlers-invoice-paid.ts`.
- The paid invoice creates the subscription/monthly issuance, grants only base credits, and sets `kilocode_users.kilo_pass_threshold`.
- The first-month 50% welcome bonus is not granted at checkout; it is later calculated and issued from `maybeIssueKiloPassBonusFromUsageThreshold()` in `apps/web/src/lib/kilo-pass/usage-triggered-bonus.ts` after qualifying usage.
- Today the first-month eligibility check prevents a second historical Kilo Pass subscription for the same user from getting the `50%` welcome promo, but that returning purchase can still receive the ordinary monthly-ramp bonus (currently `5%` for streak month 1). It does not detect reuse of the same Stripe payment instrument by another user.
- Stripe card fingerprints are already stored in `payment_methods.stripe_fingerprint`. Stripe also exposes reusable fingerprints for `sepa_debit`, `us_bank_account`, `bacs_debit`, and `au_becs_debit`; excluding those supported signals would leave an avoidable cross-account abuse path.
- `.specs/impact-referrals.md` requires eligible first-time monthly subscribers to keep the first-month welcome promo. A reusable-payment-fingerprint exclusion must be explicit there so the eligibility rule is authoritative and does not accidentally break referral semantics.

## Preliminary Policy Boundary

- Guard only the introductory `50%` welcome-promo treatment when a positively paid monthly Kilo Pass uses an already-claimed supported payment fingerprint: paid base credits remain and the ordinary monthly-ramp bonus remains available, matching existing returning-account behavior.
- Do not restrict annual Kilo Pass monthly benefits based on fingerprint reuse; those recurring benefits remain part of the paid annual plan.
- A monthly purchase made with an already-claimed supported fingerprint is ineligible for source-conversion referral rewards for both sides; this prevents a referred-account farm from bypassing the welcome-offer restriction.
- Referral rewards already earned from an unrelated eligible conversion are not addressed by the source-purchase guard and continue to follow existing fulfillment rules.
- Use the Stripe fingerprint of the supported reusable payment instrument that actually funds a positively paid monthly Kilo Pass invoice, rather than any payment method merely attached to the Stripe customer.
- Treat the first qualifying positive Kilo Pass settlement with a supported fingerprint as consuming that instrument's welcome-promo opportunity, even if that buyer never reaches the usage threshold needed to redeem the bonus.
- Keep actual bonus-credit issuance usage-triggered for the winning account; settlement records eligibility but does not grant free credits immediately.
- For a later monthly purchase on a reused supported fingerprint, allow the subscription and base credits, but calculate usage-triggered first-month bonus eligibility as returning-subscriber behavior: no `50%` welcome promo, ordinary monthly-ramp bonus available.
- Retain the existing account-level historical-subscription behavior for all monthly payment methods: a `kilo_user_id` that already has a prior Kilo Pass subscription cannot receive the `50%` welcome promo again, but remains eligible for its ordinary first-month ramp bonus.
- Apply that same bonus calculation outcome to a first-time account paying with an already-claimed supported fingerprint.
- Support fingerprint claims initially for `card`, `sepa_debit`, `us_bank_account`, `bacs_debit`, and `au_becs_debit`, using either settled PaymentIntent PaymentMethods or direct Charge payment details.
- For a confirmed settled method without a supported reusable fingerprint, do not deny the welcome benefit merely because cross-account matching is unavailable; allow the `50%` first-account benefit, while repeat purchases on the same account retain existing ordinary-ramp behavior without the welcome promo.
- For a positive paid settlement that cannot be resolved to a confirmed payment-method outcome, do not silently make the introductory promo eligible; keep processing retryable or otherwise fail closed.

### Annual subscription threat analysis

- Annual Kilo Pass does not expose the same cheap account-farming welcome-promo vector: `KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT` is a recurring `50%` annual-plan benefit, not a one-time signup uplift, and annual base credits are released monthly after the annual payment is settled.
- Creating multiple annual accounts with the same card ordinarily requires paying for multiple annual subscriptions and yields proportionally purchased entitlements; blocking this would change the annual product promise rather than close a welcome-offer loophole.
- Refund/chargeback abuse is a distinct adverse-payment risk. Admin cancel/refund currently cancels, refunds, zeroes remaining balance, and blocks the account, while the general Stripe dispute handling found during planning primarily reverses affiliate/referral effects and does not establish a general Kilo Pass credit clawback policy. This risk exists for monthly accounts as well and is cheaper to attempt there.
- Recommended boundary: exclude annual monthly benefits from this payment-fingerprint claim rule and separately assess whether Kilo Pass needs automated refund/dispute entitlement reversal.

## Proposed Design

### 1. Represent a durable reusable-payment-fingerprint welcome-promo claim

Prefer a dedicated, narrowly-scoped anti-abuse record rather than reusing `payment_methods.eligible_for_free_credits`.

Candidate record: `kilo_pass_welcome_promo_payment_fingerprint_claims`

| Field | Purpose |
|---|---|
| `stripe_payment_method_type` | Supported Stripe instrument type; paired with the fingerprint to avoid cross-type collisions. |
| `stripe_fingerprint` | Supported reusable Stripe instrument identifier; uniquely claims one welcome opportunity within its instrument type. |
| `first_stripe_invoice_id` | Idempotent source paid invoice that made the claim. |
| `first_kilo_pass_subscription_id` | Subscription responsible for the claim, retained or nulled according to deletion policy. |
| `first_kilo_user_id` | Optional audit reference, retained or nulled according to deletion policy. |
| `claimed_at` | Audit timestamp. |

Required properties:

- Unique constraint on (`stripe_payment_method_type`, `stripe_fingerprint`) so concurrent positively paid purchases using the same instrument cannot both receive first-instrument eligibility without falsely colliding unrelated instrument types.
- Unique constraint on the source invoice ID so webhook retries are idempotent.
- Retain the fingerprint and source invoice identity after account deletion as anti-abuse evidence, consistent with the existing preservation of `payment_methods.stripe_fingerprint` for fraud detection.
- If the claim stores direct `first_kilo_user_id` or identifying user-linked references, null or anonymize those in `softDeleteUser` and add the required GDPR regression test while preserving enforceability by fingerprint.
- Do not store full card data, card numbers, or secret payment credentials.

Alternative considered but not recommended: add the fingerprint/eligibility result directly to `kilo_pass_subscriptions` and search prior subscriptions. That loses anti-abuse history when user/subscription deletion cascades occur unless additional retention behavior is introduced, and it mixes payment evidence with subscription state.

### 2. Claim eligibility at settled initial payment time

In the Stripe initial monthly invoice-paid processing path:

1. Identify whether the invoice represents the first paid issuance for a monthly Stripe Kilo Pass subscription rather than a renewal, proration, scheduled change, or annual subscription.
2. Require `invoice.amount_paid > 0` before claiming a fingerprint; a zero-value first issuance records a non-promo-qualified outcome and does not claim an instrument.
3. Resolve the PaymentIntent or direct Charge that actually settled the invoice and extract a reusable Stripe fingerprint for supported instrument types.
4. Atomically insert or retrieve the instrument-level claim during every positive monthly settlement so an instrument first used on a later paid invoice is still consumed for future accounts.
5. Persist the first-issuance promo reason so later usage-triggered processing does not need to call Stripe or infer settlement state; do not treat unresolved settlement evidence as eligible.
6. Include audit data that indicates the eligibility reason (`first_payment_fingerprint_claim`, `fingerprint_previously_claimed`, `missing_fingerprint`, `no_positive_settlement`, etc.) and the relevant invoice/subscription identifiers without logging sensitive payment payloads.

The precise persisted eligibility location is open: either fields on the first `kilo_pass_issuances` row (decision belongs to the issuance) or a separate decision table referencing the claim and issuance. A decision record is clearer if skip reasons and administrative review matter.

### 3. Apply the decision during usage-triggered bonus computation

Update monthly first-month decision handling so that:

- Existing same-user historical subscription disqualification remains in place.
- A first-month issuance only receives the 50% welcome promo when its positively paid settled-payment decision is eligible.
- A reused-fingerprint first month is disqualified from the introductory `50%` welcome promo, but receives the ordinary month-1 monthly-ramp percentage through the usage-triggered bonus path, matching current returning-subscriber behavior.
- A zero-value first issuance or an unresolved positive settlement does not unlock the introductory promo.
- Subsequent months follow current streak behavior unchanged.
- Referral bonus mutual-exclusion rules continue to take precedence per `.specs/impact-referrals.md`; a later referral reward must not be consumed retroactively into the source conversion issuance.

### 4. Warn a reused-instrument buyer

The current purchase flow uses Stripe-hosted Checkout in `apps/web/src/routers/kilo-pass-router.ts`. The application selects the price before redirecting to Stripe, but it does not know which payment instrument will settle the purchase until Checkout completes and the paid invoice/payment method can be inspected. Therefore:

- Show the reliable fingerprint-reuse decision immediately after paid settlement on the existing `/payments/kilo-pass/awarding` return flow and retain it on the Kilo Pass details/history surface.
- Do not redesign checkout for a pre-payment warning: this is not available with the current hosted Checkout flow because the user may choose or enter the funding instrument inside Stripe after leaving Kilo.
- Warning copy should state that the subscription succeeded but the introductory welcome bonus is unavailable because the payment method has already been used for that offer; it should not imply that ordinary ongoing bonus benefits are removed, and must not expose payment fingerprints or another account's existence.

### 5. Update business rules and observability

- Extend `.specs/impact-referrals.md` welcome-promo language to state that first-time monthly subscribers are eligible only if the reusable settled payment fingerprint has not previously claimed a Kilo Pass welcome-promo/referral-conversion opportunity, with explicit treatment for missing fingerprints and unresolved settlements.
- Extend `.specs/impact-referrals.md` conversion rules so a reused-fingerprint monthly Stripe payment is disqualified from Kilo Pass referral conversion and generates no reward for either side.
- If Kilo Pass has or gains a dedicated product spec, centralize the payment-fingerprint rule there and reference it from referral rules.
- Add structured Kilo Pass audit entries or payload reasons for allowed/skipped welcome-promo decisions so support can explain why a 50% welcome promo was not applied.
- Preserve only the minimum durable fingerprint-derived anti-abuse data required for enforcement; do not expose fingerprints to customer UI.

## Implementation Areas

| Area | Expected change |
|---|---|
| `packages/db/src/schema.ts` | Add durable reusable-payment-fingerprint claim and first-issuance decision persistence with uniqueness/indexing. |
| `packages/db/src/migrations/` | Generate migration via `pnpm drizzle generate`; do not hand-write generated DDL. |
| `apps/web/src/lib/kilo-pass/stripe-handlers-invoice-paid.ts` | Gate on positive payment, resolve supported settled instrument fingerprints, and atomically establish promo eligibility. |
| `apps/web/src/lib/kilo-pass/stripe-handlers-utils.ts` | Extract fingerprints from PaymentIntent and Charge representations for supported instrument types. |
| `apps/web/src/lib/kilo-pass/usage-triggered-bonus.ts` | Require stored settlement-derived eligibility before applying the first-month 50% welcome percentage. |
| `apps/web/src/lib/kilo-pass/bonus.ts` | If needed, make welcome-promo qualification an explicit input to pure decision logic. |
| `apps/web/src/routers/kilo-pass-router.ts` | Return the settled welcome-promo eligibility/warning state required by the post-checkout surface. |
| `apps/web/src/app/payments/kilo-pass/awarding/KiloPassAwardingCreditsClient.tsx` | Display the introductory-offer ineligibility warning after a reused-fingerprint settlement. |
| `apps/web/src/lib/kilo-pass/*test.ts` | Cover supported instrument types, Charge representations, zero-value settlement, reuse, retry, concurrency, renewal, annual, and referral-interaction cases. |
| `apps/web/src/lib/user/index.ts` and tests | Update only if new retained user-linked payment anti-abuse data must be anonymized or preserved during soft deletion. |
| `.specs/impact-referrals.md` | Define reusable-payment-fingerprint welcome-promo eligibility and referral interaction behavior. |

## Required Test Matrix

| Scenario | Expected result under recommended boundary |
|---|---|
| First positive monthly Kilo Pass settlement using a new supported fingerprint | Welcome promo remains available once usage threshold is crossed. |
| Different account pays monthly using a previously claimed supported fingerprint, including legitimate shared-instrument use | Base credits granted; welcome ineligibility warning shown after settlement; `50%` welcome promo denied; ordinary first-month ramp bonus remains available. |
| Same account buys again using an instrument not otherwise disqualified, or a confirmed method without a supported fingerprint | `50%` welcome promo denied; existing ordinary first-month ramp bonus remains available. |
| Two initial purchases on separate accounts settle concurrently with the same supported fingerprint | Exactly one fingerprint claim is eligible. |
| Webhook retry for winning invoice | Same eligibility decision returned; no duplicate claims or bonus. |
| Payment instrument attached before purchase but never used for Kilo Pass | Does not by itself consume Kilo Pass welcome-promo eligibility. |
| First positive settlement via `card`, `sepa_debit`, `us_bank_account`, `bacs_debit`, or `au_becs_debit` | Its reusable fingerprint participates in the same one-claim guard. |
| Positive settlement through a confirmed method without a supported usable fingerprint on an otherwise first-time account | Existing account-level eligibility applies; first-month promo remains available because no supported cross-account signal exists. |
| Zero-value initial monthly invoice | No fingerprint claim and no introductory promo eligibility; later positive settlements can consume fingerprints for future-account enforcement. |
| Positive settlement evidence cannot be resolved | Does not silently unlock introductory eligibility; processing remains fail-closed/retryable. |
| Paid settlement represented by a Stripe Charge rather than PaymentIntent | Supported reusable fingerprint is extracted and enforced identically. |
| Monthly renewal using an already claimed fingerprint | No changed first-month outcome; durable claim remains idempotent. |
| First positive monthly settlement after an earlier zero-value issuance | Consumes the supported fingerprint for future accounts without retroactively granting a welcome promo. |
| Yearly Kilo Pass using previously claimed fingerprint | Existing yearly benefit behavior unchanged. |
| Referral-attributed first monthly purchase on reused supported fingerprint | Welcome ineligibility warning shown; `50%` welcome promo denied but ordinary ramp remains; conversion disqualified; no referral reward for either side. |
| Purchase later refunded, disputed, fraud-marked, canceled, or never reaches bonus threshold | Original fingerprint claim remains consumed; no later account can receive first-month promo through that instrument. |
| User deletion after claiming welcome opportunity, then fingerprint reused | Fingerprint/source claim is retained, identity references are anonymized or nulled if stored, and the reused instrument remains ineligible. |

## Decisions Resolved In Grill Session

All primary product-policy decisions required for implementation are resolved. During implementation, code-level choices may still determine whether the eligibility decision belongs directly on the first issuance or in a dedicated eligibility/claim relation, provided the confirmed behavior and auditability remain intact.

## Verification After Implementation

- Run the narrow Kilo Pass Stripe invoice, bonus, issuance, and user soft-delete tests impacted by the final design, starting the test Postgres service first if it is not already running.
- Run targeted type checking for the affected web/database packages or `scripts/typecheck-all.sh --changes-only` rather than the full monorepo typecheck by default.
- Run `pnpm format` before committing.
