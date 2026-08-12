# Service fee operations

Internal runbook for the 5% Stripe service fee on eligible credit top-ups and
Stripe-managed Kilo Pass charges. This document is the operator procedure.

Activation instant: `2026-09-01T00:00:00Z`. Billing objects created before that
instant stay fee-free even if they settle later.

Do not schedule or deploy from this document. The audits below are manual,
read-only, and default to no Stripe or database writes.

## Identify an assessment from an invoice or charge

One commercial billing event has one `stripe_service_fee_assessments` row. Related
Checkout, invoice, PaymentIntent, and charge objects enrich that row. They do not
create more fee revenue.

Lookup order:

1. Stripe Invoice metadata `serviceFeeAssessmentKey`.
2. Checkout Session metadata `serviceFeeAssessmentKey`.
3. Subscription metadata `serviceFeeAssessmentKey`.
4. PaymentIntent metadata `serviceFeeAssessmentKey`.
5. Charge metadata `serviceFeeAssessmentKey`.
6. Invoice or Checkout line whose metadata `type` is `kilo-service-fee`. Use
   `serviceFeeAssessmentKey` on that line. Do not trust the description
   `Service fee (5%)` alone.
7. Database, in this order: `assessment_key`, `stripe_invoice_id`,
   `stripe_charge_id`, `stripe_payment_intent_id`, `stripe_checkout_session_id`.

Record the assessment key, flow, outcome, `eligible_subtotal_minor`,
`expected_fee_minor`, `charged_fee_minor`, `settled_product_minor`,
`refunded_product_minor`, `refunded_fee_minor`, and any `failure_code`. Amounts
are USD minor units.

If no assessment exists for a post-activation eligible payment, treat that as an
operational error. Do not grant credits from `charge.amount` or
`invoice.amount_paid`.

## Cumulative fee refund formula

Refund the fee in proportion to eligible product principal already refunded.
Calculate the cumulative target, then subtract fee already refunded.

```text
if cumulativeProductRefundMinor == 0
  or originalProductMinor == 0
  or originalFeeMinor == 0:
  target = 0
else if cumulativeProductRefundMinor == originalProductMinor:
  target = originalFeeMinor
else:
  target = round_half_up(originalFeeMinor * cumulativeProductRefundMinor / originalProductMinor)

incrementalFee = target - refunded_fee_minor already recorded
```

Use integer minor units and round half-up once on the aggregate. Never compute
`0.05 * dollars` in floating point. A fully refunded purchase must return exactly
the original fee.

Worked example, $49.00 product and $2.45 fee:

| Cumulative product refund | Fee target | Incremental fee |
| --- | ---: | ---: |
| $20.00 | $1.00 | $1.00 |
| $49.00 | $2.45 | $1.45 |

Worked example that needs half-up: $100.00 product, $5.00 fee, $33.33 product
refunded. Target is `round_half_up(500 * 3333 / 10000) = 167` cents ($1.67).

The incremental Stripe refund amount is:

```text
incremental product principal + incremental service fee
```

## Issue principal plus fee in Stripe

There is no partial-refund Admin UI. Kilo-initiated full refunds already refund
the remaining PaymentIntent, which includes the fee. Keep that behavior.

For an operator partial refund:

1. Load the assessment and confirm `settled_product_minor` and
   `charged_fee_minor`.
2. Decide the cumulative product principal that should be refunded after this
   action.
3. Compute the incremental product and incremental fee from the formula above.
4. Prefer a Stripe Credit Note on the invoice. Allocate those two amounts to the
   eligible product line and the `kilo-service-fee` line. Then refund the
   resulting customer balance.
5. If the charge has no invoice lines, create a Charge Refund for exactly
   incremental product plus incremental fee. Record the intended allocation in
   the ticket. The webhook cannot infer that split from a bare Charge Refund.
6. Wait for `charge.refunded` and, when used, `credit_note.created` /
   `credit_note.updated`. Confirm `refunded_product_minor` and
   `refunded_fee_minor` match the target.

Do not add a second fee-only refund to "fix" a shortfall unless the intended
principal amount is documented and the assessment still has remaining fee. If
the intended split is unknown, stop. See the next section.

## Why ambiguous partial refunds are not auto-corrected

A Charge Refund has a single gross amount. It does not say whether the operator
meant product only, product plus fee, or some other mix.

If the system assumed "operator forgot the fee" and issued a second refund, it
could refund more than the customer paid or more than the operator intended. If
it assumed "operator included the fee" and wrote product/fee columns from a
guess, collected fee revenue would drift from Stripe.

Therefore:

- A Charge Refund is treated as a full refund only when cumulative gross
  refunded equals the charge amount. Then product and fee are both fully
  refunded.
- Any other partial Charge Refund without a Kilo-persisted allocation or Credit
  Note is recorded as `refund_allocation_unresolved`. Operations is alerted.
  No automatic second refund is created.
- Credit Notes are the supported way to attribute partial invoice refunds.

Do not change `outcome` from `missed` to `charged` to collect a missed fee
later. Do not invent a later invoice to recover a missed fee.

## Clear a reconciliation alert

Alerts may use codes such as `refund_allocation_unresolved`,
`service_fee_rate_deviation`, `service_fee_settlement_mismatch`, or
`service_fee_missed`.

1. Open the Slack thread and copy `assessment_key` plus the Stripe invoice or
   charge id. Those payloads are namespaced and must not contain secrets.
2. Retrieve the assessment and the live Stripe objects. Compare line amounts,
   refunds, credit notes, and dispute state.
3. If Stripe already matches the intended principal-plus-fee split, wait for
   webhook retry or redeliver the relevant event. Do not edit assessment rows
   by hand.
4. If the operator refund was incomplete and the intended split is known, issue
   the remaining incremental product and fee through a Credit Note or a
   documented Charge Refund. The next webhook should clear
   `refund_allocation_unresolved`.
5. If the operator intended a principal-only refund and accepts the remaining
   fee, document that in the ticket and leave the unresolved flag until
   engineering confirms there is no safe automatic allocation. Do not invent
   product/fee numbers in SQL.
6. Rate-deviation alerts are the restricted-coupon signature. Do not issue a
   corrective charge or refund. Disable or replace the coupon, then reply in
   the Slack thread with the coupon id and the observed `charged_fee_minor` /
   `settled_product_minor`.
7. Missed-fee alerts are fail-open by design. Confirm the underlying payment
   succeeded, then leave the assessment `missed`. Reply with the failure code.
   Slack retries are not deduplicated; a repeated alert is not a second missed
   fee unless the `assessment_key` is new.
8. After Stripe and the assessment agree, reply in the original Slack thread
   with `assessment_key`, the resolution code, and the Stripe object ids. Do
   not paste webhook bodies, customer email, or secret-bearing errors.

## Restricted coupons are prohibited

Never create a Stripe coupon whose `applies_to.products` includes a fee-bearing
Kilo Pass or top-up product.

Hosted Checkout promotion codes discount every discountable line, including the
initial Kilo Pass fee line. That keeps the published 5% ratio. A product
restriction discounts the Kilo Pass or top-up line and leaves the fee line
untouched, so the customer pays more than 5%. Dashboard-created coupons need no
deploy, so code cannot prevent this.

Allowed:

- Unrestricted percent-off or fixed-amount coupons.
- Coupons restricted only to seats or KiloClaw.

Forbidden:

- `applies_to` that includes any Kilo Pass product used by personal or
  self-service org Kilo Pass.
- `applies_to` that includes the default top-up product from
  `STRIPE_TOP_UP_PRICE_ID`.

If a restricted coupon already exists, delete or replace it. Do not leave it
valid "for one campaign". Then run the audit below.

## Read-only audits

Do not pass `--execute`, `--run-actually`, `--write`, or `--mutate`. Both
scripts refuse those flags.

### Pre-release Kilo Pass classification

Lists live Stripe-managed Personal Kilo Pass subscriptions and self-service org
Kilo Pass agreements, retrieves each Stripe subscription, and checks that
invoice classification can uniquely identify the Kilo Pass item.

```sh
pnpm --filter web script:run service-fees kilo-pass-classification-audit
```

The script reads `kilo_pass_subscriptions` and `kilo_pass_org_agreements` and
calls only `subscriptions.retrieve`. It does not update subscriptions. Exit
status is non-zero when any row is unclassifiable.

### Restricted coupon audit

Lists Stripe coupons and alerts Admin Slack when `applies_to.products`
intersects known fee-bearing Kilo Pass or top-up products.

```sh
pnpm --filter web script:run service-fees restricted-coupon-audit
pnpm --filter web script:run service-fees restricted-coupon-audit --no-alert
```

The script calls only `coupons.list` and `prices.retrieve`. Slack payloads use
the `service_fee.restricted_coupon_detected` namespace and contain coupon ids,
product ids, and validity only. They must not include webhook URLs, API keys,
customer email, or coupon secrets. `--no-alert` still lists findings and still
exits non-zero when restricted coupons exist.

Run both audits before activation. The coupon audit may be repeated after any
dashboard coupon change. Do not add a production schedule from this repository
without a separate operations change.
