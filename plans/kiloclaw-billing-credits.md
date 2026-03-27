# KiloClaw Credits-First Billing

## Vision

Every KiloClaw instance is funded by credits. A KiloClaw subscription is
a recurring credit deduction tied to a specific instance. Credits reach
the user's balance through one of three funding sources:

| Funding source          | Mechanism                                              | Kilo Pass bonuses?              |
| ----------------------- | ------------------------------------------------------ | ------------------------------- |
| **Kilo Pass** (primary) | Kilo Pass subscription adds credits via Stripe         | Yes                             |
| **Standalone hosting**  | Stripe subscription ($9/mo or $48/6mo), routed through | Only if user also has Kilo Pass |
|                         | credits internally (deposit + deduct, balance neutral) |                                 |
| **Manual top-up**       | User buys credits ad hoc                               | Only if user also has Kilo Pass |

The KiloClaw subscription itself does not know or care where credits
came from. It deducts from the balance on each renewal.

Kilo Pass is front and center as the recommended way to activate
KiloClaw. Standalone Stripe hosting plans persist long-term for users
who only want hosting with free inference models.

## Decisions

These were confirmed in conversations with Igor (engineering) and
Emilie (product):

1. **Kilo Pass is the North Star.** It is the primary metric presented
   to investors. Everything that drives Kilo Pass adoption is a
   worthwhile investment.

2. **KiloClaw hosting spend counts toward Kilo Pass bonuses.** Spending
   credits on hosting depletes paid credits, which helps unlock bonus
   credits faster. This applies even to Stripe-funded hosting payments
   (routed through the credit ledger).

3. **Kilo Pass is pushed as the means to activate KiloClaw.** There is
   a marketer (Yobe) whose job is to sell Kilo Pass as a path to
   KiloClaw. The checkout flow should lead with Kilo Pass tiers.

4. **Refunds and promos are handled via credit grants.** Stripe refunds
   remain possible but are rare (TOS says no refunds).

5. **Seats are separate from credits.** Seats (annual contracts) are an
   entitlement layer. Credits are the funding mechanism for platform
   activity.

6. **Multiple instances per user.** Each instance carries its own
   subscription and renewal cycle. No volume discounts for now.

7. **Commit plan available with Kilo Pass** if the user will have
   enough credits: existing balance >= $48, or Kilo Pass tier provides
   enough (Pro $49/mo, Expert $199/mo), or annual plan.

8. **Auto-activate hosting after Kilo Pass checkout** when purchased
   from the KiloClaw onboarding flow. No separate activation step.

9. **User-prompted conversion** when a standalone Stripe hosting user
   subscribes to Kilo Pass. Show a prompt offering to switch hosting
   to credit-funded. Not automatic.

10. **Standalone Stripe path persists long-term.** Both funding paths
    must be maintained.

11. **Design per-instance now.** The subscription model should reference
    instances, even though we only support one instance per user today.

## User Journeys

### Trial ends, user chooses Kilo Pass

1. Trial expires, plan selection shown with Kilo Pass recommended
2. User picks a Kilo Pass tier + hosting plan (Standard or Commit)
3. Kilo Pass Stripe checkout completes, credits land in balance
4. Hosting auto-activates: first period deducted from credits
5. Monthly: Kilo Pass adds credits, hosting deducts, remainder
   available for inference, bonus credits unlock as paid credits
   are used

### Trial ends, user chooses hosting only

1. Trial expires, user picks Standard $9/mo or Commit $48/6mo
2. Stripe checkout completes
3. On each paid invoice: credits deposited + deducted (balance neutral)
4. User gets hosting, uses free inference models, no bonus credits

### Existing Kilo Pass user provisions a new instance

1. User already has Kilo Pass with credits in balance
2. Provisions instance, selects hosting plan
3. Balance check passes, credits deducted, instance starts

### Standalone user later subscribes to Kilo Pass

1. User has $9/mo Stripe hosting subscription
2. Subscribes to Kilo Pass
3. Prompted: "Switch hosting to credit-funded?"
4. If yes: Stripe hosting subscription canceled at period end, next
   renewal comes from credit balance
5. User ends up with one Stripe subscription (Kilo Pass) instead of two

### User adds a second instance (future)

1. User has one active instance with hosting subscription
2. Provisions second instance, selects hosting plan
3. Second subscription created, tied to new instance
4. Two independent credit deductions from the same balance

## Spec Changes Needed

The billing spec at `.specs/kiloclaw-billing.md` needs these updates
beyond what was added in the 2026-03-20 hybrid billing revision:

### Per-instance subscriptions

- Plans rule 5 ("at most one subscription record per user") changes to
  "at most one subscription record per instance."
- The subscription table gains an `instance_id` foreign key to
  `kiloclaw_instances`.
- Idempotency keys for credit deductions include the instance ID.
- Billing status reporting returns subscription data per instance.

### Kilo Pass upsell checkout

- New section: when a user activates KiloClaw hosting from the
  onboarding flow and chooses Kilo Pass, the system creates a Kilo Pass
  Stripe checkout. On successful checkout, the system auto-enrolls
  hosting via credits (pure credit enrollment) without requiring a
  separate user action.
- The auto-enrollment uses the same `enrollWithCredits` path as
  direct credit enrollment, with the same balance check, idempotency,
  and transaction guarantees.

### Commit plan eligibility

- Credit Enrollment rule 3 (effective balance check) expands: the
  system MUST also consider the credit amount the user will receive
  from a concurrent Kilo Pass purchase when the enrollment is triggered
  by a Kilo Pass checkout flow. For standalone credit enrollment, the
  existing balance check is unchanged.

### Standalone-to-credit conversion

- New section: when a user with a standalone Stripe hosting subscription
  subscribes to Kilo Pass, the system SHOULD prompt the user to switch
  hosting to credit-funded. If accepted, the system sets
  cancel-at-period-end on the Stripe hosting subscription. At next
  renewal, the credit sweep handles hosting renewal from the
  credit balance (pure credit path).

## Implementation Plan

### Phase 1: Schema and foundation

**Goal:** Prepare the subscription model for per-instance design and
fix stale artifacts.

1. **Add `instance_id` to `kiloclaw_subscriptions`.**
   Nullable FK to `kiloclaw_instances.id`. Add a unique partial index
   on `instance_id WHERE instance_id IS NOT NULL`. Keep the existing
   `user_id` unique constraint (enforces single instance for now).
   When multi-instance ships, drop the `user_id` unique constraint
   and make `instance_id` NOT NULL.

2. **Backfill `instance_id` on existing rows.** For each subscription,
   set `instance_id` to the user's active (non-destroyed) instance.
   Run as a migration.

3. **Set `instance_id` on new subscriptions.** Update
   `enrollWithCredits`, `handleKiloClawSubscriptionCreated`, and trial
   creation to set `instance_id` when inserting or upserting.

4. **Fix stale code artifacts.**
   - `stripe-handlers.ts` line 271: change "monthly renewal" to
     "renewal" (commit is 6-month).
   - `credit-billing.ts` line 48: change "$54/6mo" to "$48/6mo".
   - `kiloclaw-billing-router.test.ts` line 176: fix commit plan
     fixture period length or add clarifying comment.

### Phase 2: Hybrid model guards

**Goal:** Prepare all existing webhook handlers and router endpoints
for hybrid rows. These are safe no-ops before any hybrid rows exist.

5. **Guard `handleKiloClawSubscriptionCreated`.**
   (`stripe-handlers.ts` lines 166-202)
   Use SQL CASE expressions in the upsert's `onConflictDoUpdate.set`
   to preserve `payment_source`, `plan`, period fields,
   `credit_renewal_at`, and `commit_ends_at` when the existing row
   has `payment_source = 'credits'`. Still update
   `stripe_subscription_id` and cancel intent.

6. **Guard `handleKiloClawSubscriptionUpdated` for hybrid rows.**
   (`stripe-handlers.ts` lines 222-318)
   Pre-read the row. For hybrid rows (payment_source='credits' with
   non-null stripe_subscription_id), only sync cancel intent and
   non-active dunning states. Do not sync plan, period fields,
   payment_source, or trigger auto-resume.

7. **Router branching on `stripe_subscription_id`.**
   (`kiloclaw-router.ts`)
   Change cancel, reactivate, switchPlan, cancelPlanSwitch, and
   createBillingPortalSession to branch on
   `stripe_subscription_id` presence instead of `payment_source`.

8. **Exclude hybrid rows from credit renewal sweep.**
   (`credit-billing.ts` lines 329-360)
   Add `isNull(stripe_subscription_id)` to the WHERE clause. Do NOT
   add this filter to the interrupted auto-resume retry in
   `billing-lifecycle-cron.ts`.

### Phase 3: Credit settlement path

**Goal:** Enable Stripe payments to be recorded in the credit ledger.

9. **Add `applyStripeFundedKiloClawPeriod` helper.**
   (`credit-billing.ts`)
   In one DB transaction: call `processTopUp` for the credit deposit,
   insert a matching negative credit transaction, decrement balance,
   upsert the subscription row with `payment_source='credits'`,
   advance the billing period from invoice-derived boundaries.
   Post-transaction: auto-resume if suspended, evaluate Kilo Pass
   bonus. See existing plan document for detailed field-by-field
   specification.

10. **Add KiloClaw `invoice.paid` webhook handler.**
    (`stripe.ts` / `stripe-handlers.ts`)
    Identify KiloClaw invoices by price ID. Extract charge ID,
    subscription ID, plan, and period boundaries from the invoice
    line item. Call `applyStripeFundedKiloClawPeriod`. Null-safe
    field extraction throughout — no `!` assertions, no bare
    `[0]` indexing.

11. **Align schedule-event behavior with hybrid ownership.**
    (`stripe-handlers.ts` lines 371-439)
    For hybrid rows, schedule terminal events clear tracking fields
    but do not mutate plan or commit_ends_at. Plan mutation is owned
    by invoice settlement. Update stale comments in
    `handleKiloClawScheduleEvent` and `switchPlan`.

### Phase 4: Credit enrollment frontend

**Goal:** Wire the existing `enrollWithCredits` backend to the
frontend so users can pay for hosting from their credit balance.

12. **Add credit enrollment option to plan selection UI.**
    (`PlanSelectionDialog.tsx`, `WelcomePage.tsx`)
    When the user has a credit balance, show a "Pay with credits"
    option alongside the Stripe checkout button. Display current
    balance and cost. If balance is insufficient, show the shortfall
    and link to credit top-up.

13. **Update `enrollWithCredits` to set `instance_id`.**
    Pass the target instance ID through from the frontend. The
    enrollment transaction sets `instance_id` on the subscription row.

### Phase 5: Kilo Pass upsell and auto-activation

**Goal:** Make Kilo Pass the primary checkout path for KiloClaw, with
seamless auto-activation of hosting after purchase.

14. **Add Kilo Pass plan cards to KiloClaw checkout flow.**
    (`PlanSelectionDialog.tsx`, `WelcomePage.tsx`, `AccessLockedDialog.tsx`)
    Show Kilo Pass tiers (Starter $19, Pro $49, Expert $199) as the
    recommended option above the standalone hosting plans. Highlight
    the value: "Covers hosting + inference with bonus credits."

15. **Kilo Pass checkout with callback.**
    When a user selects a Kilo Pass tier from the KiloClaw flow,
    redirect to Kilo Pass checkout with a callback parameter
    indicating KiloClaw auto-activation is pending (including the
    selected hosting plan and instance ID).

16. **Auto-activate hosting after Kilo Pass checkout.**
    On the Kilo Pass checkout success callback, if the KiloClaw
    activation parameter is present: poll until the Kilo Pass
    `invoice.paid` webhook has processed and credits have landed in
    the user's balance (similar to how `KiloClawCheckoutSuccessClient`
    polls for subscription status today). Once the balance is
    sufficient, call `enrollWithCredits` for the selected hosting plan
    and instance. The user lands on the KiloClaw dashboard with hosting
    active — no extra clicks. The polling handles the race between
    the browser redirect and the Stripe webhook.

17. **Commit plan eligibility with Kilo Pass.**
    In the plan selection UI, enable the Commit option when the user
    is selecting a Kilo Pass tier that provides enough credits
    (Pro or Expert monthly, or any annual tier), even if their
    current balance is below $48. The balance check at enrollment
    time will pass because Kilo Pass credits will have landed by then.

### Phase 6: Billing status and frontend

**Goal:** Update billing status reporting and frontend to handle all
payment states and the conversion prompt.

18. **Add `hasStripeFunding` to billing status.**
    (`kiloclaw-router.ts` lines 1110-1132)
    `hasStripeFunding: !!sub.stripe_subscription_id`. The frontend
    uses this to decide whether to show the Stripe portal, credit
    top-up, or conversion prompt.

19. **Checkout success page.**
    (`KiloClawCheckoutSuccessClient.tsx`)
    For Stripe-funded subscriptions, wait for `payment_source` to
    flip to `'credits'` (indicating invoice settlement completed)
    before showing success. Prevents premature success display
    before the credit ledger entries exist.

20. **Standalone-to-credit conversion prompt.**
    When a user has both Kilo Pass and a standalone Stripe hosting
    subscription (`hasStripeFunding && hasKiloPass`), show a prompt:
    "Switch hosting to credit-funded?" If accepted, set
    cancel-at-period-end on the Stripe hosting subscription. The
    system transitions to pure credit at next renewal.

21. **Frontend UI for all payment states.**
    - Active subscription card: "Manage" button (Stripe portal) only
      when `hasStripeFunding`. Credit-funded shows renewal date and
      cost from credit balance.
    - Past-due card: Stripe-funded → "Update payment method";
      credit-funded → "Add credits" / "Top up balance".
    - Access locked dialog: branch messaging on `hasStripeFunding`.

### Phase 7: Tests

22. **Settlement tests** — standard discounted first invoice ($5),
    full-price renewal ($9), commit 6-month renewal ($48), legacy
    Stripe to hybrid conversion, idempotency, past-due recovery,
    suspended recovery, hybrid plan-switch application.

23. **Webhook guard tests** — subscription.created after invoice.paid
    does not revert payment_source; hybrid subscription.updated
    propagates only dunning states; non-hybrid behavior unchanged.

24. **Sweep exclusion tests** — hybrid row not selected by sweep, does
    not trigger auto-top-up, does not get marked past_due.

25. **Credit enrollment tests** — enrollWithCredits sets instance_id,
    balance check with Kilo Pass bonus projection, commit plan
    eligibility.

26. **Router mutation tests** — hybrid cancel/reactivate/switch/portal
    all route through Stripe; pure credit equivalents are local-only.

27. **Auto-activation tests** — Kilo Pass checkout callback triggers
    enrollWithCredits, hosting is active after callback completes.

28. **Regression tests** — pure credit enrollment unchanged, pure
    credit renewal sweep unchanged, Kilo Pass invoice.paid handling
    unchanged, generic top-up flow unchanged.

## Implementation Order and Dependencies

```
Phase 1 (schema)
  └─> Phase 2 (hybrid guards) ──> Phase 3 (settlement path)
        │                              │
        └─> Phase 4 (credit enrollment frontend)
                                       │
                              Phase 5 (Kilo Pass upsell)
                                       │
                              Phase 6 (billing status + frontend)
                                       │
                              Phase 7 (tests throughout)
```

- Phases 1-2 are safe no-ops: no hybrid rows exist yet, schema change
  is additive, guards always take the existing-behavior branch.
- Phase 3 creates hybrid rows. All guards from Phase 2 must be in place.
- Phase 4 can start after Phase 2 (credit enrollment already works on
  the backend, just needs frontend wiring).
- Phase 5 depends on Phase 4 (auto-activation uses enrollWithCredits).
- Phase 6 can proceed incrementally alongside Phases 4-5.
- Tests run throughout, with a full suite pass at the end.

## Existing Subscriber Migration

- **Hybrid conversion is lazy.** Existing Stripe subscribers convert to
  hybrid on their next paid invoice. No backfill, no flag day.
- **instance_id backfill** is a one-time migration for existing rows.
- **No user-facing migration.** Existing users see no change in behavior
  until they interact with the new UI (e.g., Kilo Pass upsell prompt).

## Permanent Complexity

These are accepted trade-offs:

- **Two renewal engines.** Pure credit rows renew in the local sweep;
  hybrid rows renew via invoice.paid. Both produce the same credit
  ledger entries. Future changes to renewal logic must be applied to
  both paths.
- **Hybrid webhook guards are permanent.** The SQL CASE in
  subscription.created and the pre-read in subscription.updated must
  remain for as long as hybrid rows exist.
- **Schedule ordering is eventually consistent.** Schedule events and
  settled invoices may arrive in either order.
- **Synthetic ledger entries are intentional.** Each Stripe-funded
  renewal creates one positive and one negative credit transaction.
  Any transaction history UI should label them accordingly.

## Auto Top-Up Interactions

The existing auto top-up system (`src/lib/autoTopUp.ts`) works correctly
with credit-funded KiloClaw subscriptions without modification:

- **Pure credit renewal, insufficient balance:**
  `triggerAutoTopUpForKiloClaw()` fires, sweep skips the row
  (fire-and-skip per Credit Renewal rule 11), next sweep run
  re-evaluates after the webhook has credited the balance.
- **Kilo Pass bonus pending:** `shouldWaitForKiloPassBonusCredits()`
  defers auto top-up, avoiding unnecessary charges when the user's
  monthly bonus hasn't landed yet.
- **Hybrid rows:** Excluded from the credit sweep entirely. Stripe's
  own dunning handles payment failure. Auto top-up is not involved.
- **Per-instance markers:** The `auto_top_up_triggered_for_period`
  column is per-subscription-row. With per-instance subscriptions,
  each instance has its own marker. No conflict between instances.
