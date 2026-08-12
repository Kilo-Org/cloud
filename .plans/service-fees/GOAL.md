# Stripe service fees

## Status

Agreed product goal. Created 2026-08-06 from product decisions and codebase analysis. Implementation is being delivered as a stacked PR series.

This file is the product requirements source. `SPEC.md` defines the technical design, `VALIDATION.md` defines the end-to-end proof, and `docs/adr/0004-stripe-service-fee-assessment.md` records the architectural decisions and invariants.

## Goal

Charge a 5% service fee on eligible Stripe-funded credit purchases for billing objects created at or after `2026-09-01T00:00:00Z`.

The fee is an additional charge. It does not increase or reduce the credits or Kilo Pass entitlement received. Stripe must show a positive fee as a separate line item named `Service fee (5%)`.

The change must support organization-specific historical exemptions, retain an auditable fee decision for each commercial billing event, keep product and fee revenue separate, and avoid blocking an underlying payment if fee processing fails.

## Definitions

- **Eligible product subtotal**: The aggregate net positive amount for fee-bearing credit products after eligible discounts and proration credits, before tax. It excludes seats, direct KiloClaw charges, the service fee itself, taxes, and unrelated invoice adjustments.
- **Service fee assessment**: The durable decision for one commercial billing event. It records the calculation inputs, cutoff and exemption decisions, expected and charged fee, outcome, settlement, refunds, and related Stripe identities.
- **Commercial billing event**: One customer purchase or subscription invoice, even when Stripe represents it with several objects such as a Checkout Session, Invoice, PaymentIntent, and Charge.
- **Organization exemption**: An internal, exact-organization exception that suppresses service fees on eligible purchases billed to that organization's Stripe customer.
- **Missed fee**: A positive fee that should have been charged but was omitted because fee processing failed open.

## Eligible transactions

The service fee applies to:

- Personal credit top-ups
- Organization credit top-ups
- The initial payment when enabling personal auto-top-up
- The initial payment when enabling organization auto-top-up
- Subsequent personal and organization automatic top-ups
- All Stripe-managed Personal Kilo Pass charges
- Self-service Kilo Pass for Organizations charges

Kilo Pass coverage includes:

- Initial purchases
- Renewals
- Upgrades
- Prorations
- Organization capacity increases
- Eligible future invoices for subscriptions created before the activation instant

All Stripe-managed Personal Kilo Pass subscriptions are treated as self-service. Kilo Pass for Organizations is eligible only when its purchase channel is self-service.

## Excluded transactions

The service fee does not apply to:

- Team or Enterprise seat charges
- Direct KiloClaw subscriptions
- App Store, Google Play, or other store-managed Kilo Pass purchases
- Manual or sales-assisted Kilo Pass for Organizations agreements

When an invoice contains both seats and Kilo Pass for Organizations, only the net eligible Kilo Pass amount forms the fee base. Seat charges and seat-only discounts must not affect the fee.

## Activation and timing

Fee eligibility is fixed when the applicable Stripe billing object is created.

- A billing object created at or after `2026-09-01T00:00:00Z` is eligible.
- A billing object created before that instant remains fee-free even if payment settles later.
- Interactive purchases use Checkout Session creation time.
- The initial invoice produced by an interactive Checkout inherits the Checkout Session's fee decision.
- Transactions without a Checkout Session use invoice creation time.
- Renewal and proration invoices use their own creation time.

Existing Kilo Pass subscriptions are not automatically grandfathered. Their eligible invoices created after activation carry the fee unless the exact billed organization is exempt.

## Fee calculation

For each commercial billing event:

1. Sum the net positive eligible product subtotal after discounts and proration credits.
2. Exclude tax, seats, KiloClaw charges, the service fee, and unrelated adjustments.
3. Calculate 5% of the aggregate subtotal.
4. Round once to the nearest cent using round-half-up.
5. Omit the fee line if the rounded fee is zero.

Discounts allocated to an eligible Kilo Pass charge must reduce its service fee proportionally. A seat-only discount must not reduce the Kilo Pass fee.

Proportional reduction is what the customer receives, regardless of the mechanism. On interactive Checkout the fee line is itself discountable, so a promotion code reduces product and fee by the same factor and the 5% ratio is preserved arithmetically. On invoices the fee is calculated from already-discounted lines and attached as non-discountable. Both produce the same result.

A discount reduces the fee base. A prepaid credit balance does not: the fee follows recognized product value, not cash received. A customer who redeems prepaid credit against an eligible purchase still owes the fee on the full product amount.

Examples:

| Billing event | Service fee |
|---|---:|
| $100.00 credit top-up | $5.00 |
| $49.00 Kilo Pass | $2.45 |
| $49.00 Kilo Pass with a 20% eligible discount | $1.96 |
| $30.00 positive Kilo Pass proration | $1.50 |
| $720.00 seats plus $49.00 Kilo Pass | $2.45 |
| $0.01 eligible subtotal | $0.00; omit the fee line |

The customer receives the selected credit principal or normal Kilo Pass entitlement. For example, a `$100.00` top-up charges `$105.00` before tax and grants exactly `$100.00` in credits.

The service fee follows the eligible product's Stripe tax treatment. The fee base itself is calculated before tax. Finance/tax treatment was confirmed on 2026-08-11: the 5% service-fee line uses the same Stripe `tax_behavior` as the eligible product it accompanies.

If resolving or applying that treatment fails, fee processing fails open: the payment proceeds without a fee. A fee-domain failure never blocks a customer payment.

## Stripe presentation

A positive fee must appear as a separate Stripe line item named:

`Service fee (5%)`

Exempt, pre-activation, zero-rounded, and fail-open billing events omit the line. Stripe must not display a zero-value or "waived" fee line.

Stripe Checkout, hosted invoices, PDFs, and receipts remain the authoritative itemized billing records.

## Organization exemptions

A platform admin can grant or revoke an exemption from the organization's Admin UI record.

Exemption rules:

- The exemption applies only to purchases owned and billed by the exact organization.
- It does not inherit to a parent or child organization.
- It does not apply to members' personal purchases.
- Granting or revoking an exemption requires a reason.
- A change affects only billing objects created afterward.
- Existing invoices are not changed, refunded, credited, or charged retroactively.
- Exemption status, reason, actor, and history are visible only to platform admins.
- Customer-facing organization APIs and organization audit logs must not expose exemption data.
- Exempt customers simply receive Stripe billing objects without a fee line.

The exemption feature and Admin UI must be deployed before activation. Platform admins will enter the approved historical exemptions and reasons through the Admin UI. The system must not infer exemptions from fields such as seat requirements, sponsorship, plan, hierarchy, or trial settings. There is no source-controlled organization allowlist.

## Durable assessments

The system must persist one idempotent service fee assessment per commercial billing event. Related Stripe objects enrich the same assessment and must not create duplicate assessments or fee revenue.

An assessment must retain enough information to explain and reconcile the decision, including:

- Commercial event and flow type
- Applicable user or exact organization owner
- Checkout Session, invoice, PaymentIntent, and charge identifiers when available
- Billing-object creation time and cutoff result
- Eligible subtotal
- Expected fee
- Charged fee
- Exemption decision
- Outcome, including charged, exempt, pre-activation, zero-rounded, or missed
- Settlement state and settled amounts
- Cumulative principal and fee refunds
- Operational failure reason where applicable

The assessment is the source for fee reporting, reconciliation, and refund calculations. Stripe remains the source for the actual customer charge and invoice presentation.

## Failure behavior

Fee processing fails open.

If fee calculation, exemption lookup, or fee attachment fails:

- The underlying purchase, automatic top-up, renewal, or proration proceeds without the fee.
- Credits and entitlements follow their normal settlement rules.
- The assessment records the expected fee and missed outcome.
- The missed fee is never charged retroactively or carried into another billing event.
- Each processing retry sends another notification through the existing Admin Slack notification system. Retry alerts are intentionally not deduplicated.
- Slack delivery failure does not block payment processing.
- Notifications may contain non-sensitive billing identifiers, amounts, flow type, and reason codes. They must not contain tokens, payment credentials, sensitive headers, or other secrets.

There is no runtime kill switch. Disabling service fees requires a deployment rollback or code change.

## Credit settlement

Credit settlement must use the trusted credit principal, not the gross Stripe amount.

Today, top-up settlement uses `charge.amount` or `invoice.amount_paid`, both of which will include the service fee after this change. Those values must not determine credits granted. A `$100.00 + $5.00` payment must create only `$100.00` of credits.

Personal Kilo Pass entitlement remains based on its configured tier rules rather than invoice total. Kilo Pass reporting and affiliate calculations must use product amounts that exclude the service fee.

## Refunds

The service fee is refundable in proportion to the eligible product principal refunded.

- A full refund returns the full service fee.
- A partial refund returns the corresponding portion of the service fee.
- Multiple partial refunds use cumulative proportional rounding: calculate the total fee that should have been refunded for cumulative eligible principal refunded, round half-up, then subtract fee already refunded.
- A fully refunded purchase must return exactly the full original fee, without rounding drift.
- Settled refunds reduce collected service-fee revenue.

This work does not add a general partial-refund Admin UI. Existing Kilo-initiated full-refund paths must include the full gross payment, including the fee. Operators issuing partial refunds directly in Stripe must include the proportional fee according to the operator runbook. Stripe refund events update the durable assessment with observed refund amounts.

A chargeback reverses the fee in the same way a refund does, because the money leaves the account. A dispute later resolved in Kilo's favor restores it. Disputed amounts are tracked separately from refunds, since a dispute outcome can move in either direction.

The system must not automatically issue a second refund when an operator's Stripe partial refund appears not to include a proportional fee because the operator's intended gross-versus-principal amount cannot be inferred safely.

## Revenue and affiliate reporting

Service-fee revenue is separate from product revenue.

- Credits and Kilo Pass product revenue exclude the fee.
- Affiliate-commissionable amounts exclude the fee.
- Gross-payment and fraud telemetry may include the full charge.
- Collected service-fee revenue is recognized only after Stripe confirms payment settlement.
- Unpaid or abandoned billing objects do not count as collected, missed, or exempted revenue.
- Settled refunds and withdrawn chargebacks reduce collected fee revenue.
- Collected fee revenue is measured from the fee Stripe actually settled, not the fee Kilo requested. On discounted interactive purchases these differ.

The Admin revenue dashboard must report separately:

- Eligible product revenue
- Collected service-fee revenue
- Gross revenue
- Expected but missed fee value for settled payments
- Exempted fee value for settled payments
- Corresponding settled event counts

Unpaid and abandoned assessments remain available for audit but do not count as revenue or revenue leakage.

## Customer communications

### Existing top-up emails

Existing personal, organization, and automatic top-up confirmation emails must itemize the following when a positive fee was charged:

- Credits added
- `Service fee (5%)`
- Total paid

When no fee was charged, the email omits the fee row and does not reveal whether the reason was exemption, pre-activation timing, zero rounding, or a fail-open error.

### Kilo Pass emails

This change does not introduce new Personal Kilo Pass or Kilo Pass for Organizations payment or renewal emails. If such emails are added later and state an eligible payment amount, they should itemize product principal, service fee, and gross payment.

### Kilo UI and billing history

Kilo's pre-purchase price controls and auto-top-up settings remain unchanged. Stripe Checkout discloses the fee before an interactive payment.

Kilo billing-history tables continue to show the gross invoice amount without a fee breakdown. Customers can use the linked Stripe invoice or PDF for authoritative line-item details.

## Operational constraint: product-restricted coupons

A Stripe coupon restricted to specific products (`applies_to`) would discount an eligible product without discounting the fee line, making the customer pay more than the published 5%. Because the customer enters promotion codes on Stripe's hosted page, this cannot be detected before the fact, and a dashboard-created coupon requires no deployment.

Therefore: never create a coupon restricted to a fee-bearing product. This is an operational rule with a scheduled detection check and a settlement-time effective-rate alert, not something code can prevent.

## Out of scope

- Service fees on seats or direct KiloClaw subscriptions
- Store-managed Kilo Pass fees
- Fees on manual or sales-assisted agreements
- Personal-user fee exemptions
- Parent, child, or member inheritance of organization exemptions
- A customer-facing exemption indicator
- A general partial-refund Admin UI
- New Kilo Pass payment or renewal emails
- A runtime fee kill switch
- Retroactive fee collection
- Changes to Kilo pre-purchase price presentation or billing-history itemization

## Codebase impact identified during analysis

This is a cross-cutting billing change, not a Checkout-only change.

### Stripe creation and lifecycle paths

Expected areas include:

- `apps/web/src/lib/stripe/index.ts`
  - Manual top-up Checkout
  - Personal auto-top-up setup Checkout
  - Credit settlement and webhook dispatch
- `apps/web/src/lib/organizations/organization-auto-top-up.ts`
  - Organization auto-top-up setup Checkout
- `apps/web/src/lib/autoTopUp.ts`
  - Subsequent off-session automatic invoices
- `apps/web/src/routers/kilo-pass-router.ts`
  - Personal Kilo Pass Checkout and subscription changes
- `apps/web/src/lib/kilo-pass-org/stripe-adapter.ts`
  - Organization Kilo Pass add-on invoices and mixed seat invoices
- `apps/web/src/routers/organizations/organization-subscription-router.ts`
  - Seat and Kilo Pass capacity changes and schedules

Existing recurring subscriptions need invoice-time fee handling. Updating only new Checkout Sessions would miss renewals for subscriptions created before activation.

### Persistence and Admin UI

Expected areas include:

- `packages/db/src/schema.ts` and generated migrations
- Internal exemption state and history
- Service fee assessments and Stripe identity links
- `apps/web/src/routers/organizations/organization-admin-router.ts`
- `apps/web/src/app/admin/components/OrganizationAdmin/`

Exemption history must not use a customer-visible organization audit stream.

### Reporting, alerts, and email

Expected areas include:

- `apps/web/src/lib/revenueKpi.ts`
- Admin revenue dashboard components
- `apps/web/src/lib/slack/admin-notifications.ts`
- Existing top-up email sending contracts and template

### Classification risks

A service-fee line must never be mistaken for:

- A Kilo Pass for Organizations subscription add-on
- A seat item
- A direct KiloClaw item
- Credit principal

This is especially important in organization Kilo Pass code that currently treats a non-seat subscription item as the Kilo Pass item.

## Acceptance criteria

The implementation plan must provide verification for at least these cases:

1. Exact activation-boundary behavior for Checkout-created and invoice-created transactions.
2. Correct fees for manual top-ups, auto-top-up setup, subsequent auto-top-ups, Personal Kilo Pass, and self-service Kilo Pass for Organizations.
3. No fee for seats, direct KiloClaw, store purchases, or manual organization agreements.
4. Mixed seat and Kilo Pass invoices charge only on the net eligible Kilo Pass portion.
5. Eligible product discounts proportionally reduce the fee; seat-only discounts do not.
6. Aggregate half-up rounding and omission of zero-cent fee lines.
7. Credit grants use principal rather than gross payment.
8. Existing subscriptions receive fees on post-activation invoices.
9. Exact-organization exemption behavior and Admin-only grant, revoke, reason, and history access.
10. One assessment across related Checkout, invoice, PaymentIntent, and charge objects.
11. Idempotent settlement and reporting across webhook retries.
12. Fail-open payment behavior, durable missed-fee records, and a repeated Admin Slack alert on every retry.
13. Collected, missed, and exempted dashboard values use settled payments only.
14. Affiliate amounts exclude fees while gross fraud telemetry can include them.
15. Full and cumulative partial-refund calculations return no more or less than the original fee.
16. Fee-bearing top-up emails itemize Credits added, `Service fee (5%)`, and Total paid; fee-free emails omit the fee row.
17. Billing-history summaries remain unchanged and Stripe invoices contain the authoritative fee line.
18. Fee lines do not interfere with existing seat, Kilo Pass, KiloClaw, invoice, or refund classifiers.

## Release prerequisites

- Finance/tax confirmed on 2026-08-11 that the fee receives the same Stripe tax treatment as the eligible product.
- The schema, Admin exemption controls, assessment pipeline, reporting, and alerting are deployed before activation.
- Platform admins enter and verify all approved historical organization exemptions before `2026-09-01T00:00:00Z`.
- Operators have a documented procedure for proportional partial refunds in Stripe and for responding to missed-fee Slack alerts.
- Rollout verification confirms that existing Personal Kilo Pass and self-service Kilo Pass for Organizations invoices created after activation receive the correct fee.

## Main implementation risks

1. Attaching recurring fees to invoices for existing subscriptions.
2. Preserving an exact 5% net fee after Stripe discounts and mixed-invoice allocation.
3. Keeping seat charges and seat-only discounts out of the fee base.
4. Separating gross payment from credit principal everywhere credits are granted.
5. Preventing fee lines from being misclassified as products.
6. Updating one durable assessment across asynchronous Stripe objects and retries.
7. Reporting fail-open leakage without counting unpaid or duplicate events.
8. Reconciling cumulative partial refunds without rounding drift.
9. Validating the confirmed mirrored tax treatment in Stripe test mode before release.
