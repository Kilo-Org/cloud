# Monthly Billing Option — Implementation Plan

## Goal

Add monthly billing as an option alongside the existing annual billing for
Team and Enterprise seat subscriptions, per the spec in
`.specs/team-enterprise-seat-billing.md` (changelog entry 2026-03-26).

## Current State

- **Annual-only**: Checkout uses each Stripe product's `default_price`
  (annual). No cycle selection exists in the UI or API.
- **DB column exists but is dead**: `organization_seats_purchases.billing_cycle`
  (`'monthly' | 'yearly'`, default `'monthly'`) is never populated from Stripe
  data — every row says `'monthly'` regardless of actual interval.
- **Pricing constants are annual-effective**:
  `TEAM_SEAT_PRICE_MONTHLY_USD = 15` and `ENTERPRISE_SEAT_PRICE_MONTHLY_USD = 60`
  represent the _per-month-equivalent_ of the annual rate. The true monthly
  prices ($18 and $72) don't exist in code.
- **No billing-cycle-change endpoint** exists for org subscriptions (KiloPass
  has one using Stripe subscription schedules — usable as a reference pattern).

## Stripe Setup (Manual, Pre-Implementation)

Before any code changes, new monthly Stripe prices must be created in the
Stripe dashboard (or via API) for each product:

| Product    | Existing Annual Price | New Monthly Price |
| ---------- | --------------------- | ----------------- |
| Teams      | $180/seat/year        | $18/seat/month    |
| Enterprise | $720/seat/year        | $72/seat/month    |

The new monthly prices will be looked up by code at checkout time. Two
approaches for resolution:

- **Option A — New env vars**: Add `STRIPE_TEAMS_MONTHLY_PRICE_ID` and
  `STRIPE_ENTERPRISE_MONTHLY_PRICE_ID`; keep existing products and their
  default prices for annual.
- **Option B — Price lookup keys**: Use Stripe lookup keys on prices
  (e.g., `teams_monthly`, `teams_annual`) and resolve at checkout via
  `stripe.prices.list({ lookup_key })`.

**Recommendation**: Option A (new env vars). It's simpler, matches the
existing pattern (product IDs are already env vars), avoids an extra Stripe
API call, and is easier to test.

## Implementation Steps

### Step 1: Update pricing constants

**File**: `src/lib/organizations/constants.ts`

Add the actual monthly prices and restructure constants:

```
TEAM_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = 18
TEAM_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = 15
ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_MONTHLY_USD = 72
ENTERPRISE_SEAT_PRICE_MONTHLY_BILLED_ANNUALLY_USD = 60
```

Keep the old names as aliases initially to avoid breaking existing imports,
then migrate callers.

### Step 2: Add Stripe price ID env vars for monthly prices

**File**: `src/lib/config.server.ts`

```
STRIPE_TEAMS_MONTHLY_PRICE_ID
STRIPE_ENTERPRISE_MONTHLY_PRICE_ID
STRIPE_TEAMS_ANNUAL_PRICE_ID
STRIPE_ENTERPRISE_ANNUAL_PRICE_ID
```

Since checkout currently resolves price via `product.default_price`, we need
to transition to explicit price IDs for both cycles. The annual price IDs
can initially be populated from the existing products' default prices. This
avoids the extra `products.retrieve` call at checkout time entirely.

### Step 3: Add `billingCycle` to the API and types

**Files**:

- `src/lib/organizations/organization-types.ts` — add
  `BillingCycle = 'monthly' | 'annual'` type (or reuse `BillingCycle` from
  schema, but rename `'yearly'` → `'annual'` for spec consistency, or keep
  `'yearly'` and map at boundaries).
- `src/routers/organizations/organization-subscription-router.ts` —
  add `billingCycle: z.enum(['monthly', 'annual'])` to
  `SubscriptionRequestSchema`.

**Decision needed**: The DB type uses `'yearly'`; the spec says `'annual'`.
I will keep the DB column as `'yearly'` (avoiding a migration) and map at
boundaries (API accepts `'annual'`, stores as `'yearly'`).

### Step 4: Update checkout to accept and use billing cycle

**File**: `src/lib/stripe.ts` — `getStripeSeatsCheckoutUrl()`

Changes:

1. Add `billingCycle` to `GetStripeCheckoutUrlProps`.
2. Replace the `product.default_price` lookup with a direct price ID
   resolution: `getPriceIdForPlanAndCycle(plan, billingCycle)` which
   returns the appropriate env var value.
3. Remove the `products.retrieve` call entirely (no longer needed).
4. Pass `billingCycle` in subscription metadata so webhook processing
   can record it.

New helper:

```ts
function getPriceIdForPlanAndCycle(plan: OrganizationPlan, billingCycle: BillingCycle): string {
  // Returns the correct Stripe price ID from env vars
}
```

### Step 5: Populate `billing_cycle` in purchase records from Stripe data

**File**: `src/lib/organizations/organization-seats.ts` —
`handleSubscriptionEventInternal()`

Extract the billing interval from the Stripe subscription's line item:

```ts
const interval = firstLineItem.price?.recurring?.interval; // 'month' | 'year'
const billingCycle: BillingCycle = interval === 'year' ? 'yearly' : 'monthly';
```

Pass this to the `organization_seats_purchases` insert. This makes the
existing `billing_cycle` column actually reflect reality.

### Step 6: Update the checkout dialog UI — add billing cycle toggle

**Files**:

- `src/components/organizations/UpgradeTrialDialog.tsx`
- `src/components/organizations/subscription/PlanCard.tsx`

Changes to `UpgradeTrialDialog`:

1. Add `billingCycle` state (`'monthly' | 'annual'`), default `'annual'`.
2. Add a toggle/switch above or between the plan cards (Monthly / Annual
   with a "Save 17%" badge on Annual).
3. Pass `billingCycle` to `subscriptionLink.mutateAsync()`.
4. Pass the cycle-appropriate `pricePerMonth` to `PlanCard`:
   - Monthly: $18 (Teams), $72 (Enterprise)
   - Annual: $15 (Teams), $60 (Enterprise)

Changes to `PlanCard`:

1. Accept `billingCycle` prop.
2. Change the "Billed annually" label (line 68) to be dynamic:
   - For annual: "Billed annually ($180/yr)" / "($720/yr)"
   - For monthly: "Billed monthly"

### Step 7: Update the subscription overview to show billing cycle correctly

**File**: `src/components/organizations/subscription/SubscriptionOverviewCard.tsx`

The overview card already displays `formatBillingInterval()` from the Stripe
subscription's `price.recurring.interval` — this should work for both
monthly and annual subscriptions without changes. Verify it renders correctly
for monthly subscriptions.

### Step 8: Implement billing cycle change endpoint

This implements spec section "Billing Cycle Changes" (rules 1-5). Use the
KiloPass `scheduleChange` pattern as reference.

**New file or extend existing**:
`src/routers/organizations/organization-subscription-router.ts` — add
`changeBillingCycle` mutation.

Logic:

1. Validate: owner or billing manager only.
2. Retrieve current subscription from Stripe.
3. Determine current cycle from `price.recurring.interval`.
4. Reject if requested cycle matches current cycle.
5. Create a Stripe subscription schedule from the existing subscription
   (`subscriptionSchedules.create({ from_subscription })`).
6. Update the schedule with two phases:
   - Phase 1: Current price, from current phase start to current period end.
   - Phase 2: New cycle's price, starting at current period end,
     `proration_behavior: 'none'`, `billing_cycle_anchor: 'phase_start'`.
7. Set `end_behavior: 'release'` so the subscription continues normally
   after the transition.

Also add `cancelBillingCycleChange` mutation to release the schedule.

**Supporting changes**:

- Add a helper `getPriceIdForPlanAndCycle()` (shared with checkout).
- The `subscription_schedule.updated` webhook handler in `stripe.ts`
  already exists for KiloPass — we need to add org-seat schedule handling
  there, or ensure the schedule metadata routes correctly.
- Add metadata to the schedule phases so webhook processing can distinguish
  org-seat schedules from KiloPass schedules.

**DB tracking**: We have two options:

- **(a)** Add a `stripe_schedule_id` column to `organizations` or a new
  `organization_scheduled_changes` table (like KiloPass's
  `kilo_pass_scheduled_changes`).
- **(b)** Query Stripe directly for an active schedule on the subscription.

**Recommendation**: Option (b) is simpler for the initial implementation.
The subscription object from Stripe includes `schedule` when one is active.
For the UI, we can check `subscription.schedule` to show a "pending cycle
change" indicator. If we need DB tracking for audit/reliability, we can add
it later.

### Step 9: Update frontend for billing cycle changes

**File**: `src/components/organizations/subscription/SubscriptionOverviewCard.tsx`
(or a new `BillingCycleChangeButton` component)

Add a "Switch to Monthly/Annual" action in the subscription management UI:

1. Show the action only for owners/billing managers.
2. If a schedule is active on the subscription, show "Pending: switching to
   {cycle} at next renewal" with a "Cancel" button.
3. On click, call the `changeBillingCycle` mutation.

### Step 10: Update email notifications

**File**: `src/lib/organizations/organization-seats.ts`

The spec says renewal emails fire monthly for monthly subs and yearly for
annual subs. The current logic already sends renewal emails at the start of
each new billing period (detected by `purchaseRows.length === 1` for the
latest `starts_at`). Since monthly subscriptions will naturally have
`starts_at` change every month, this should work correctly without changes.

Verify in tests that renewal emails fire at each monthly period boundary.

### Step 11: Tests

Add/update tests in these files:

1. **`src/lib/organizations/organization-subscription-event.test.ts`**:
   - Test that `billing_cycle` is correctly set to `'monthly'` when
     `price.recurring.interval === 'month'` and `'yearly'` when
     `interval === 'year'`.
   - Test monthly subscription renewal creates new purchase record with
     correct amounts.

2. **`src/routers/organizations/organization-subscription-router.test.ts`**:
   - Test that `getSubscriptionStripeUrl` accepts and validates
     `billingCycle` parameter.
   - Test that `changeBillingCycle` endpoint works (may need Stripe
     mocking or test-mode API).

3. **`src/lib/organizations/organization-seats.test.ts`**:
   - Verify seat usage counting is cycle-agnostic (it should be).

4. **Component tests** (if any exist) for the UpgradeTrialDialog to verify
   cycle toggle renders and passes correct values.

### Step 12: Update the `handleUpdateSeatCount` for monthly subs

**File**: `src/lib/stripe.ts`

The current seat modification logic is cycle-agnostic — it uses
`proration_behavior: 'always_invoice'` for increases and `'none'` for
decreases. Per the spec (rule 224.4): "the decrease takes effect at the end
of the billing cycle. This applies to both monthly and yearly billing
cycles." The current implementation already does this correctly. No changes
needed.

## File Change Summary

| File                                                                     | Change Type | Description                                                                                               |
| ------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------- |
| `src/lib/organizations/constants.ts`                                     | Modify      | Add monthly-specific pricing constants                                                                    |
| `src/lib/config.server.ts`                                               | Modify      | Add 4 new Stripe price ID env vars                                                                        |
| `src/lib/stripe.ts`                                                      | Modify      | Checkout uses explicit price IDs; add `getPriceIdForPlanAndCycle` helper; remove `products.retrieve` call |
| `src/lib/organizations/organization-seats.ts`                            | Modify      | Extract and store `billing_cycle` from Stripe interval                                                    |
| `src/lib/organizations/organization-types.ts`                            | Modify      | Add `BillingCycle` type if not reusing DB type                                                            |
| `src/routers/organizations/organization-subscription-router.ts`          | Modify      | Add `billingCycle` to checkout input; add `changeBillingCycle` and `cancelBillingCycleChange` mutations   |
| `src/components/organizations/UpgradeTrialDialog.tsx`                    | Modify      | Add billing cycle toggle, dynamic pricing                                                                 |
| `src/components/organizations/subscription/PlanCard.tsx`                 | Modify      | Accept `billingCycle` prop, dynamic label                                                                 |
| `src/components/organizations/subscription/SubscriptionOverviewCard.tsx` | Modify      | Show pending cycle change indicator                                                                       |
| `.env.test` / `.env.example`                                             | Modify      | Add new price ID env vars                                                                                 |
| Test files (3-4 files)                                                   | Modify      | Add billing cycle test cases                                                                              |

## Risks and Edge Cases

1. **Existing annual subscribers**: No impact. Their Stripe subscriptions
   use annual prices. The `billing_cycle` column in purchase records will
   remain `'monthly'` (wrong) for historical rows. New webhook events will
   populate it correctly going forward. A backfill migration could fix
   historical data but is not critical.

2. **Mid-cycle change + seat change race**: If an org has a pending billing
   cycle change (schedule) and also tries to change seats, the seat change
   modifies the underlying subscription which may conflict with the schedule.
   Stripe handles this by updating the schedule's first phase. We should
   test this scenario.

3. **Cancellation during pending cycle change**: If the org cancels while a
   cycle change is scheduled, we should release the schedule first. The
   cancel handler should check for and release active schedules.

4. **Promotion codes / discounts**: The checkout already supports
   `allow_promotion_codes: true`. Monthly prices may have different
   promotion code eligibility in Stripe. This is a Stripe configuration
   concern, not a code concern.

## Out of Scope

- Backfilling `billing_cycle` on historical purchase records.
- Net amount recording (spec "Not Yet Implemented" item 1).
- Preventing re-addition of removed users on webhook (spec "Not Yet
  Implemented" item 2).

## Open Questions

1. **Price IDs**: Do the monthly Stripe prices already exist, or do they
   need to be created? This determines whether we can test immediately.
2. **Annual price IDs**: Should we extract the annual price IDs from
   Stripe's product `default_price` at deploy time, or add them as
   explicit env vars now? (Recommendation: explicit env vars for
   consistency.)
3. **Billing cycle change UI placement**: Should it be in the subscription
   overview card, or in a separate settings area? (Recommendation:
   inline in the overview card, matching the existing action button
   pattern.)
