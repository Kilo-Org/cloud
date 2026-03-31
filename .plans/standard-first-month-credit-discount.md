# Standard Plan First-Month Discount for Credit Enrollment

## Goal

Add the $4 first-month discounted price for the standard plan when purchasing with credits, matching the existing Stripe checkout behavior. This satisfies Plans rule 6: "The user-visible price for each plan MUST be identical regardless of payment source."

## Eligibility Logic

Same as Stripe checkout (`kiloclaw-router.ts:1488`):

- **Eligible** (gets $4): No prior paid subscription. A trialing or canceled-trial subscription does NOT count as paid.
- **Not eligible** (gets $9): User has a canceled subscription where `plan !== 'trial'` (i.e., they previously had a paid standard or commit subscription).

## Changes

### 1. Spec Update: `.specs/kiloclaw-billing.md`

Add a new Credit Enrollment rule (or amend rule 3) to codify the first-month discount:

- Credit Enrollment rule 3 currently says "9,000,000 microdollars for the standard plan". Update to: "4,000,000 microdollars for first-time standard plan enrollment or 9,000,000 microdollars for returning standard plan enrollment". Define "first-time" as: no prior non-trial subscription exists for the user.
- Add a new rule (e.g., rule 3a): "When enrolling in the standard plan via credits, the system MUST apply the first-month discounted price (4,000,000 microdollars) when the user has no prior paid subscription. A canceled trial subscription MUST NOT count as a prior paid subscription. This mirrors the first-month discount applied during Stripe checkout (Subscription Checkout rule 5)."

### 2. Constants: `src/app/(app)/claw/components/billing/billing-types.ts`

Add a constant for the first-month microdollar cost (matching `STANDARD_FIRST_MONTH_DOLLARS`):

```typescript
export const STANDARD_FIRST_MONTH_MICRODOLLARS = STANDARD_FIRST_MONTH_DOLLARS * 1_000_000; // 4_000_000
```

### 3. Server Constants: `src/lib/kiloclaw/credit-billing.ts`

Add the first-month cost constant alongside `KILOCLAW_PLAN_COST_MICRODOLLARS`:

```typescript
export const KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS = 4_000_000; // $4
```

### 4. Core Logic: `src/lib/kiloclaw/credit-billing.ts` — `enrollWithCredits()`

**Add a `hadPaidSubscription` parameter** to the function signature:

```typescript
export async function enrollWithCredits(params: {
  userId: string;
  instanceId: string;
  plan: 'commit' | 'standard';
  hadPaidSubscription: boolean; // new
}): Promise<void> {
```

**Compute the effective cost** at the top of the function:

```typescript
const fullCost = KILOCLAW_PLAN_COST_MICRODOLLARS[plan];
const costMicrodollars =
  plan === 'standard' && !hadPaidSubscription
    ? KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS
    : fullCost;
```

All downstream logic (balance check, deduction, credit spend increment) already uses `costMicrodollars`, so this change propagates automatically.

### 5. Router: `src/routers/kiloclaw-router.ts` — `enrollWithCredits` handler (lines 1516-1548)

Before calling `enrollWithCreditsImpl`, query the existing subscription to determine intro eligibility:

```typescript
const [existing] = await db
  .select({
    status: kiloclaw_subscriptions.status,
    plan: kiloclaw_subscriptions.plan,
  })
  .from(kiloclaw_subscriptions)
  .where(eq(kiloclaw_subscriptions.instance_id, instance.id))
  .limit(1);

const hadPaidSubscription = existing?.status === 'canceled' && existing.plan !== 'trial';

await enrollWithCreditsImpl({
  userId: ctx.user.id,
  instanceId: instance.id,
  plan: input.plan,
  hadPaidSubscription,
});
```

### 6. Billing Status: `src/routers/kiloclaw-router.ts` — `getBillingStatus` handler

Add a field to the billing status response so the frontend knows whether the user qualifies for the first-month credit discount. Add to the response (alongside `creditBalanceMicrodollars`):

```typescript
creditIntroEligible: boolean; // true when user would get the $4 first-month discount on standard credit enrollment
```

Compute it using the same logic:

```typescript
const creditIntroEligible = !sub || sub.plan === 'trial' || sub.status === 'trialing';
```

This is true when:

- No subscription exists
- Subscription is a trial (trialing or canceled trial)

This is false when a paid subscription exists (even if canceled).

### 7. Type Update: `src/app/(app)/claw/components/billing/billing-types.ts`

Add `creditIntroEligible: boolean` to the `ClawBillingStatus` type.

### 8. UI: `CreditEnrollmentSection` in `PlanSelectionDialog.tsx` (lines 317-387)

Update to use the first-month cost when eligible:

- Accept `creditIntroEligible` as a prop
- When `selectedPlan === 'standard'` and `creditIntroEligible`:
  - Use `STANDARD_FIRST_MONTH_MICRODOLLARS` (4,000,000) instead of `PLAN_COST_MICRODOLLARS.standard` (9,000,000) for balance check and display
  - Show something like "Standard Plan — $4.00 first month, then $9.00/month"
  - Button: "Pay $4.00 with Credits"
- When not eligible, show the full $9 as today

### 9. UI: `CreditEnrollmentBanner` in `WelcomePage.tsx` (lines 310-380)

Same changes as `CreditEnrollmentSection` — accept `creditIntroEligible` and adjust cost/display accordingly.

### 10. UI: Pass `creditIntroEligible` from parent to credit enrollment components

In both `PlanSelectionDialog.tsx` and `WelcomePage.tsx`, extract `creditIntroEligible` from the billing status query and pass it to the credit enrollment components:

```typescript
const creditIntroEligible = billing?.creditIntroEligible ?? false;
```

### 11. Tests: `src/routers/kiloclaw-billing-router.test.ts`

Add and update tests:

1. **New test**: "enrolls with credits for standard plan at intro price ($4) for first-time subscriber"
   - User has no prior subscription (or only a trial)
   - Verify deduction is `-4_000_000`, not `-9_000_000`
   - Verify `microdollars_used` increments by `4_000_000`

2. **New test**: "enrolls with credits for standard plan at full price ($9) for returning subscriber"
   - User has a canceled paid subscription
   - Verify deduction is `-9_000_000`

3. **Update existing test** (line 1909): "enrolls with credits for standard plan when balance sufficient"
   - This test creates a trialing subscription first, so the user qualifies for intro price
   - Update expected deduction from `-9_000_000` to `-4_000_000`
   - Update expected `microdollars_used` from `9_000_000` to `4_000_000`

4. **New test**: "rejects enrollment when balance insufficient for intro price"
   - User has $3 (sufficient for nothing, insufficient for $4 intro)

5. **Update existing test** (line 1993): "rejects enrollment when balance is insufficient"
   - This tests commit plan ($48), no change needed

6. **New test**: "allows enrollment with balance between intro and full price"
   - User has $5 (enough for $4 intro, not enough for $9)
   - First-time subscriber → should succeed with $4 deduction

7. **Update test** (line 2180): `renewalCostMicrodollars` should remain `9_000_000` (renewals are always full price, no change needed)

8. **New test**: "billing status reports creditIntroEligible=true for new user"

9. **New test**: "billing status reports creditIntroEligible=false for returning subscriber"

## Files Changed (Summary)

| File                                                            | Change                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.specs/kiloclaw-billing.md`                                    | Add credit enrollment intro pricing rule                                                                                 |
| `src/app/(app)/claw/components/billing/billing-types.ts`        | Add `STANDARD_FIRST_MONTH_MICRODOLLARS` constant, add `creditIntroEligible` to type                                      |
| `src/lib/kiloclaw/credit-billing.ts`                            | Add `KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS`, add `hadPaidSubscription` param to `enrollWithCredits`, use intro cost |
| `src/routers/kiloclaw-router.ts`                                | Query existing sub for intro eligibility in `enrollWithCredits` handler; add `creditIntroEligible` to billing status     |
| `src/app/(app)/claw/components/billing/PlanSelectionDialog.tsx` | Update `CreditEnrollmentSection` to show intro price when eligible                                                       |
| `src/app/(app)/claw/components/billing/WelcomePage.tsx`         | Update `CreditEnrollmentBanner` to show intro price when eligible                                                        |
| `src/routers/kiloclaw-billing-router.test.ts`                   | Add/update tests for intro pricing                                                                                       |

## Files NOT Changed

| File                                          | Why                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/lib/kiloclaw/billing-lifecycle-cron.ts`  | Renewals always use full price — no intro discount on renewals                            |
| `src/lib/kiloclaw/stripe-handlers.ts`         | Stripe intro price logic unchanged                                                        |
| `src/lib/kiloclaw/stripe-price-ids.server.ts` | No new Stripe prices needed                                                               |
| `KiloPassAwardingCreditsClient.tsx`           | Auto-enrollment callback calls same `enrollWithCredits` mutation — benefits automatically |

## Verification

- `pnpm typecheck` — verify no type errors
- `pnpm test src/routers/kiloclaw-billing-router.test.ts` — verify all billing tests pass
- Manual: verify UI shows $4 for first-time standard credit enrollment and $9 for returning subscribers
