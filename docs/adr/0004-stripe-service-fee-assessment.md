# ADR 0004: Base Stripe Service Fees on Recognized Product Value with Durable Assessments

## Status

Accepted

The fee-base, dispute, assessment, and tax-treatment decisions below are settled. The Checkout
coupon-allocation contract was verified in Stripe test mode on 2026-08-10; results are recorded
under Invariants. On 2026-08-11, finance/tax treatment was confirmed: the 5% service-fee line uses
the same Stripe `tax_behavior` as the eligible product it accompanies.

Planning detail lives in `.plans/service-fees/GOAL.md` and `.plans/service-fees/SPEC.md`. That
directory is not tracked, so this ADR is the durable record.

## Context

Kilo will charge a 5% service fee on eligible Stripe-funded credit purchases and Kilo Pass charges
for billing objects created at or after `2026-09-01T00:00:00Z`. The fee is additional to the
purchase price and never changes the credits or entitlement received.

Three existing properties of the codebase shape the design.

Credit settlement currently derives the granted amount from the gross Stripe payment.
`handleSuccessfulChargeWithPayment()` uses `charge.amount`, and the `invoice.paid` auto-top-up
branches pass `invoice.amount_paid` to the top-up processors. Once a fee is added to those payments,
any path that continues to read the gross amount would grant the customer the fee as credit.

Product classification is inferred from invoice lines and subscription items. Kilo Pass for
Organizations resolves its subscription item as the first non-seat item, and the Kilo Pass and
KiloClaw invoice classifiers match against known price identifiers. A new billing line that is
neither seat nor a known price can be mistaken for a product.

Kilo owns some invoice lifecycles and Stripe owns others. Automatic top-up invoices are created by
Kilo with `auto_advance: false` and paid directly, while renewals and prorations are advanced by
Stripe from a draft state. These require different fee-attachment points, and both emit
`invoice.created`.

Fee revenue must also be reportable separately from product revenue, must survive Stripe webhook
retries and out-of-order delivery, and must never block an underlying payment when fee processing
fails.

## Decision

### The fee base is recognized product value, not cash received

The eligible subtotal is the net pretax amount of fee-bearing product lines after discounts and
proration credits.

A discount reduces the fee base, because it reduces the price. A prepaid balance does not, because
it is a payment method rather than a price reduction. A customer who settles an eligible $49 charge
with $49 of prepaid Stripe billing credit still generates $49 of product revenue and owes the fee on
that amount.

This distinction is load-bearing in code because Stripe represents both in the same field.
`Stripe.InvoiceLineItem.pretax_credit_amounts` carries entries of type `discount` and of type
`credit_balance_transaction`. Only `discount` entries reduce the base. Customer credit balance from
credit notes or overpayment does not appear in that field at all and affects only cash recorded as
gross paid.

### One durable assessment per commercial billing event

A commercial billing event is a single customer purchase or subscription invoice, even when Stripe
represents it with a Checkout Session, an Invoice, a PaymentIntent, and a Charge.

Each event gets one idempotent service fee assessment keyed by an application-owned assessment key
propagated through Stripe metadata. Related Stripe objects enrich that row rather than creating
additional rows or additional fee revenue. The assessment records the calculation inputs, the cutoff
and exemption decisions, the expected and charged fee, settlement, refunds, disputes, and the
related Stripe identities.

The assessment is the source for fee reporting, reconciliation, and refund calculation. Stripe
remains the source for the actual customer charge and for invoice presentation.

A single `outcome` column carries the fee decision. Settlement, refund, and dispute state are
separate columns, because they answer different questions and move on different schedules.

### Fees are explicit metadata-marked lines, never a subscription item

A positive fee is an explicit one-time line or invoice item labelled `Service fee (5%)`, carrying
namespaced metadata that identifies it as a Kilo service fee and links it to its assessment. It is
never a recurring subscription item.

A line is recognized as a service fee only by that metadata or by an assessment link. Its display
description is never sufficient. Recurring fees are added per invoice, which covers subscriptions
created before activation without modifying them in advance.

### Exactly one code path attaches a fee to any given invoice

For invoices Kilo creates and pays, the creating code attaches the fee before payment and the
`invoice.created` webhook must skip the invoice. For invoices Stripe advances, the `invoice.created`
handler attaches the fee while the invoice is still draft.

Assessment-key uniqueness does not make this safe on its own, because both paths would derive the
same key and race. Ownership is decided by invoice metadata, not by ordering or by database
contention.

### Interactive Checkout fee lines are discountable, and that is correct

Subscription-mode Checkout supports neither `add_invoice_items` nor a `discountable` flag on line
items. A fee line on a Checkout Session is therefore always discountable, and a promotion code the
customer redeems on Stripe's hosted page discounts the fee along with the product.

This is accepted rather than worked around. The fee line sits inside the discounted subtotal, so
both lines scale by the same factor and the 5% ratio is preserved:

```text
0.05 x list x (1 - d) === 0.05 x (list x (1 - d))
```

The fee is therefore computed from list price before session creation, and hosted promotion-code
entry is retained. The consequence is that the fee Kilo requests and the fee Stripe settles differ
on discounted purchases, so the collected amount must be read from the settled invoice line and
never from the value sent.

Fees attached to invoices are calculated from already-discounted lines and marked
`discountable: false`, so they are exact. The asymmetry between the two mechanisms is intentional.

### Fee processing fails open

If fee calculation, exemption lookup, tax resolution, or fee attachment fails, the underlying
purchase proceeds without the fee. The assessment records the expected fee and a missed outcome, and
an alert is sent on every processing attempt.

A missed fee is never collected retroactively and never carried into another billing event. There is
no runtime kill switch; disabling the feature requires a deployment rollback.

This applies in production as well as in development. A fee-domain failure, including inability to
resolve a Price's tax behavior, never blocks a customer payment.

### Refunds and chargebacks reduce collected fee revenue

The fee is refundable in proportion to the eligible product principal refunded, using cumulative
proportional rounding so that a fully refunded purchase returns exactly the original fee.

A chargeback also reduces collected fee revenue, because the money leaves the account. Disputes are
tracked in columns separate from refunds: refunds accumulate monotonically, while a dispute resolved
in Kilo's favor restores the funds and must be reversible without violating that invariant.

### Organization exemptions are exact, internal, and time-resolved

A platform admin may exempt an exact organization, with a required reason and internal-only history.
Exemptions do not inherit to parent organizations, child organizations, or members' personal
purchases, and are never inferred from seat counts, plan, sponsorship, hierarchy, or trial settings.

Eligibility is resolved against the exemption history row effective at the billing object's creation
instant, not against current state at webhook delivery. Exemption history is not written to
`organization_audit_logs`, which is reachable by customers through an organization-scoped procedure.

## Invariants (what not to change without revisiting this ADR)

1. Credits and entitlements derive from the trusted product principal. No path grants credit from
   `charge.amount`, `invoice.amount_paid`, or any other gross payment amount.
2. Only `pretax_credit_amounts` entries of type `discount` reduce the eligible subtotal. Prepaid
   balance consumption does not.
3. A service-fee line is identified by namespaced metadata or an assessment link, never by its
   description. Seat, Kilo Pass, and KiloClaw classifiers must remain unable to match it.
4. Exactly one code path attaches a fee to a given invoice, decided by invoice metadata.
5. The fee actually collected is read from the settled Stripe fee line. Do not add a database
   constraint requiring the charged fee to equal the expected fee; on discounted Checkout purchases
   it legitimately does not.
6. Fee-domain failure never fails a payment closed, and a missed fee is never collected later.
7. Refund columns are monotonic. Dispute columns are not.
8. Eligibility is resolved at the billing object's creation instant, never at webhook-delivery time.
9. Kilo Pass reported amounts for affiliate purposes exclude the fee. This required amending rule 17
   of `.specs/impact-affiliate-tracking.md`, which previously mandated the settled invoice paid
   amount.
10. Finance/tax treatment was confirmed on 2026-08-11: inline fee lines inherit the eligible
    inline product's treatment, while Price-based fee lines mirror the eligible Price's explicit
    `inclusive` or `exclusive` `tax_behavior`.
11. Stripe test-mode Checkout verified the discountable-fee-line allocation on 2026-08-10 with a
    $49.00 recurring product and a $2.45 one-time fee line:

    | Coupon | Product net | Fee net | Result |
    | --- | ---: | ---: | --- |
    | Unrestricted 20% | $39.20 | $1.96 | Both lines reduced 20% |
    | Unrestricted fixed $10 | $39.47 | $1.98 | Proportional cent allocation; effective rate within one cent |
    | Product-restricted 20% | $39.20 | $2.45 | Fee untouched; confirms the deviation signature |
    | Unrestricted 100% | $0.00 | $0.00 | Both lines zero |

    The four Sessions were inspected while open and then expired. Temporary promotion codes were
    deactivated, coupons deleted, and test catalog objects archived. No payment or subscription was
    completed.

## Alternatives

**Charge the fee as a recurring subscription item.** Rejected. It would make the fee a product-like
item on every subscription, exposing it to the classifiers that resolve seat and Kilo Pass items,
and would require modifying existing subscriptions before activation.

**Compute the Checkout fee from the final discounted subtotal.** This is the theoretically exact
approach, but Stripe offers no generally available server-side callback between hosted
promotion-code selection and payment confirmation. Dynamic Checkout line-item updates and dynamic
discounts are private preview. Rejected as a schedule dependency on an external launch.

**Move promotion-code entry into Kilo's own UI** and pass the code server-side through
`SessionCreateParams.discounts`, which is generally available. This would make the subtotal known
before session creation, keep the expected-equals-charged invariant everywhere, and make
product-restricted coupons structurally harmless. Rejected for this release in favor of preserving
the existing hosted-Checkout conversion path. It remains the preferred fallback if the coupon
allocation proof in Invariant 10 fails.

**Charge the fee on undiscounted list price and let it stand.** Rejected. It would collect more than
5% of the amount the customer actually paid.

**Reconcile fee shortfalls after settlement with credit adjustments.** Rejected. Compensating with
post-settlement credit math hides an incorrect charge instead of charging correctly.

## Consequences

Fee revenue, missed fee value, and exempted fee value become separately reportable and reconcilable
against Stripe, because a durable assessment exists for every commercial billing event.

Two reporting discontinuities are introduced and must be labelled rather than presented as a
continuous trend. Refund and dispute adjustment applies only to assessment-backed rows, so legacy
revenue remains gross. Kilo Pass product revenue is newly visible, because it previously created no
credit transaction and was absent from the revenue query entirely.

A product-restricted Stripe coupon would discount an eligible product without discounting the fee
line, causing the customer to pay more than the published 5%. This cannot be prevented in code: the
code is entered after session creation, and a dashboard-created coupon requires no deployment. It is
controlled operationally through a policy against restricted coupons on fee-bearing products, a
scheduled detection check, and a settlement-time effective-rate alert. This is a real residual risk
accepted in exchange for retaining hosted promotion-code entry.

Fail-open behavior means revenue leakage is possible and must be observable. Missed fees are
durable, alerted on every processing attempt, and reported separately from collected revenue.

The Stripe wire API version must be pinned explicitly. The client previously relied on the account
default, which can diverge from the installed typings and can be changed from the Stripe dashboard
without a deployment. Every line-shape assumption in this design depends on that contract.

## References

- ADR 0003: Use Org-Owned Agreements for Kilo Pass for Organizations, for the agreement records and
  bound subscription item this design must not disturb
- `.specs/impact-affiliate-tracking.md`, rule 17, amended by this work
- `.specs/kilo-pass.md` and `.specs/team-enterprise-seat-billing.md` for the product boundaries that
  determine fee eligibility
