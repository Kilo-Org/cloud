# Stripe service fee technical integration specification

## Status and authority

Implementation specification for `.plans/service-fees/GOAL.md`, prepared from the repository state on 2026-08-06.

`GOAL.md` is authoritative for product behavior. This document fixes the technical design and execution order. If implementation reveals that a step cannot preserve the goal, stop and revise the spec rather than weakening the behavior in code.

Before changing a scoped area, read its nearest `AGENTS.md`. Database changes must follow `packages/db/AGENTS.md` and the `database-migrations` skill. React changes must follow `apps/web/AGENTS.md` and the `kilo-design-cloud` skill. Test work must follow the `testing-principles` skill.

## Decision record

`docs/adr/0004-stripe-service-fee-assessment.md` is authoritative for architectural decisions and invariants. The table below is a working summary. Update the ADR and this specification when a decision changes.

Resolved during spec review on 2026-08-08. Each entry supersedes earlier drafts of this document.

| ID | Decision | Rationale |
|---|---|---|
| D1 | The fee base follows **recognized product value**. Discounts reduce it; prepaid credit-balance consumption does not. | Preserves the invariant that collected fee equals 5% of product revenue, which is what makes the assessment table reconcilable. Kilo does not use Stripe Billing credit grants today, so this is a forward-looking guard. |
| D2 | **Keep hosted promotion-code entry** for Personal Kilo Pass. Compute the fee from list price and accept that the fee line is discounted along with the product. | Proportional allocation makes the result arithmetically exact for unrestricted coupons, so `GOAL.md`'s proportional-reduction requirement is met without server-side discount knowledge. Avoids private-preview dependencies and avoids rewriting a live payments path. Cost: product-restricted coupons must be prevented operationally. |
| D3 | Chargebacks **reverse the fee** on `charge.dispute.funds_withdrawn`, tracked in the dedicated non-monotonic fee-dispute column. | The money left the account, so leaving it in collected fee revenue overstates the one number this subsystem exists to produce. Keeping the fee consequence separate preserves refund monotonicity when a won dispute restores funds. |
| D4 | On any failure to resolve or apply the confirmed mirrored tax treatment, **fail open in production** exactly as in non-production. | Applies the document's existing fail-open principle consistently. Not collecting a fee for that event is strictly better than mis-taxing customers or blocking payments. |

Two defects were also corrected without requiring a decision: the Stripe wire API version was never pinned, and automatic top-up invoices had two competing fee-attachment paths. Both are addressed below.

## Tax treatment

Finance/tax treatment was confirmed on 2026-08-11: the 5% service-fee line uses the same Stripe `tax_behavior` as the eligible product it accompanies. Keep tax behavior resolution isolated in `tax.ts`.

The repository sets no per-request tax parameters today. There is no `automatic_tax`, `tax_behavior`, `default_tax_rates`, or `tax_rates` in production code; only `tax_id_collection` is used (`apps/web/src/lib/stripe/index.ts`, three call sites, and `apps/web/src/routers/kilo-pass-router.ts`, one). Stripe tax behavior is therefore configured at the account and Price level, not by this codebase. That narrows the work to mirroring, not selecting, a treatment:

- **Top-ups with an explicit amount** build the principal as inline `price_data` with no `tax_behavior` (`apps/web/src/lib/stripe/index.ts:1503-1513`). A fee line built the same way inherits identical treatment by construction. Nothing to decide and no way for the two to diverge.
- **Default top-up** (`price: STRIPE_TOP_UP_PRICE_ID`) and **Kilo Pass** (`getStripePriceIdForKiloPass()`) reference Price objects that may carry a dashboard-set `tax_behavior`. Here the principal is a Price and the fee is inline `price_data`, so they can diverge. `tax.ts` must retrieve the eligible Price, read its `tax_behavior`, and set the same value on the fee line.

That treatment was confirmed on 2026-08-11 and is recorded in ADR 0004.

**On any tax-resolution or application failure: fail open, identically to non-production.** If the eligible Price cannot be read, its `tax_behavior` is not explicitly `inclusive` or `exclusive`, or the fee line cannot apply the mirrored behavior, do not construct the fee line. The payment proceeds without a fee, the assessment records `missed` with the normal `fee_application_failed` code, and Slack alerts. Do not fail closed on a payment for a fee-domain reason, add a runtime switch, or deploy a guessed fallback.

The design uses explicit fee lines rather than a recurring Stripe subscription item. A fee line is classified by metadata and by the durable assessment, never by its display description alone.

## Fixed constants and vocabulary

Create `apps/web/src/lib/service-fees/constants.ts` with these code-owned constants:

```ts
export const SERVICE_FEE_RATE_BASIS_POINTS = 500;
export const SERVICE_FEE_RATE_DENOMINATOR = 10_000;
export const SERVICE_FEE_ACTIVATION_UNIX_SECONDS = 1_793_491_200; // 2026-11-01T00:00:00Z
export const SERVICE_FEE_DESCRIPTION = 'Service fee (5%)';
export const SERVICE_FEE_METADATA_TYPE = 'kilo-service-fee';
export const SERVICE_FEE_VERSION = '2026-11-01-v1';
```

Do not add an environment variable, PostHog flag, database setting, or other runtime global switch. Rollback is the emergency off mechanism.

### Pin the Stripe API version first

`apps/web/src/lib/stripe-client.ts:13` constructs the client as `new Stripe(stripeSecretKey)` with no `apiVersion`. The string `2025-10-29.clover` is only the SDK's compiled-in default (`node_modules/stripe/cjs/apiVersion.js:5`); it is **not** a pin. Without an explicit `apiVersion`, requests use the Stripe **account** default, which can differ from the installed typings and can be changed from the Stripe dashboard without a deploy.

Every line-shape assumption in this document — `discount_amounts` versus `pretax_credit_amounts`, `pricing.price_details.price`, `parent.subscription_item_details` — depends on that wire contract. Pin it before any fee work:

```ts
export const client: Stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-10-29.clover' });
```

This is Phase 1 step 0. Run the existing Stripe suites immediately after pinning and before adding fee behavior, so any pre-existing drift between the account version and the typings surfaces as an isolated change rather than inside the fee diff.

Use integer minor units throughout the fee domain. The first release supports the current eligible currency, USD.

For an eligible non-USD commercial event, do not compute a fee: skip fee construction, persist outcome `unsupported_currency` with zero amounts, and alert. Do not record `missed`, because `missed` requires a computed `expected_fee_minor > 0` and no trustworthy expected fee exists for an unsupported currency. Never apply USD assumptions to another currency.

### Flow values

Use a closed TypeScript value set and a database check constraint for:

- `personal_top_up`
- `organization_top_up`
- `personal_auto_top_up_setup`
- `organization_auto_top_up_setup`
- `personal_auto_top_up`
- `organization_auto_top_up`
- `personal_kilo_pass`
- `organization_kilo_pass`

### Outcome values

Use a closed value set and `enumCheck()` for:

- `pending`
- `charged`
- `exempt`
- `pre_activation`
- `zero_rounded`
- `unsupported_currency`
- `missed`

This is the only fee-decision state column. There is no separate `application_state`.

The outcome is the fee decision, not payment state. Settlement and refunds have separate columns.

## Architecture

Create a server-only service-fee module under `apps/web/src/lib/service-fees/`:

| File | Responsibility |
|---|---|
| `constants.ts` | Activation, rate, label, metadata keys, version |
| `types.ts` | Closed flow/outcome/owner types and result contracts |
| `calculation.ts` | Pure integer fee and refund calculations |
| `stripe-lines.ts` | Stripe line pagination, classification, net eligible subtotal, tax input extraction |
| `assessments.ts` | Assessment create/upsert/link/settle/refund persistence |
| `checkout.ts` | Checkout assessment preparation and positive fee line construction |
| `invoice-created.ts` | Draft invoice assessment and fee-line attachment |
| `settlement.ts` | Resolve assessment from invoice, PaymentIntent, or charge and mark settlement |
| `refunds.ts` | Observe cumulative Stripe refunds and update assessment state |
| `alerts.ts` | Best-effort Admin Slack notification for missed fees |
| `organization-exemptions.ts` | Exact-organization exemption read and mutation support |

Keep pure arithmetic and line classification free of database and Stripe clients. Pass Stripe and database dependencies into integration helpers where practical so tests do not replace the behavior under test with mocks.

### Processing model

There are three fee-attachment paths:

1. **Interactive Checkout, fee computed before creation**: top-ups and Personal Kilo Pass. Compute the fee from the known list principal before `checkout.sessions.create()`, add a one-time fee line, then persist the returned Checkout Session ID. The returned `created` timestamp is authoritative for the activation boundary.
2. **Kilo-owned invoice billing**: automatic top-ups. Kilo creates the invoice with `auto_advance: false` and pays it directly, so the fee item is attached before `invoices.pay()` and the `invoice.created` webhook must not touch it. See Ownership of invoice fee attachment.
3. **Stripe-owned invoice billing**: renewals, prorations, and capacity changes. Handle `invoice.created` while the invoice is still draft, compute from all invoice lines, attach one non-discountable fee invoice item, persist the assessment, and acknowledge the webhook even when fee work fails.

Settlement uses the assessment prepared by one of these paths. Settlement never recalculates the fee from the gross paid amount.

### Discountable initial fee lines

Subscription-mode Checkout supports neither `add_invoice_items` nor a `discountable` flag on line items (verified against the installed SDK: `SessionCreateParams` has no `add_invoice_items`; `SessionCreateParams.LineItem` has no `discountable`). A one-time fee line on a Checkout Session is therefore **always discountable**, and a promotion code the customer enters on Stripe's hosted page will discount it along with the product.

**This is accepted behavior, not a defect.** For a coupon that discounts the whole invoice, it is arithmetically exact. The fee line sits inside the discounted subtotal, so both lines scale by the same factor and the ratio survives:

`0.05 x list x (1 - d) === 0.05 x (list x (1 - d))`

Worked example, $49.00 Kilo Pass with a 20% promotion code and the fee computed from list price:

| Line | Amount |
|---|---:|
| Kilo Pass | $49.00 |
| Service fee (5%) | $2.45 |
| Subtotal | $51.45 |
| 20% off | -$10.29 |
| **Total** | **$41.16** |

Product recognized $39.20; fee collected $1.96; and 5% of $39.20 is $1.96. `GOAL.md`'s requirement that eligible discounts proportionally reduce the fee is satisfied without the server knowing the discount in advance. A fixed-amount coupon allocated proportionally behaves the same way.

Two consequences follow, and both are load-bearing.

**`expected_fee_minor` is provisional on this path.** It is computed from list price and will exceed the amount actually collected whenever a coupon applies. `charged_fee_minor` must be read from the **settled invoice fee line**, never from what was sent to Stripe. The equality constraint between expected and charged fees does not apply to Checkout-created assessments; see the amount and state checks.

**Product-restricted coupons overcharge and must be prevented operationally.** `Coupon.applies_to.products` limits a coupon to specific products. Such a coupon discounts the Kilo Pass line and leaves the fee line untouched: product $49.00 becomes $39.20, the fee stays $2.45, and the customer pays an effective 6.25% against a published 5%. The restriction cannot be detected before the customer enters the code, and a dashboard-created coupon needs no deploy, so no test in this repository can catch it. Required mitigations:

- Operator runbook entry: never create a coupon with a non-null `applies_to` that covers a fee-bearing product.
- A scheduled read-only check that lists coupons whose `applies_to.products` intersects Kilo Pass or top-up products and alerts Admin Slack.
- An effective-rate assertion at settlement: when `charged_fee_minor` deviates from 5% of `settled_product_minor` by more than one cent, record `service_fee_rate_deviation` and alert. This is the restricted-coupon signature.

Current exposure is low but unverified from this repository. The only coupon in code or `ENVIRONMENT.md` is `STRIPE_KILOCLAW_EARLYBIRD_COUPON_ID` (`apps/web/src/lib/config.server.ts:417`), and KiloClaw is fee-exempt. The two-month Kilo Pass promotion is an internal credits mechanism (`apps/web/src/lib/kilo-pass/usage-triggered-bonus.ts`), not a Stripe coupon. Customer-redeemable promotion codes live in the Stripe dashboard and are invisible here, so treat low exposure as a snapshot, not a guarantee.

A 100% coupon zeroes both lines. That is the correct economic outcome and must be recorded as outcome `charged` with `charged_fee_minor = 0`, not as `missed`.

Renewal and proration invoices are unaffected: they compute from actual discounted draft lines and attach the fee with `discountable: false`, so they are exact by construction. The resulting asymmetry is intentional — initial invoices self-correct through proportional allocation, later invoices are exact because the discount is already known.

### Activation-boundary replacement

Exemption drift needs no special handling: resolving the latest exemption-log row at or before `eligibility_created_at` is already correct for any delivery delay.

Only the activation instant can genuinely straddle a single request. For a Checkout created within one minute of `SERVICE_FEE_ACTIVATION_UNIX_SECONDS`, compare the prepared decision against the returned `session.created`; if they disagree, expire the session and create one replacement with the correct decision. If the replacement also disagrees, fail open with a fee-free session and a missed assessment. Outside that window, do not add an expire/replace round trip to every purchase.

## Database design

Add the following tables to `packages/db/src/schema.ts`. Follow `packages/db/AGENTS.md`.

Use the repository's existing idioms rather than inventing new ones:

- Primary keys: use `assessment_key` directly for assessments. Reuse the shared `idPrimaryKeyColumn` (`packages/db/src/schema.ts:2688`) for exemption-log row IDs. Do not use `defaultRandom()`.
- Timestamps: `timestamp({ withTimezone: true, mode: 'string' })`, with `.defaultNow().notNull()`, and an `$onUpdateFn` returning `now()` for `updated_at`.

```ts
// packages/db/src/schema.ts:2688, reuse for exemption-log IDs rather than redefine
const idPrimaryKeyColumn = uuid()
  .default(sql`pg_catalog.gen_random_uuid()`)
  .primaryKey()
  .notNull();
```
- Closed value sets: use the existing `enumCheck()` helper (`packages/db/src/schema.ts:180`) with a TypeScript enum and `$type<...>()`, as `stripe_dispute_cases` does. Do not hand-roll `check()` for enum columns.
- Amounts: `integer()` minor units.

Generate the migration with `pnpm drizzle generate`. Do not hand-write or edit generated DDL, snapshots, or journal entries. Prefer one generated migration for this branch.

These tables store no user or account PII — only actor foreign keys — so `softDeleteUser` needs no change. State that conclusion in the PR rather than leaving it open.

### `organization_service_fee_exemptions`

Append-only internal exemption log. The newest row is current state; a false row records revocation:

| Column | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key |
| `organization_id` | UUID | Not null; FK to `organizations.id`; `onDelete: restrict` |
| `is_exempt` | boolean | Not null |
| `reason` | text | Not null; trimmed non-empty |
| `changed_by_kilo_user_id` | text nullable | FK to `kilocode_users.id`, `onDelete: set null` |
| `created_at` | timestamptz string | Not null, default now |

Index `(organization_id, created_at desc)`. Resolve current state and historical state with the same deterministic order: `created_at desc, id desc`. Keep the organization-scoped advisory lock around each append. Assessments point directly to the exact exemption row used for their decision.

This table is not `organization_audit_logs`; it must be returned only by `adminProcedure` endpoints. Do not add these fields to `organizations.settings` or expose them through ordinary organization contracts. When an admin is soft-deleted, nulling the actor FK is sufficient. Do not store actor email or name.

### `stripe_service_fee_assessments`

One row per commercial billing event:

| Column | Type | Rules |
|---|---|---|
| `assessment_key` | text | Primary key; not null and immutable |
| `version` | text | Not null; initial value `2026-11-01-v1` |
| `flow` | text | Not null; checked against flow values |
| `outcome` | text | Not null; `enumCheck` against outcome values |
| `currency` | text | Not null, lowercase ISO code |
| `kilo_user_id` | text nullable | FK to `kilocode_users.id`, `onDelete: set null` |
| `organization_id` | UUID nullable | FK to `organizations.id`, `onDelete: restrict` |
| `stripe_customer_id` | text nullable | Indexed |
| `stripe_checkout_session_id` | text nullable | Partial unique index |
| `stripe_invoice_id` | text nullable | Partial unique index |
| `stripe_payment_intent_id` | text nullable | Partial unique index |
| `stripe_charge_id` | text nullable | Partial unique index |
| `stripe_fee_price_id` | text nullable | Checkout-generated fee Price identity |
| `stripe_checkout_fee_line_item_id` | text nullable | Partial unique index |
| `stripe_invoice_fee_line_item_id` | text nullable | Partial unique index |
| `eligibility_created_at` | timestamptz string | Not null; Checkout or invoice creation instant used for cutoff |
| `eligible_subtotal_minor` | integer | Not null, non-negative |
| `expected_fee_minor` | integer | Not null, non-negative; provisional for Checkout flows |
| `charged_fee_minor` | integer | Not null, default 0, non-negative; from the settled fee line |
| `gross_paid_minor` | integer | Not null, default 0, non-negative |
| `settled_product_minor` | integer | Not null, default 0, non-negative |
| `settled_at` | timestamptz string nullable | Set only after positive/zero successful settlement |
| `refunded_product_minor` | integer | Not null, default 0, non-negative; monotonic |
| `refunded_fee_minor` | integer | Not null, default 0, non-negative; monotonic |
| `refunded_gross_minor` | integer | Not null, default 0, non-negative; monotonic |
| `disputed_fee_minor` | integer | Not null, default 0, non-negative; not monotonic |
| `exemption_id` | UUID nullable | FK to the exact exemption log row, `onDelete: restrict` |
| `failure_code` | text nullable | Stable internal reason code, no secret or raw provider payload |
| `metadata` | JSONB | Not null, default `{}`; only non-sensitive reconciliation facts |
| `created_at` | timestamptz string | Not null, default now |
| `updated_at` | timestamptz string | Not null, default now, update hook |

Owner check:

- Personal flows require `kilo_user_id` and forbid `organization_id`.
- Organization flows require `organization_id`; `kilo_user_id` may record the initiating user.

`outcome` is the single decision-state column. Both the earlier `application_state` design and the separate `eligibility` column were removed because they were derivable from `outcome`, expected amount, and attachment success. Outcome values:

| Outcome | Meaning |
|---|---|
| `pending` | Decision made, provider attachment not yet confirmed |
| `charged` | A fee line was accepted by Stripe |
| `exempt` | Suppressed by an exact-organization exemption |
| `pre_activation` | Billing object created before the activation instant |
| `zero_rounded` | Eligible, but 5% rounded to zero cents |
| `unsupported_currency` | Eligible event in a currency this release does not support |
| `missed` | Positive fee should have been charged; fee processing failed open |

Amount and state checks:

- `refunded_fee_minor <= charged_fee_minor` and `refunded_product_minor <= settled_product_minor`. Both refund columns are monotonic.
- `disputed_fee_minor <= charged_fee_minor`. It is **not** monotonic; a dispute resolved in Kilo's favor clears it.
- `outcome = pending` requires `charged_fee_minor = 0` and no settlement.
- `outcome = charged` requires a settled or attached fee line. `charged_fee_minor` may be zero only when `settled_product_minor` is also zero, which is the fully discounted purchase case.
- `outcome = missed` requires `expected_fee_minor > 0`, `charged_fee_minor = 0`, and a non-empty `failure_code`.
- `outcome = zero_rounded` requires `expected_fee_minor = 0`.
- `outcome IN (exempt, pre_activation, zero_rounded, unsupported_currency)` requires `charged_fee_minor = 0`.
- `outcome = exempt` requires `exemption_id`; every other outcome forbids it.
- **Do not constrain `charged_fee_minor <= expected_fee_minor`, and do not require equality.** For Checkout flows `expected_fee_minor` is computed from list price and the collected fee is typically lower because a promotion code discounted the fee line proportionally. Equality holds only for invoice-attached fees. Enforce the relationship through the settlement-time effective-rate assertion instead of a database check.
- Guarded update predicates must reject settlement of a `pending` assessment; it must first reach a terminal outcome. Admin monitoring reports stale pending rows. No cron later attaches their fee.

Assessment keys:

- Checkout: generate `checkout:<uuid>` before the Stripe call and put the UUID in Checkout and PaymentIntent/subscription metadata. It becomes the assessment's `assessment_key`.
- Invoice-only: `invoice:<stripe_invoice_id>`.
- The initial subscription invoice from Checkout must bind to the existing Checkout assessment via propagated assessment metadata, not create an `invoice:*` assessment.

Do not store email, billing address, tax ID, card data, or webhook bodies in the assessment.

### Migration checks

After generation:

1. Confirm the migration creates only the two intended tables, checks, FKs, and indexes.
2. Confirm there is no destructive DDL.
3. Run `pnpm drizzle:verify-bootstrap` if the branch migration changes bootstrap behavior.
4. Run `packages/db/src/schema.test.ts` and package typecheck.

## Pure calculation contracts

Implement and unit-test these functions in `calculation.ts`.

### Fee rounding

```ts
calculateServiceFeeMinor(eligibleSubtotalMinor: number): number
```

Requirements:

- Input is a non-negative safe integer.
- Return `floor((eligibleSubtotalMinor * 500 + 5_000) / 10_000)` using `bigint` intermediates, then convert back only after a safe-integer check.
- This is round-half-up for a positive 5% amount.
- Calculate once on the aggregate eligible subtotal, not once per line.
- Return zero for a zero or sub-ten-cent subtotal where 5% rounds below one cent.

Do not use binary floating-point multiplication by `0.05` for persisted amounts.

### Net line amount

```ts
getNetPretaxLineAmountMinor(line: Stripe.InvoiceLineItem): number
```

Use the Stripe line's signed pretax amount after discounts only. On the pinned Stripe API version, `discount_amounts` are also represented as `pretax_credit_amounts` entries of type `discount`; subtract each economic adjustment exactly once:

```text
line.amount
- sum(line.pretax_credit_amounts[] where type === 'discount' -> amount)
```

If a fixture/provider shape has `discount_amounts` but no matching discount pretax-credit entries, subtract the `discount_amounts` fallback. Never subtract both representations of the same discount.

**The `type === 'discount'` filter is required, not an optimization.** `PretaxCreditAmount.type` is `'credit_balance_transaction' | 'discount'` (`node_modules/stripe/types/InvoiceLineItems.d.ts:168`). The fee tracks **recognized product value**, not cash received, so prepaid balance consumption must not shrink the fee base:

- A **discount** reduces the price, so it reduces the fee base.
- A **credit balance transaction** (Stripe Billing credit grant) is a payment method, not a price reduction. A customer redeeming $49 of prepaid credit against a $49 Kilo Pass still generates $49 of product revenue and owes a $2.45 fee.
- Customer credit balance from credit notes or overpayment does not appear in this field at all; it reduces `amount_due` through `invoice.starting_balance`. It is recorded only as reduced cash in `gross_paid_minor`.

This preserves the invariant that collected fee equals 5% of recognized product revenue, which is what makes the assessment table reconcilable and what the expected-versus-charged checks assume. `GOAL.md` names "eligible discounts and proration credits" as the two reducing adjustments; a credit grant is neither.

Kilo does not use Stripe Billing credit grants today (no `creditGrants` or `credit_balance` usage in `apps/web/src`), so this is a forward-looking guard. Revisit the policy if credit grants are adopted, and add a fixture with a `credit_balance_transaction` entry so a future adoption cannot silently change the fee base.

Clamp only the final event subtotal to zero. Preserve negative eligible lines while summing so proration credits offset positive eligible lines. Do not include tax fields. Assert safe integers and matching currency. Add fixtures for the actual pinned API version so a Stripe version change cannot silently double-subtract discounts.

The implementation must retrieve all invoice lines through `stripe.invoices.listLineItems()` when `invoice.lines.has_more` is true. Never calculate from the first embedded page only.

### Cumulative refund rounding

```ts
calculateCumulativeFeeRefundMinor({
  originalProductMinor,
  originalFeeMinor,
  cumulativeProductRefundMinor,
}): number
```

Requirements:

- Return zero when no product principal has been refunded.
- Return zero when `originalProductMinor` is zero. Guard the division explicitly; a fully discounted purchase settles at zero product and zero fee, so this input is reachable.
- Return the complete original fee when cumulative principal reaches original principal.
- Otherwise return round-half-up of `originalFeeMinor * cumulativeProductRefundMinor / originalProductMinor` using `bigint` intermediates.
- The incremental fee refund is cumulative target minus `refunded_fee_minor` already recorded.
- Never return a negative incremental refund or more than the remaining fee.

## Stripe metadata contract

Use namespaced string metadata. Keep each value under Stripe limits.

### Fee line metadata

Every positive fee line must contain:

```ts
{
  type: 'kilo-service-fee',
  serviceFeeVersion: '2026-11-01-v1',
  serviceFeeAssessmentKey: assessmentKey,
  serviceFeeRateBasisPoints: '500',
}
```

### Commercial object metadata

Add these facts to the object available for the flow:

- `serviceFeeAssessmentKey`
- `serviceFeeVersion`
- `serviceFeeFlow`
- `serviceFeePrincipalMinor` for top-ups
- `serviceFeeOrganizationId` for organization flows

Preserve existing metadata. Do not overwrite Kilo Pass, KiloClaw, seat, affiliate, or scheduled-change metadata.

### Classifier rules

Add shared helpers:

- `isServiceFeeMetadata(metadata)`
- `isServiceFeeInvoiceLine(line)`
- `isServiceFeeCheckoutLine(line)` where needed
- `isKnownKiloPassInvoiceLine(line)`
- `isSeatInvoiceLine(line, subscription?)`
- `isKiloClawInvoiceLine(line)`

A line is a service fee only when the namespaced metadata marker and version are present, or when its line/Price identity is linked to an assessment during reconciliation. The description alone is insufficient.

Checkout does not provide line-item metadata directly on the pinned API. Put the marker in inline `price_data.product_data.metadata`; after Session creation, list Checkout lines with `data.price.product` expanded, identify the marked line, and persist its line and Price IDs. Reconcile the generated invoice line by the persisted Price ID, then store its invoice-line ID. Invoice items created directly use invoice-item metadata.

Update every "first non-seat item" assumption in `apps/web/src/lib/kilo-pass-org/stripe-adapter.ts`. Resolve the organization Kilo Pass item in this order:

1. Persisted `provider_seat_add_on_item_id`.
2. Known Kilo Pass price ID on a non-seat subscription item.
3. Metadata-backed Kilo Pass item when unbound.

A service-fee invoice item is not a subscription item, but invoice scanning must still explicitly exclude it. Keep seat and Kilo Pass subscription-item resolution independent of invoice line order.

Update invoice classifiers so:

- Kilo Pass remains recognized by known recurring price or subscription metadata.
- KiloClaw remains recognized only by its known prices/metadata.
- Seats remain recognized by seat product/known prices.
- A fee-only line can never make an invoice look like one of those products.

## Assessment API

Implement these server-only contracts in `assessments.ts` and `settlement.ts`.

### Prepare a decision

```ts
type PrepareAssessmentInput = {
  assessmentKey: string;
  flow: ServiceFeeFlow;
  currency: string;
  eligibilityCreatedAt: Date;
  eligibleSubtotalMinor: number;
  kiloUserId?: string;
  organizationId?: string;
  stripeCustomerId?: string;
};
```

Decision order:

1. Validate flow owner and currency. A non-USD eligible event terminates as `unsupported_currency`.
2. Resolve the decision at `eligibilityCreatedAt`. If it precedes activation, the outcome is `pre_activation`. For organization flows, find the latest exemption row at or before that instant; the outcome is `exempt` only when that exact row grants exemption. Never use current exemption state to decide a delayed invoice webhook.
3. Compute `expected_fee_minor` from the eligible subtotal in all cases, including exempt and pre-activation events. Leakage and audit reporting need it. The subtotal is always known at this point: top-ups and Kilo Pass Checkout use list price, invoices use actual draft lines.
4. If the event is pre-activation, outcome is `pre_activation`.
5. If the exact organization is exempt, outcome is `exempt`.
6. If the expected fee is zero, outcome is `zero_rounded`.
7. Otherwise persist outcome `pending` while attaching the provider line.
8. After Stripe accepts the fee line, move to `charged`. For invoice-attached fees set `charged_fee_minor` to the attached amount, which equals `expected_fee_minor`. For Checkout-created fees leave `charged_fee_minor` at zero until settlement reads the settled fee line, because a promotion code may have reduced it.
9. If attachment fails, atomically set outcome `missed`, charged fee zero, and a stable failure code.

For Checkout, persist after Stripe returns a real session so an abandoned API call does not leave an assessment that looks customer-visible. For invoice handling, insert/upsert before attempting the fee line so failure can be recorded.

### Upsert and conflict behavior

- Use `assessment_key` as the primary application idempotency identity.
- Enrich nullable Stripe IDs only when absent or identical.
- If a retry presents a different owner, flow, currency, eligible subtotal, expected fee, or non-null conflicting Stripe ID, throw an assessment conflict error and report it. Do not silently overwrite financial facts.
- A settled assessment is immutable except for additional Stripe links, monotonic cumulative refund fields, and dispute fields.
- `pending` may become `charged`, a terminal omitted outcome, or `missed`.
- `missed` never transitions to `charged`. The omission is not collected later.
- `pre_activation`, `exempt`, `zero_rounded`, and `unsupported_currency` never transition to `charged`.

### Fail-open wrapper

Each eligible creation path calls one wrapper that returns either:

```ts
type FeeApplicationResult = {
  assessmentId: string | null;
  assessmentKey: string;
  outcome: ServiceFeeOutcome;
  eligibleSubtotalMinor: number;
  expectedFeeMinor: number;
  chargedFeeMinor: number;
  checkoutLineItem?: Stripe.Checkout.SessionCreateParams.LineItem;
};
```

or a `missed` result. It must catch fee-domain and exemption failures, persist a missed assessment where enough identity is available, send a best-effort Slack alert, and let the base payment path continue without a fee.

Do not wrap the base Stripe call itself. A failure to create or pay the underlying purchase retains existing behavior.

## Interactive Checkout integration

### Top-ups

Change these functions:

- `getStripeTopUpCheckoutUrl()` in `apps/web/src/lib/stripe/index.ts`
- `createAutoTopUpSetupCheckoutSession()` in the same file
- `createOrgAutoTopUpSetupCheckoutSession()` in `apps/web/src/lib/organizations/organization-auto-top-up.ts`

For all three:

1. Resolve the principal in cents before creating Checkout. For the default top-up price, retrieve the Stripe Price once per request and require a fixed USD `unit_amount`; do not infer principal from the later gross charge.
2. Generate an assessment key.
3. Prepare the service-fee decision using the current creation attempt instant and exact owner.
4. Build the existing principal line unchanged.
5. When the computed fee is positive, append a one-time `price_data` line with product name `Service fee (5%)`, USD amount, fee metadata, and the tax input from `tax.ts`.
6. Put the trusted principal and assessment key in PaymentIntent metadata. Put the same assessment key and flow in Checkout Session metadata. Preserve existing type metadata.
7. Create the Checkout Session.
8. Persist the session ID and Stripe `created` timestamp. Apply the activation-boundary replacement rule only inside the one-minute window.
9. On assessment preparation or fee-line construction failure, create Checkout with only the principal line, persist `missed`, and notify Slack.

Top-ups have no hosted promotion-code entry, so their Checkout fee equals the settled fee and the effective-rate assertion should always hold exactly.

For an organization Checkout, resolve the exact-organization exemption before creating the Session. An exempt organization omits the fee line and persists the expected fee plus the exact exemption history link. Personal purchases have no exemption lookup.

### Personal Kilo Pass Checkout

Hosted promotion-code entry is retained. The fee is computed from list price before session creation and is allowed to be discounted along with the product, as specified under Discountable initial fee lines.

Change `kiloPass.createCheckoutSession` in `apps/web/src/routers/kilo-pass-router.ts`:

1. Resolve the Kilo Pass list price for the requested tier and cadence through `getStripePriceIdForKiloPass()` and retrieve its `unit_amount`.
2. Generate an assessment key and compute the fee from the list `unit_amount`.
3. Keep the recurring Kilo Pass price line and `allow_promotion_codes: true` unchanged (`apps/web/src/routers/kilo-pass-router.ts:2432`).
4. When the computed fee is positive, append one one-time `price_data` fee line. It will be discountable; that is intended. Per the installed SDK, one-time prices in subscription mode appear on the initial invoice only, so this line does not recur.
5. Put assessment metadata on the Checkout Session and on `subscription_data.metadata` so the initial invoice and all later renewals can bind to an assessment.
6. Create the Session, then persist the assessment with the returned `created` timestamp, `eligible_subtotal_minor` from list price, and provisional `expected_fee_minor`.

Do not persist outcome `charged` at creation time. The fee actually collected is unknown until settlement.

After Checkout completes, bind the initial invoice to the same assessment from subscription metadata and read the settled fee line:

- Set `charged_fee_minor` from the marked fee line on the settled invoice, not from the value sent to Stripe.
- Set `settled_product_minor` from the net eligible Kilo Pass lines on the same invoice.
- When `charged_fee_minor` deviates from 5% of `settled_product_minor` by more than one cent, record `service_fee_rate_deviation`, alert Admin Slack, and leave the assessment settled with the observed amounts. Do not issue a corrective charge or refund, and do not grant extra credits.
- A zero settled fee with a zero settled product is outcome `charged` with both amounts zero, not `missed`.

Renewals for these subscriptions are handled by `invoice.created` and receive an exact non-discountable fee.

### Seats and KiloClaw

Do not add fee preparation to:

- `getStripeSeatsCheckoutUrl()`
- KiloClaw Checkout or KiloClaw subscription changes
- Store Kilo Pass purchase paths
- Manual Kilo Pass for Organizations agreements

Add regression tests proving these calls remain fee-free.

## Invoice-created integration

Add `invoice.created` to `processStripePaymentEventHook()` in `apps/web/src/lib/stripe/index.ts`. Handle it before settlement events.

### Invoice retrieval

The webhook object may contain only the first line page or unexpanded references. Retrieve the invoice with all fields needed for classification, then paginate all lines. Preserve the event's `created` only for event telemetry; use `invoice.created` for fee eligibility.

### Ownership of invoice fee attachment

Exactly one code path attaches a fee to any given invoice. Automatic top-up invoices are created and paid by Kilo, not by Stripe's automatic advancement:
`apps/web/src/lib/autoTopUp.ts:267-289` calls `invoices.create({ auto_advance: false, ... })`, then `invoiceItems.create()`, then `invoices.pay()`. Those invoices still emit `invoice.created`, and the webhook can be delivered while the creating request is between its create and pay calls. Assessment-key uniqueness does not serialize this, because both paths would derive the same `invoice:<id>` key and race on insert.

**The creating code owns the fee for Kilo-created invoices. `invoice.created` must skip them.** Skip the invoice when its metadata `type` is `auto-topup` or `org-auto-topup`. Treat this as a named exclusion with its own regression test, not as an incidental consequence of classification order.

### Classification order

Classify the invoice into one of:

1. **Kilo-owned invoice, skip entirely**: invoice metadata `type` is `auto-topup` or `org-auto-topup`. The creating path in `autoTopUp.ts` already attached the fee. Do not create, upsert, or modify an assessment here.
2. Existing Checkout assessment, identified by `serviceFeeAssessmentKey` in subscription or PaymentIntent/invoice metadata.
3. Personal Kilo Pass by known price or Kilo Pass subscription metadata.
4. Kilo Pass for Organizations by `kilo-pass-org` subscription metadata and a self-service agreement.
5. Excluded seat-only, KiloClaw, manual organization agreement, store, or unknown.

Case 1 must be evaluated first. Unknown invoices are ignored. A recognized eligible invoice with insufficient evidence fails open and records `missed`.

### Eligible subtotal for invoices

For Kilo Pass invoices:

- Include lines whose price is a known Kilo Pass price and whose subscription context is Kilo Pass.
- Include positive and negative Kilo Pass proration lines.
- Exclude service-fee lines.
- Exclude every seat line, including free-seat prices.
- Exclude KiloClaw lines and unrelated invoice items.
- Sum each line's net pretax amount through `getNetPretaxLineAmountMinor()` so discounts represented in both Stripe arrays are counted once.
- Clamp the aggregate at zero, then calculate the fee once.

Automatic top-up invoices never reach this path; their fee is computed by the creating code from `config.amount_cents`. At settlement the trusted principal is `invoice.metadata.serviceFeePrincipalMinor`, which must match the marked principal invoice item. Do not use `invoice.amount_paid`.

### Recurring and ordinary draft invoices

For draft invoices that are not already bound to a Checkout assessment:

1. Create/upsert `invoice:<id>` assessment using `invoice.created`.
2. Apply the exact organization's exemption history effective at `invoice.created`, not the exemption state at webhook delivery.
3. If outcome is charged, call `stripe.invoiceItems.create()` with `invoice: invoice.id`, the positive fee amount, description `Service fee (5%)`, fee metadata, `discountable: false`, and the tax input from `tax.ts`.
4. Store the returned invoice-item ID.
5. Do not call `invoices.finalizeInvoice()` from the webhook. Let existing Stripe automatic advancement continue.
6. On attachment failure, mark missed, alert Slack, and return success from the webhook.

If the invoice is already finalized by the time the event is handled, record `missed` with `invoice_not_draft` and acknowledge the event. Do not add the fee to a later invoice.

### Synchronous subscription updates

Stripe documents that some subscription creations and updates finalize or attempt payment synchronously, without the normal draft delay. The repository has such paths:

- `createOrganizationKiloPassCheckout()` with `proration_behavior: 'always_invoice'` (`apps/web/src/lib/kilo-pass-org/stripe-adapter.ts:133`)
- `handleUpdateSeatCount()` when a shared seat/Kilo Pass subscription increases capacity. **This function is defined in `apps/web/src/lib/stripe/index.ts:1789`**, not in `organization-subscription-router.ts`; the router only imports it. Edit it at its definition.
- Kilo Pass cadence/tier transitions that generate an immediate invoice

Do not rely on `invoice.created` alone for these paths.

For every eligible synchronous update:

1. Create an invoice preview with a fixed `proration_date` where Stripe supports it.
2. Compute the net eligible Kilo Pass subtotal from preview lines.
3. Attach the fee to the resulting draft invoice with `invoiceItems.create({ discountable: false })`. Do not use `add_invoice_items`, which cannot express `discountable` in the installed SDK.
4. Use the same `proration_date` in the actual update so preview and actual proration match.
5. Put the assessment key on subscription/update metadata and the fee line.
6. Reconcile the returned/latest invoice to the assessment.
7. If fee preparation fails before the update, perform the base update without a fee, persist missed, and notify Slack.

`SubscriptionUpdateParams.add_invoice_items` does not expose `discountable` in the installed SDK (verified: `node_modules/stripe/types/SubscriptionsResource.d.ts:1122-1150`). `invoiceItems.create()` does (`InvoiceItemsResource.d.ts:29`), and so does the `Stripe.InvoiceLineItem` read model (`InvoiceLineItems.d.ts:44`). Prefer `invoiceItems.create()` against the draft invoice so `discountable: false` is explicit. Do not rely on an undocumented default for financial correctness.

When `handleUpdateSeatCount()` changes a shared subscription:

- Seat increase proration remains excluded.
- The matching increase in organization Kilo Pass capacity is eligible.
- Preview and calculate only Kilo Pass lines.
- A seat-only subscription update gets no assessment and no fee.

**Do not add Stripe or database round trips inside the advisory lock.** `handleUpdateSeatCount()` runs entirely inside `db.transaction` holding `pg_advisory_xact_lock` on a pooled connection (`apps/web/src/lib/stripe/index.ts:1793-1798`), and already performs `subscriptions.retrieve`, `subscriptions.update`, `finalizeInvoice`, and `invoices.pay` under it. Adding an invoice preview plus assessment writes would extend that hold further. Compute the fee decision and persist the assessment **outside** the transaction, and pass the prepared values in. If a preview must occur inside, record the added hold time as an accepted cost in the PR description.

### Existing subscriptions

No subscription backfill should create a charge, proration, or pending invoice item before activation. Recurring fees are added per invoice, not by adding a persistent fee subscription item. This automatically covers existing subscriptions on post-activation invoices without modifying them in advance.

Add a read-only pre-release audit script that lists active Stripe-managed Personal Kilo Pass and self-service organization Kilo Pass subscriptions and validates that each can be classified. The script must not update Stripe subscriptions.

## Settlement integration

Settlement links Stripe objects and records revenue. It does not decide whether to charge.

### Checkout one-time payments

In `handleSuccessfulChargeWithPayment()`:

1. Resolve `serviceFeeAssessmentKey` and `serviceFeePrincipalMinor` from trusted PaymentIntent metadata.
2. Load and validate the assessment against customer, owner, flow, charge, and PaymentIntent.
3. Use `serviceFeePrincipalMinor` as `creditAmountInCents` for manual and setup top-ups.
4. Never use `charge.amount` for credit principal after this feature.
5. Pass principal, charged fee, and gross paid to the email scheduling path.
6. Mark the assessment settled with gross charge, product principal, PaymentIntent, charge, and settlement time.
7. Existing credit transaction idempotency remains keyed by its existing Stripe identity.

For pre-activation legacy events without service-fee metadata, preserve current settlement behavior. Gate that fallback by the assessment cutoff identity, not `charge.created`: for Checkout payments retrieve the Checkout Session associated with the PaymentIntent and use `session.created`; for invoice-only payments use `invoice.created`. Metadata-free post-activation eligible top-ups are an operational error and must not silently grant gross credits. Record/alert the missing assessment and derive principal only from existing trusted `amountCents` metadata or a marked principal line.

### Automatic top-ups

In `invoice.paid` auto-top-up branches:

1. Load assessment by invoice ID/key.
2. Use assessment `eligible_subtotal_minor` or trusted invoice principal metadata as the credit amount.
3. Do not pass `invoice.amount_paid` to `processTopUp()` or `processTopupForOrganization()`.
4. Mark settlement before scheduling revenue-dependent side effects.
5. Preserve attempt-lock completion/release behavior.
6. Duplicate webhook processing must not duplicate assessment settlement, credits, or emails.

### Personal Kilo Pass

At the start of `handleKiloPassInvoicePaid()` after classification:

1. Resolve and validate the assessment.
2. Mark it settled in the same database transaction as the Kilo Pass invoice-paid mutations. Pass the existing Drizzle transaction into the assessment helper. Do not commit Kilo Pass credits without the corresponding settlement update when an assessment exists.
3. Continue deriving base entitlement from tier config, never gross invoice amount.
4. Replace all product/affiliate amounts currently using `invoice.amount_paid` with the assessment's settled product amount.
5. PostHog purchase telemetry may add separate `service_fee_usd` and `gross_paid_usd` properties, but the existing `amount_paid_usd` product property must exclude the fee.
6. The duplicate-card and welcome-promo positive-settlement checks use the gross Stripe settlement only to determine whether payment occurred. They must not treat the fee as product value.

Change `enqueueKiloPassAffiliateSaleForInvoice()` to accept an explicit product amount in minor units. Do not recompute it from the invoice. Update `.specs/impact-affiliate-tracking.md` rule 17 so Kilo Pass reported amount explicitly excludes the service-fee line.

### Kilo Pass for Organizations

Before `handleOrganizationKiloPassInvoicePaid()` activates an agreement:

1. Resolve and mark the service-fee assessment settled.
2. Continue selecting the Kilo Pass line through the bound subscription item, not line order.
3. Do not use the fee line for paid period, capacity, or supplement calculations.

### Settlement meaning

Set:

- `settled_at` from Stripe's paid timestamp when available, otherwise webhook observation time.
- `gross_paid_minor` from Stripe's authoritative paid amount.
- `settled_product_minor` to the eligible product subtotal actually settled. Cap it at `eligible_subtotal_minor`; a discounted purchase settles **below** that value, which is expected and is not a mismatch.

For a charged event, establish collection from the finalized invoice line and invoice settlement state. Do not require cash `amount_paid` to equal product plus fee: Stripe customer credit balances can settle invoice lines without the same cash amount. Record gross cash paid separately, require the marked fee line to be present for `charged_fee_minor`, and require `invoice.status = paid` (or equivalent successful Checkout settlement) before recognizing fee revenue. If the fee line or settlement evidence is missing, report a reconciliation failure and do not recognize the fee until evidence is resolved.

For exempt and missed outcomes, set settlement and product amount so leakage reporting can count expected values only after payment succeeds.

## Organization exemption Admin API and UI

### Router

Add admin-only procedures to `apps/web/src/routers/organizations/organization-admin-router.ts`:

```ts
getServiceFeeExemption({ organizationId });
setServiceFeeExemption({ organizationId, isExempt, reason });
```

Contracts:

- `reason`: trimmed string, minimum 3, maximum 500 characters.
- `get` returns current state, last reason/actor/time, and history newest first.
- Normalize database timestamps to UTC ISO before returning them.
- `set` runs in one database transaction, takes an organization-scoped advisory transaction lock, and appends one exemption-log row. Current state is that newest row.
- Repeating the same state with a new reason is allowed and creates history because the stated reason is an auditable admin decision.
- Reject deleted or missing organizations.
- Never write `organization_audit_logs`.

### Hooks

Add React Query/tRPC hooks in `apps/web/src/app/admin/api/organizations/hooks.ts`. On mutation success, invalidate only the exemption query and admin organization details that display it.

### Component

Add `OrganizationAdminServiceFeeExemption.tsx` and render it on `OrganizationAdminDashboard.tsx` near billing controls.

UI requirements:

- Use the existing Card, Button, Dialog, Label, Textarea, and status primitives.
- Show `Exempt` or `Fees apply` as compact current state.
- Require a reason in a confirmation dialog for both grant and revoke.
- Action labels are `Grant exemption` and `Revoke exemption`.
- Disable controls and preserve layout while saving.
- Show mutation errors in the dialog and keep the reason for retry.
- Show internal history with actor ID or `Deleted admin`, reason, resulting state, and UTC timestamp rendered in the admin's local timezone.
- Do not expose this component or its data through customer organization routes.
- Verify keyboard focus, Escape behavior, visible labels, 375px layout, and long reason wrapping.

The design skill has no dedicated card/dialog recipe. Follow its Cloud overlay, interaction-quality, and voice guidance plus neighboring Organization Admin cards.

### Authorization tests

Test that:

- Non-admin procedures cannot read or mutate exemption state.
- A platform admin can grant and revoke with history.
- Blank/oversized reasons fail.
- Parent, child, and member personal purchases do not inherit exemption.
- Customer organization APIs do not include exemption fields.

## Refund reconciliation

### Automatic observation

Extend the `charge.refunded` webhook branch. Fee refund observation must run before branches that return early for affiliate classification.

1. Resolve the assessment by charge ID, PaymentIntent, or expanded invoice.
2. Retrieve all refunds for the charge if the event does not contain a complete list.
3. Persist the observed cumulative gross refunded amount in a typed `refunded_gross_minor` column, not in `metadata`. Every other financial fact in this table is a typed column and this one is used for reconciliation arithmetic.
4. For Stripe Credit Notes, map refunded eligible product and fee lines directly.
5. A Charge Refund does not carry invoice-line allocation. Treat it as a full refund only when cumulative gross refunded equals the charge amount; then set `refunded_product_minor = settled_product_minor` and `refunded_fee_minor = charged_fee_minor`.
6. For partial Charge Refunds, update principal and fee fields only when Kilo supplied and persisted the allocation at refund creation or an associated Credit Note provides it. Otherwise record `refund_allocation_unresolved`, alert operations, and do not create another Stripe refund automatically.
7. Add `credit_note.created` and `credit_note.updated` webhook handling because the operator procedure in `kilo-org/on-call` uses credit notes for invoice-line attribution.
8. Refund and credit-note webhooks are idempotent and cumulative; later events may resolve a previously partial state.

### Disputes and chargebacks

A chargeback removes money from the account, so it must reduce collected fee revenue exactly as a refund does. The webhook plumbing already exists: `charge.dispute.created`, `.updated`, `.closed`, and `.funds_withdrawn` are handled at `apps/web/src/lib/stripe/index.ts:998, 1068-1069, 1354`, and disputes persist to `stripe_dispute_cases` with `amount_minor_units` (`packages/db/src/schema.ts:757-816`). Only the fee-revenue consequence is new.

Use the dedicated `disputed_fee_minor` column, **not** the refund columns. It is not monotonic: a dispute Kilo wins restores the fee, which would require decrementing `refunded_fee_minor` and breaking its monotonic invariant and tests. Product dispute state remains owned by Stripe and the existing `stripe_dispute_cases` flow.

1. On `charge.dispute.funds_withdrawn`, resolve the assessment by charge or PaymentIntent. Set `disputed_fee_minor = charged_fee_minor`. A dispute reverses the whole charge, so the full fee is withdrawn even when an earlier partial refund overlaps it.
2. On `charge.dispute.closed` with an outcome in Kilo's favor, reset `disputed_fee_minor` to zero.
3. Reuse the refund arithmetic; do not add a second calculator.
4. Dispute handling is idempotent and must not alter `outcome`. A disputed charge remains `charged`; the money movement is reported separately.

### Kilo-initiated refunds

In `apps/web/src/lib/kilo-pass/cancel-and-refund.ts`, the no-amount `refunds.create({ payment_intent })` call already requests a full remaining refund. Keep this behavior. After Stripe returns, update the assessment or rely on the webhook, but never double count.

If a future Kilo partial-refund path is added, it must call the cumulative refund calculator and issue a gross refund of:

```text
incremental product refund + incremental service-fee refund
```

There is no new partial-refund Admin UI in this change.

### Operator runbook

Publish the service-fee operator procedure in `kilo-org/on-call`, which owns Kilo Engineering runbooks. It must cover:

- How to identify the assessment from a Stripe invoice/charge.
- How to calculate cumulative fee refund.
- How to issue principal plus fee in Stripe.
- Why the system does not auto-correct ambiguous operator refunds.
- How to clear a reconciliation alert after verifying Stripe state.

## Top-up emails

Change `sendCreditsTopUpEmail()` and `creditsTopUp.html`.

### Contract

Replace ambiguous `amountCents` semantics with explicit fields:

```ts
{
  principalCents: number;
  serviceFeeCents: number;
  grossPaidCents: number;
  creditsCents: number;
}
```

For positive fees, render rows:

- `Credit principal`
- `Service fee (5%)`
- `Total paid`
- `Credits`
- `Date`

For fee-free events, omit the fee row. Continue showing the current amount/credits summary without revealing exemption or failure reasons. Build the optional fee row in `email.ts` as escaped `RawHtml`; do not add conditional template syntax.

Pass amounts from the settled assessment. Do not derive fee as gross minus credits in the email layer.

Update `apps/web/src/emails/AGENTS.md` template variable documentation and `apps/web/src/lib/purchase-emails.test.ts`. Preserve existing email marker/idempotency behavior.

No Kilo Pass payment email is added.

## Revenue and leakage reporting

### Query model

`RevenueKpiData` keeps its existing paid/free/multiplier fields and adds a separate settled-fee series:

- `collected_service_fee_dollars`
- `missed_service_fee_dollars`
- `exempted_service_fee_dollars`
- `disputed_service_fee_dollars`
- `service_fee_charged_count`
- `service_fee_missed_count`
- `service_fee_exempt_count`

`credit_transactions` remains the sole source for the existing credit-revenue fields. Assessment-backed top-ups remain in those fields, and there is no join or anti-join between assessments and credit transactions.

Calculate collected fee per assessment as `GREATEST(charged_fee_minor - refunded_fee_minor - disputed_fee_minor, 0)` before summing. Refund and dispute values can overlap when a dispute withdraws the whole charge after a partial refund; overlap must not make a row negative or reduce another row's collected fee.

Only rows with `settled_at IS NOT NULL` contribute to collected, missed, exempt, or disputed fee values. For missed and exempt amounts use `expected_fee_minor`. The historical charged count includes every settled `outcome = charged` assessment even after refunds or disputes.

Group service-fee metrics by the UTC calendar date of `settled_at` and push the requested date range into that aggregate. Legacy metrics retain `created_at::date` and its existing session-time-zone semantics. A full outer date merge allows a Kilo Pass assessment to create a fee-only day with zero-valued credit fields, but the assessment does not contribute Kilo Pass product revenue.

The two series have different coverage and date semantics. Do not add fee figures to credit figures to claim authoritative gross revenue. Kilo Pass product revenue remains outside this query and requires separate product and accounting work.

### Admin UI

Update:

- `apps/web/src/app/admin/components/RevenueStats.tsx`
- `apps/web/src/app/admin/components/RevenueDailyChart.tsx`
- CSV export through the extended response shape

Keep the existing credit table and chart series under their existing meaning. Show collected, missed, exempted, and disputed fees plus charged, missed, and exempt assessment counts in a clearly separate Service fees section labelled by settled date in UTC. State that these figures do not make the dashboard a complete Stripe product-revenue report and that Kilo Pass product revenue is not added. Use tabular numbers and semantic tokens; keep leakage series subdued.

Fix two existing empty-data hazards while here:

- `RevenueStats.tsx:12-13` reads `data[data.length - 1]` with no length check.
- `RevenueDailyChart.tsx:128-137` computes `Math.max(...chartData.map(...))`, which yields `-Infinity` on an empty array. Its CSV export is already guarded.

### Affiliate reporting

Service fees are never commissionable. Update every eligible Kilo Pass affiliate/referral conversion amount to use product amount from the assessment. Seat and KiloClaw affiliate behavior is unchanged because they do not carry the fee.

`.specs/impact-affiliate-tracking.md:150-152` rule 17 currently reads:

> Kilo Pass SALE amounts MUST use the positive settled invoice paid amount, not catalog price or credit issuance value.

That directly contradicts excluding the fee, because the settled paid amount now includes it. Amend rule 17 explicitly rather than relying on the new behavior to imply the change. The amended rule must say that Kilo Pass SALE amounts use the settled **eligible product** amount calculated from eligible Stripe product lines, excluding any service-fee line. The same value may support fee settlement, but the assessment does not become an affiliate or product-revenue ledger.

The implementation dependency is `enqueueKiloPassAffiliateSaleForInvoice()` (`apps/web/src/lib/kilo-pass/affiliate-sale.ts:137`), which currently reports `invoice.amount_paid / 100` at `:167` and gates on `invoice.amount_paid <= 0` at `:144`. Change it to accept an explicit product amount in minor units. Note that `getReportablePromoCode()` at `:123-135` reads `invoice.discounts` and is unaffected by fee changes.

## Alerts and observability

Create `sendMissedServiceFeeAlert()` in `alerts.ts` using `sendAdminSlackNotification()`.

Each fail-open processing attempt sends one alert. Do not persist or check a dedupe marker before sending. A retry sends another alert by design.

Slack payload includes only:

- `assessment_key`
- flow
- non-sensitive owner ID
- Stripe object IDs
- eligible subtotal, expected fee, currency
- stable failure code
- processing attempt timestamp

Do not include metadata dumps, webhook payloads, headers, customer email, billing address, card details, Stripe secret-bearing errors, or Slack URL.

Wrap Slack in `try/catch`. Capture only `AdminSlackNotificationError.kind/status` and assessment identifiers. Slack failure must not change the assessment outcome or webhook response.

Use structured Sentry tags for:

- `service_fee_missed`
- `service_fee_assessment_conflict`
- `service_fee_settlement_mismatch`
- `service_fee_refund_allocation_unresolved`
- `service_fee_rate_deviation`
- `service_fee_restricted_coupon_detected`
- `service_fee_application_failed`

Do not enable default PII or attach RPC input.

## Webhook response semantics

The existing Stripe route returns a non-2xx response when `processStripePaymentEventHook()` throws. Fee attachment has different behavior:

- Expected fee-domain failures in `invoice.created` are caught, recorded as missed, alerted, and acknowledged with 200.
- A Slack failure is caught and acknowledged with 200.
- A database failure that prevents recording the assessment should still fail open for the payment. Capture and alert if possible, then acknowledge the invoice-created event. This is the one case where durable assessment may be absent; use the assessment key and Stripe metadata for later audit.
- Existing non-fee product handler failures retain their current retry behavior.
- Settlement assessment conflicts throw because continuing could grant the wrong credits or report the wrong revenue.

This distinction is required: failure to charge the fee must not delay invoice finalization, while failure to identify trusted top-up principal must not grant gross credits.

## Implementation sequence

Follow these steps in order. Keep commits small enough to review independently.

### Phase 0: pin the provider contract

1. Add an explicit `apiVersion` to `apps/web/src/lib/stripe-client.ts`.
2. Run the existing Stripe test suites and resolve any drift between the account default version and the installed typings.

Exit condition: the wire API version is pinned and green, as a standalone reviewable commit before any fee logic exists.

### Phase 1: arithmetic, types, and persistence

1. Add closed service-fee types/constants.
2. Implement pure fee, line-net, and cumulative-refund calculations with unit tests, including the `type === 'discount'` filter and the zero-product refund guard.
3. Add the two database tables and generated migration, using `assessment_key` as the assessment primary key and `enumCheck()`.
4. Add assessment repository functions and database integration tests.
5. Add exact-organization exemption read/mutation functions and tests.
6. Verify schema, migration bootstrap, package typecheck, and format.

Exit condition: decisions and assessments can be persisted idempotently without any Stripe path charging a fee.

### Phase 2: Admin exemption controls

1. Add admin tRPC get/set procedures.
2. Add hooks and Organization Admin card/dialog/history.
3. Add authorization, mutation, history, and component tests.
4. Deploy this phase before activation and enter historical exemptions.

Exit condition: an admin can manage exact-organization exemptions with required reasons and internal-only history.

### Phase 3: top-up Checkout and safe principal settlement

1. Integrate personal/org manual and setup Checkout lines.
2. Add assessment metadata and boundary handling.
3. Change one-time settlement to trusted principal.
4. Change automatic top-up invoice creation to add fee and principal metadata directly before `invoices.pay()`; because Kilo owns this invoice lifecycle and `auto_advance` is false, create the principal and fee items before payment without waiting for `invoice.created`. Land the `invoice.created` skip rule for `auto-topup` and `org-auto-topup` metadata in the same commit so the two paths can never both attach a fee.
5. Change automatic top-up settlement to trusted principal.
6. Add fee-aware top-up emails.
7. Add flow tests and regression tests for legacy pre-activation events.

Exit condition: every top-up flow charges correctly without over-crediting.

### Phase 4: Kilo Pass Checkout, invoices, and mixed subscriptions

1. **Run the coupon-allocation sandbox matrix first** (see Stripe sandbox contract tests). Percent-off, fixed-amount, product-restricted, and 100%-off coupons against a Kilo Pass Checkout with a fee line. If fixed-amount coupons do not allocate proportionally across product and fee lines, stop: the discountable-fee-line design does not hold and the spec needs revision before code.
2. Add line classifiers and remove first-non-seat assumptions.
3. Integrate Personal Kilo Pass initial Checkout with a list-price fee line.
4. Add `invoice.created` handler for recurring invoices, including the Kilo-owned skip rule.
5. Integrate synchronous Personal Kilo Pass changes that can invoice immediately.
6. Integrate Kilo Pass for Organizations initial add-on and capacity changes.
7. Handle mixed seat/Kilo Pass invoices and organization exemptions.
8. Add settlement linkage, read `charged_fee_minor` from the settled fee line, add the effective-rate assertion, and update affiliate/PostHog product amounts.
9. Add the restricted-coupon detection check and its alert.

Exit condition: initial, renewal, upgrade, proration, and organization capacity events carry exactly one correct fee; seats never enter the base.

### Phase 5: refunds, reporting, and operations

1. Add cumulative refund calculation integration and charge-refunded observation.
2. Update full-refund assessment reconciliation.
3. Add dispute fee reversal on `charge.dispute.funds_withdrawn` and restoration on a won `charge.dispute.closed`.
4. Add fee-only revenue/leakage/dispute query fields without joining assessments to credit transactions.
5. Update Admin revenue components and CSV, including the empty-data fixes and explicit labelling of adjusted versus legacy series.
6. Add missed-fee Slack alerts; publish the response procedure in `kilo-org/on-call`.
7. Add the read-only subscription classification audit script.

Exit condition: settled fees and leakage reconcile, refunds and disputes reduce revenue, and failures are operationally visible.

### Phase 6: rollout hardening

1. Run full targeted test matrix.
2. Use Stripe test clocks or sandbox subscriptions to cross renewal and activation boundaries.
3. Verify historical exemptions are entered.
4. Validate the confirmed mirrored `tax_behavior` in Stripe test mode and retain the decision record in ADR 0004.
5. Audit live Stripe coupons for `applies_to` restrictions covering fee-bearing products.
6. Deploy before activation and monitor assessment outcomes.
7. At activation, verify one example of each eligible flow and one excluded seat/KiloClaw flow.
8. Keep rollback artifact/commit ready; do not add a runtime switch.

## Test plan

Use the lightest honest test for each contract. Pure arithmetic and classification belong in unit tests. Persistence, webhook idempotency, and reporting queries require the test PostgreSQL database. A small Stripe sandbox suite validates provider behavior that mocks cannot prove.

### Pure unit tests

Add `apps/web/src/lib/service-fees/calculation.test.ts` and classifier tests for:

- `0 -> 0`
- `$0.01 -> $0.00`
- `$0.10 -> $0.01` at the half-cent boundary
- `$19.00 -> $0.95`
- `$49.00 -> $2.45`
- `$199.00 -> $9.95`
- `$100.00 -> $5.00`
- Aggregate rounding differs from per-line rounding and aggregate wins
- Positive and negative Kilo Pass prorations net before fee calculation
- Discount amounts reduce eligible line value
- A `pretax_credit_amounts` entry of type `discount` reduces the line; an entry of type `credit_balance_transaction` does **not**
- A line carrying both `discount_amounts` and a matching discount pretax-credit entry is subtracted once, not twice
- Seat-only discounts do not touch Kilo Pass value
- Tax fields do not enter subtotal
- Service-fee lines are excluded
- Pagination combines all invoice lines
- Cumulative partial refunds have no drift and end at the full original fee
- Cumulative refund with zero original product returns zero rather than dividing by zero
- Invalid/non-safe integers fail explicitly

### Database integration tests

Cover:

- One assessment key under concurrent inserts
- Stale pending rows are observable and cannot settle or trigger later fee collection
- Retry enrichment of Stripe IDs
- Conflicting owner/amount/Stripe ID rejection
- Eligibility, outcome, and amount checks
- Pending can finalize to charged, an omitted terminal outcome, or missed; terminal outcomes cannot be recollected
- A charged assessment tolerates `charged_fee_minor < expected_fee_minor` without violating a constraint, which is the discounted-Checkout case
- Settlement idempotency
- Monotonic refund updates
- Disputed fee set on funds withdrawn and cleared on a won dispute, without altering `outcome` and without breaking refund monotonicity
- Exact organization exemption and no hierarchy inheritance
- Grant/revoke history ordering and actor nulling semantics
- Settled-only revenue recognition
- Refunds and disputes reduce collected fee revenue
- Unpaid missed/exempt rows do not enter dashboard totals
- Assessment-backed credit transactions retain the existing paid/free/multiplier semantics; fee metrics remain separate

### Checkout and webhook tests

Extend existing suites:

- `apps/web/src/lib/stripe/index.test.ts`
- `apps/web/src/lib/autoTopUp.test.ts`
- `apps/web/src/routers/organizations/organization-auto-top-up-router.test.ts`
- `apps/web/src/routers/kilo-pass-router.test.ts`
- `apps/web/src/lib/kilo-pass/stripe-handlers-invoice-paid.test.ts`
- `apps/web/src/lib/kilo-pass-org/stripe-adapter.test.ts`
- `apps/web/src/lib/kilo-pass/stripe-invoice-classifier.server.test.ts`
- `apps/web/src/lib/kiloclaw/stripe-invoice-classifier.server.test.ts`

Workflows:

1. Checkout created one second before activation has no fee.
2. Checkout created exactly at activation has the fee.
3. Invoice created one second before and exactly at activation follows the same boundary.
4. Request straddling activation expires/replaces the incorrect Checkout once, and a request outside the one-minute window performs no expire/replace round trip.
5. Personal/org manual and setup top-ups grant principal, not gross.
6. Automatic top-up adds principal and fee before pay and grants principal.
7. **`invoice.created` for an `auto-topup` or `org-auto-topup` invoice creates no assessment and attaches no second fee item**, including when the webhook is delivered between `invoices.create()` and `invoices.pay()`.
8. Exempt org top-up has no line but has settled exempt assessment.
9. Personal Kilo Pass initial Checkout has recurring product plus one-time fee computed from list price.
10. Existing subscription renewal receives a draft invoice fee equal to expected.
11. A discounted Kilo Pass Checkout settles with `charged_fee_minor` below `expected_fee_minor` and an effective rate within one cent of 5%, recorded as `charged` without a deviation alert.
12. A 100% coupon settles as `charged` with zero product and zero fee, not `missed`.
13. A simulated product-restricted coupon produces an effective rate above 5% and raises `service_fee_rate_deviation` without issuing a corrective charge or refund.
14. Mixed seats plus Kilo Pass charges only Kilo Pass.
15. Organization capacity increase charges only the Kilo Pass proration.
16. Negative/zero net Kilo Pass proration omits the fee.
17. Seat-only, KiloClaw, store, and manual agreement events create no assessment.
18. Fee-line presence does not alter product classifiers or bound subscription item lookup.
19. Invoice-created fee attachment failure returns normally, records missed, and calls Slack once per invocation.
20. Slack failure returns normally.
21. Tax-resolution or fee-application failure records missed with `fee_application_failed` and the payment still proceeds.
22. Retry does not attach a second fee line; a missed retry alerts again but never attempts later collection.
23. Paid webhooks link invoice, PaymentIntent, and charge to one assessment.
24. Duplicate paid webhook does not duplicate credits, revenue, email, or affiliate event.
25. Affiliate sale and product analytics exclude the fee.
26. Full Kilo Pass refund observes the complete fee refund.
27. Ambiguous partial operator refund records unresolved allocation without issuing another refund.
28. Dispute funds withdrawn removes the fee from collected revenue; a won dispute restores it.

### Email and UI tests

- Fee-positive top-up email contains principal, exact fee label, total paid, and credits.
- Fee-free email omits the fee row.
- Existing email marker prevents duplicates.
- Admin exemption card renders loading, current, error, grant, revoke, and history states.
- Reason is required and retained after a failed mutation.
- Revenue totals handle empty data and show separate product/fee/gross/leakage values.

### Stripe sandbox contract tests

Mocks cannot establish Stripe's discount, tax, draft-finalization, or line-allocation behavior. Before release, use Stripe sandbox/test clocks to prove:

**Coupon allocation matrix — run this before writing Phase 4 code.** The discountable-fee-line design depends on Stripe allocating a coupon proportionally across the product and fee lines. That is standard behavior and consistent with per-line `discount_amounts`, but it is inferred from the API surface and is not provable from this repository. Prove each case against a real Kilo Pass Checkout carrying a fee line:

| Coupon | Expected result |
|---|---|
| 20% off, unrestricted | Fee discounted proportionally; effective rate exactly 5% of net product |
| Fixed $10 off, unrestricted | Allocated across both lines; effective rate exactly 5% of net product |
| Percent off restricted via `applies_to.products` | Product discounted, fee not; effective rate above 5% and deviation alert fires |
| 100% off | Both lines zero; assessment `charged` with zero amounts |

If fixed-amount coupons do not allocate proportionally, this design does not hold and the spec must be revised before implementation. Record the observed allocation for each case in the PR.

Also prove:

- Checkout fee line label and metadata, including `price_data.product_data.metadata` survival onto the generated invoice line.
- A draft renewal invoice accepts the non-discountable fee before finalization.
- Synchronous subscription update/proration includes the fee on the same invoice and explicitly marks it non-discountable.
- Mirroring the eligible Price's `tax_behavior` onto the fee line yields the same treatment on both lines.
- Hosted invoice and PDF show one `Service fee (5%)` line.
- Full refund returns product, fee, and tax according to Stripe's configured behavior.

If any provider contract differs from this spec, do not compensate with post-settlement credit math. Revise the Stripe construction so the customer is charged correctly.

## Verification commands

Read root, web, and DB package manifests before running commands. Start/migrate test PostgreSQL if required:

```bash
docker compose -f dev/docker-compose.yml ps postgres
pnpm test:db # only when the repository-managed DB is not ready
```

During implementation, run narrow checks:

```bash
pnpm --filter @kilocode/db typecheck
pnpm --filter web typecheck
pnpm --filter web test -- --runInBand <affected-test-files>
pnpm drizzle:verify-bootstrap
scripts/typecheck-all.sh --changes-only
pnpm --filter web lint
pnpm format
pnpm format:check
git diff --check
```

`packages/db` has no `test` script. `packages/db/src/schema.test.ts` runs under web's Jest config, which includes `<rootDir>/../../packages/db/src/**/*.test.ts` (`apps/web/jest.config.ts:38`), so run it through `pnpm --filter web test`.

Report targeted checks as targeted, not as full validation.

Before the final commit, run React Doctor because this work changes React admin/revenue components. Compare its score to the starting score and fix regressions caused by this change. React Doctor is an agent-environment capability, not a repository script; do not present it as a repository command in the PR.

## File impact checklist

Expected new files:

- `apps/web/src/lib/service-fees/constants.ts`
- `apps/web/src/lib/service-fees/types.ts`
- `apps/web/src/lib/service-fees/calculation.ts`
- `apps/web/src/lib/service-fees/stripe-lines.ts`
- `apps/web/src/lib/service-fees/assessments.ts`
- `apps/web/src/lib/service-fees/checkout.ts`
- `apps/web/src/lib/service-fees/invoice-created.ts`
- `apps/web/src/lib/service-fees/settlement.ts`
- `apps/web/src/lib/service-fees/refunds.ts`
- `apps/web/src/lib/service-fees/tax.ts`
- `apps/web/src/lib/service-fees/alerts.ts`
- `apps/web/src/lib/service-fees/organization-exemptions.ts`
- `apps/web/src/lib/service-fees/disputes.ts`
- Corresponding focused tests
- `apps/web/src/app/admin/components/OrganizationAdmin/OrganizationAdminServiceFeeExemption.tsx`
- One generated migration and generated metadata
- A read-only pre-release classification audit script
- A read-only restricted-coupon audit check
- A corresponding operator partial-refund runbook in `kilo-org/on-call`

Expected modified files:

- `apps/web/src/lib/stripe-client.ts` — pin `apiVersion` (Phase 0)
- `packages/db/src/schema.ts`
- `packages/db/src/schema-types.ts` if shared enum exports are used
- `apps/web/src/lib/stripe/index.ts` — includes `handleUpdateSeatCount()` at line 1789
- `apps/web/src/lib/autoTopUp.ts`
- `apps/web/src/lib/organizations/organization-auto-top-up.ts`
- `apps/web/src/lib/credits.ts`
- `apps/web/src/lib/organizations/organization-billing.ts`
- `apps/web/src/routers/kilo-pass-router.ts`
- `apps/web/src/lib/kilo-pass/stripe-handlers-invoice-paid.ts`
- `apps/web/src/lib/kilo-pass/affiliate-sale.ts`
- `apps/web/src/lib/kilo-pass/cancel-and-refund.ts`
- `apps/web/src/lib/kilo-pass-org/stripe-adapter.ts`
- `apps/web/src/routers/organizations/organization-subscription-router.ts`
- `apps/web/src/routers/organizations/organization-admin-router.ts`
- `apps/web/src/app/admin/api/organizations/hooks.ts`
- `apps/web/src/app/admin/components/OrganizationAdmin/OrganizationAdminDashboard.tsx`
- `apps/web/src/lib/email.ts`
- `apps/web/src/emails/creditsTopUp.html`
- `apps/web/src/emails/AGENTS.md`
- `apps/web/src/lib/revenueKpi.ts`
- `apps/web/src/app/admin/components/RevenueStats.tsx`
- `apps/web/src/app/admin/components/RevenueDailyChart.tsx`
- `.specs/impact-affiliate-tracking.md`
- Existing focused test files named above

Do not change pre-purchase Kilo pricing UI, Kilo billing-history itemization, Kilo Pass payment email behavior, store billing, seat pricing, or KiloClaw pricing.

## Completion checklist

Implementation is complete only when all statements are true:

- [ ] Every included flow has a positive Stripe fee line when eligible.
- [ ] Every excluded flow remains fee-free.
- [ ] The cutoff uses returned Checkout creation time or invoice creation time exactly.
- [ ] Existing subscriptions receive post-activation invoice fees without pre-activation prorations.
- [ ] Discounts and proration credits produce an exact aggregate net 5% fee, whether by proportional allocation on Checkout or by exact calculation on invoices.
- [ ] The Stripe wire `apiVersion` is explicitly pinned.
- [ ] Exactly one code path attaches a fee to any given invoice, proven for Kilo-created auto-top-up invoices.
- [ ] Prepaid credit-balance consumption does not shrink the fee base.
- [ ] Mixed seat/Kilo Pass invoices never include seats in the base.
- [ ] Credits and entitlements use product principal, never gross paid amount.
- [ ] Exact-organization exemptions are admin-only, reasoned, audited, and non-inherited.
- [ ] One durable assessment links all related Stripe identities.
- [ ] Fee failure proceeds without the fee, never retries collection, and alerts on every processing attempt.
- [ ] Slack failure cannot block payment.
- [ ] Tax-resolution or fee-application failure fails open in production without blocking payment.
- [ ] Collected fee revenue is recognized only after settlement and reduced by refunds and disputes.
- [ ] `charged_fee_minor` comes from the settled Stripe fee line, never from the value sent.
- [ ] The effective-rate deviation alert fires for a restricted coupon and no corrective charge or refund is issued.
- [ ] Missed and exempted values count only after underlying settlement.
- [ ] Affiliate amounts exclude the fee and rule 17 is amended.
- [ ] Full and cumulative partial refund calculations have no rounding drift.
- [ ] Top-up emails itemize positive fees and omit fee-free rows.
- [ ] Fee lines cannot be mistaken for seats, Kilo Pass, KiloClaw, or credit principal.
- [x] Finance confirmation of the mirrored tax treatment is recorded in ADR 0004.
- [ ] The coupon-allocation sandbox matrix is recorded before activation.
- [ ] Historical exemptions are entered and verified before activation.
- [ ] Live Stripe coupons are audited for `applies_to` restrictions on fee-bearing products.
- [ ] Rollback requires deployment rollback; no runtime global switch exists.
