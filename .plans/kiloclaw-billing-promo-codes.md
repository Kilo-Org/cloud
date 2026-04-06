# Rewardful Promo Codes for KiloClaw Checkout

## Goal

Enable Rewardful affiliate promo code entry on Stripe-hosted checkout for both KiloClaw plans. Preserve the automated $4 first month for new Standard subscribers by encoding it as an intro Stripe Price rather than a coupon, avoiding the `discounts` / `allow_promotion_codes` mutual exclusivity.

## Background

Stripe Checkout's `discounts` parameter (used today for the Standard first-month coupon) and `allow_promotion_codes` are mutually exclusive on a session. The intro-price approach eliminates the coupon entirely, freeing `allow_promotion_codes` for Rewardful promo codes on all checkouts.

No DB schema migration is needed — `scheduled_by = 'auto'` already exists in `packages/db/src/schema-types.ts:133`.

## Step 1: Stripe Configuration (Manual, Pre-Deploy)

- Create a new Stripe Price on the Standard product: **$4/month**, recurring monthly. This is the **intro price**.
- Set the new price ID in env var `STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID`.
- Existing `STRIPE_KILOCLAW_STANDARD_PRICE_ID` remains as the regular $9/month price.
- Configure Rewardful campaign promotion codes to be valid on all KiloClaw price IDs (intro, regular, commit).
- **Promo discount duration**: Verify that all Rewardful promo codes are configured in Stripe as **one-time** (or first-invoice-only) discounts, not recurring. The auto intro→standard schedule rewrite (Step 4) and `switchPlan` schedule rewrite (Step 7) specify only `items: [{ price: ... }]` and timing fields in phase definitions — any active `discounts` on the subscription are not carried into the rewritten phases. If recurring promo discounts are needed in the future, Steps 4 and 7 must be updated to read and forward `discounts` from the current phase into both phases of the rewritten schedule.
- `STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID` can be removed from environment after deploy.

## Step 2: Config & Price ID Module

### `src/lib/config.server.ts`

- Add `STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID` export.
- Remove `STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID` export (line 186–188).

### `src/lib/kiloclaw/stripe-price-ids.server.ts`

- Add the intro price to `getPriceIdMetadata()` mapping it to `'standard'`. Both intro and regular prices resolve to `plan = 'standard'`. This means `detectPlanFromSubscription` in `stripe-handlers.ts:59` works without changes.
- Add a new export `getStripePriceIdForClawPlanIntro(plan)` that returns the intro price for `'standard'` and falls through to the regular price for `'commit'` (commit has no intro).
- Add a new export `isIntroPriceId(priceId: string): boolean` for use in reactivation/switch logic.

### `src/lib/kiloclaw/stripe-invoice-classifier.server.ts`

No code changes needed. `getKnownStripePriceIdsForKiloClaw()` already returns all keys from `getPriceIdMetadata()`, so the intro price is automatically included.

## Step 3: Checkout Flow — `src/routers/kiloclaw-router.ts`

In `createSubscriptionCheckout` (line 1152):

- Remove the `shouldApplyStandardPlanDiscount` / `standardPlanDiscount` / `discounts` logic (lines 1223–1238).
- Remove the import of the coupon config constant.
- Add `allow_promotion_codes: true` to the checkout session params for **both** plans.
- Price selection: for new Standard subscribers (`input.plan === 'standard'` and `existing?.status !== 'canceled'`), use the intro price via `getStripePriceIdForClawPlanIntro('standard')`. For returning canceled Standard subscribers and all Commit subscribers, use `getStripePriceIdForClawPlan(input.plan)` (regular price).

## Step 4: Shared Helper & Auto-Schedule Creation

### `ensureAutoIntroSchedule` helper — `src/lib/kiloclaw/stripe-handlers.ts`

Extract a shared idempotent helper that Steps 4, 6, and 8 all call. This helper encapsulates schedule creation, the idempotency guard, and partial-failure semantics in one place.

Signature: `ensureAutoIntroSchedule(stripeSubscriptionId: string, userId: string): Promise<void>`

Behavior:

1. **Live Stripe fetch** (single source of truth): Call `stripe.subscriptions.retrieve(stripeSubscriptionId)`. This is the authoritative check — all subsequent decisions derive from this response, including both the price gate and the schedule-existence check.
2. **Price gate**: Read `items.data[0].price.id` from the live fetch and check via `isIntroPriceId()`. If the subscription is **not** on the intro price, no-op and return. This prevents creating an intro-anchored schedule on a subscription that has already rolled to the regular price, even if the caller's earlier check (webhook payload, prior retrieve) said otherwise.
3. **Schedule already attached in Stripe**: If the live subscription's `.schedule` is non-null, the schedule already exists. Retrieve it via `subscriptionSchedules.retrieve` and check `metadata.origin`. If it equals `'auto-intro'`, persist the schedule ID with `scheduled_by: 'auto'`, `scheduled_plan: 'standard'` on the DB row (in case the DB is stale or was never written) and return. If the metadata does not match (e.g., it is a user-initiated switch schedule), **do not relabel it** — log a warning and return without persisting. This prevents a retried `subscription.created` or a race between `cancelPlanSwitch` and a concurrent `switchPlan` from converting a user schedule into an auto schedule, which would hide the "Cancel Switch" button (since `SubscriptionCard.tsx:35` checks `scheduledBy === 'user'`) and cause `cancelPlanSwitch` to reject the cancel.
4. **DB reconciliation**: Read the row's `stripe_schedule_id`. If it is set but Stripe says `.schedule` is null (stale local pointer — e.g., a prior cancel released the Stripe schedule but DB clear failed), clear the stale pointer before proceeding. Do **not** early-return based on the DB value alone.
5. **Create the 2-phase schedule**:
   - `subscriptionSchedules.create({ from_subscription: stripeSubscriptionId })`
   - Read the current phase from the newly created schedule. Use its existing price (as set by `from_subscription`) for phase 1 — do **not** hardcode the intro price ID. `from_subscription` mirrors the subscription's current state, so if the subscription is still on the intro price (confirmed by step 2), phase 1 will naturally use it. Copy `start_date` and `end_date` from the current phase.
   - Set phase 2 = regular Standard price, open-ended with `end_behavior: 'release'`.
   - **Schedule metadata**: Set `metadata: { origin: 'auto-intro' }` on the schedule at creation time. This tag is the authoritative marker for distinguishing auto schedules from user schedules — all classification logic (Steps 4, 7, 8) checks `metadata.origin === 'auto-intro'` instead of inferring origin from phase structure. Stripe subscription schedules support arbitrary metadata.
   - **Discount passthrough**: Phase definitions do not carry forward subscription-level discounts. This is safe because Rewardful promo codes are configured as one-time discounts (see Step 1). If this assumption changes, both phases must explicitly forward `discounts` from the current phase.
6. **Race guard**: If `subscriptionSchedules.create` throws because a schedule was attached between the fetch and the create call (narrow race), catch the error, live-fetch the subscription again, persist the existing schedule ID, and return.
7. **Persist** `stripe_schedule_id`, `scheduled_plan: 'standard'`, `scheduled_by: 'auto'` on the DB row.

The helper is idempotent: calling it multiple times for the same subscription produces the same result. The live Stripe fetch is the single source of truth — neither stale webhook payloads nor stale DB pointers can cause incorrect schedule creation.

### Failure modes

The helper can fail at two points with distinct consequences:

- **Before Stripe schedule creation** (steps 1–4): No Stripe-side state was created. The subscription remains on the intro price with no schedule. Callers can safely retry by re-invoking the helper.
- **After Stripe schedule creation but before DB persist** (between steps 5 and 7): A Stripe schedule exists but the DB has no `stripe_schedule_id` pointer. This is the **hidden-schedule state**. The helper handles this on re-invocation (step 3 persists the existing schedule ID). However, other router flows that key off the DB pointer (`cancelSubscription`, `switchPlan`) must also handle this state — see Steps 5 and 7.

### Webhook invocation — `src/lib/kiloclaw/stripe-handlers.ts`

In `handleKiloClawSubscriptionCreated` (line 140), after the upsert at line 223:

- **Stale-event guard**: The existing stale-subscription guard at line 181 `return`s from inside the transaction callback, not from the outer function — post-transaction work (like `autoResumeIfSuspended`) still executes. Follow the existing `wasSuspended` pattern: declare a `let didProcess = false` before the transaction, set `didProcess = true` after the upsert inside the transaction (but inside the non-stale branch), and gate the `ensureAutoIntroSchedule` call on `didProcess`. Without this, a retried/stale `subscription.created` carrying an old subscription ID would cause the helper to live-fetch and schedule against the wrong subscription, then persist that schedule ID to the user's current DB row.
- Call `ensureAutoIntroSchedule(subscription.id, kiloUserId)` only when `didProcess` is true. The helper performs its own live price check internally, so the caller does not need to pre-check the price. The stale webhook payload (`event.data.object`) is used only for the DB upsert; the helper fetches live state from Stripe.

Update the handler's doc comment (line 134) to reflect that it now creates auto intro→regular schedules, not just persisting subscription data.

## Step 5: Cancel Flow — `src/routers/kiloclaw-router.ts`

The current `cancelSubscription` (line 1264) releases any schedule when `sub.stripe_schedule_id` is set (line 1285), then sets `cancel_at_period_end`. This works for all cases where the DB pointer is accurate. However, after this change, the **hidden-schedule state** is possible (Stripe has an attached schedule but the DB pointer is null — see Step 4 failure modes).

Add a reconciliation step before the existing schedule-release logic: live-fetch the subscription (`stripe.subscriptions.retrieve`) and check `.schedule`. If Stripe has an attached schedule but `sub.stripe_schedule_id` is null, release the Stripe schedule before proceeding. Cancel always releases any attached schedule regardless of origin (auto or user), so no phase inspection is needed here — this is safe for both hidden auto schedules and hidden user schedules.

The existing defensive try/catch at lines 1285–1306 already handles already-released schedules, so the reconciliation only needs to fill in the missing schedule ID for the release call. The rest of the cancel flow (setting `cancel_at_period_end`, clearing DB fields) remains unchanged.

## Step 6: Reactivation Flow — `src/routers/kiloclaw-router.ts`

In `reactivateSubscription` (line 1328), after unsetting `cancel_at_period_end`:

- Call `ensureAutoIntroSchedule(sub.stripe_subscription_id, ctx.user.id)`. The helper performs its own live price check — if the subscription has already rolled to the regular price, it no-ops. No external price check needed.

### Partial-failure recovery

The primary operation — unsetting `cancel_at_period_end` in Stripe (line 1342) — has already succeeded before the schedule recreation attempt. If `ensureAutoIntroSchedule` throws, the mutation should **log the error but not throw to the caller**. The user's subscription is reactivated (correct), but left in one of two degraded states depending on where the helper failed (see Step 4 failure modes):

- **Before Stripe schedule creation**: intro price, no schedule anywhere. Re-invoking the helper repairs it. The billing lifecycle cron (Step 11) also detects and repairs this state on its next run, so the subscription does not stay stranded indefinitely. Emit a structured log/metric on suppressed failures so ops can monitor frequency.
- **After Stripe schedule creation but before DB persist**: Stripe has a live schedule but the DB has no pointer (hidden-schedule state). This state is self-healing — the Stripe schedule fires on its own, `subscription.updated` picks up the price change via `detectPlanFromSubscription`, and the `released` event clears tracking fields. The helper also repairs this on re-invocation (step 3 persists the existing schedule ID). Other flows (cancel, switchPlan) handle this via their own live-fetch reconciliation (Steps 5 and 7).

Both states are preferable to failing the entire reactivation.

## Step 7: Switch Plan Flow — `src/routers/kiloclaw-router.ts`

In `switchPlan` (line 1351):

- Remove the hard rejection at line 1373–1377 when `stripe_schedule_id` exists.
- Replace with: if `scheduled_by === 'user'`, keep the current rejection ("cancel it first"). If `scheduled_by === 'auto'`, attempt to update the existing auto schedule in place.

### Reconciliation for hidden schedules

Before branching on `scheduled_by`, live-fetch the subscription (`stripe.subscriptions.retrieve`) to detect the hidden-schedule state (Stripe has `.schedule` but DB has no `stripe_schedule_id`).

A hidden schedule can originate from either an auto intro→regular creation (Step 4) or a prior user-initiated switchPlan (line 1385–1421) where the DB persist failed after the Stripe schedule was created. These two cases require different handling — blindly rewriting an orphaned user schedule is unsafe because it could discard a user's intended plan switch. To distinguish them, retrieve the hidden schedule from Stripe (`subscriptionSchedules.retrieve`) and check `metadata.origin`:

- **Auto schedule** (`metadata.origin === 'auto-intro'`): Safe to update in place with the new target plan, same as the `scheduled_by === 'auto'` path below.
- **User schedule or no metadata**: Treat conservatively — release it first (with the defensive try/catch from `cancelSubscription:1285`), then fall through to fresh schedule creation. This is equivalent to the user having manually canceled their prior switch, which is the safest fallback when the intent is ambiguous.

This same live fetch also provides the actual current price ID from `items.data[0].price.id`, which is needed for phase 1 (see below). Do not use `getStripePriceIdForClawPlan(sub.plan)`, which is now ambiguous for Standard (could be intro or regular).

### Updating the auto schedule

Retrieve the schedule from Stripe to get the current phase. Phase 1 must remain byte-for-byte aligned with the current billing period — copy `start_date` and `end_date` from the existing current phase (same pattern as line 1405–1409 in the current user-switch code). Use the current phase's existing price for phase 1 (do not hardcode the intro price). Rewrite phase 2's price to the target plan's price (e.g., commit price). Set `end_behavior: 'release'`.

### Stale schedule handling

Wrap the schedule update in a try/catch mirroring the defensive pattern from `cancelSubscription` at lines 1285–1306. If the auto schedule is already released/canceled/completed (Stripe returns a 400 with "not active"), catch the error, clear the stale local pointer (`stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null`), then fall through to fresh schedule creation via `subscriptionSchedules.create({ from_subscription })`, using the live subscription's current price for phase 1.

After updating or creating the schedule, persist `stripe_schedule_id`, `scheduled_plan: input.toPlan`, `scheduled_by: 'user'`.

## Step 8: Cancel Plan Switch — `src/routers/kiloclaw-router.ts`

In `cancelPlanSwitch` (line 1427):

- Keep the existing check: `scheduled_by !== 'user'` → reject (line 1445). This correctly prevents users from canceling auto schedules directly.
- **Release the user's schedule**: Wrap the release call (line 1449) in a try/catch mirroring `cancelSubscription`'s defensive pattern at lines 1285–1306. If the schedule is already released/inactive, swallow the error and proceed to clear local state. If it's a genuine failure, throw.
- Clear the DB schedule fields (existing behavior at line 1450–1452).
- **Restore auto schedule if on intro price**: Call `ensureAutoIntroSchedule(sub.stripe_subscription_id, ctx.user.id)`. The helper performs its own live price check and schedule-existence check — if the subscription has already rolled to the regular price, it no-ops. No external price check needed.

### Partial-failure recovery

The primary operation — releasing the user's switch schedule — has already succeeded before the auto-schedule restoration attempt. If `ensureAutoIntroSchedule` throws, the mutation should **log the error but not throw to the caller**. The user's switch is canceled (correct), but the subscription is left in one of the two degraded states described in Step 6's partial-failure recovery. The same repair paths apply: the post-create (hidden-schedule) state is self-healing via the Stripe schedule firing on its own, and the pre-create state is repaired by the billing lifecycle cron (Step 11). Emit a structured log/metric on suppressed failures.

## Step 9: Frontend — `src/app/(app)/claw/components/billing/SubscriptionCard.tsx`

At line 98, the current condition `!sub.scheduledPlan` hides the switch button when any schedule exists, including auto. An internal auto schedule would therefore hide "Switch to Commit" unless this changes. Update the button rendering logic so that auto schedules are transparent to the user:

```tsx
{
  hasUserRequestedSwitch ? (
    <Button variant="outline" size="sm" onClick={handleCancelSwitch}>
      Cancel Switch
    </Button>
  ) : (
    <Button variant="outline" size="sm" onClick={handleSwitchPlan}>
      Switch to {otherPlan}
    </Button>
  );
}
```

Since `hasUserRequestedSwitch` is already `sub.scheduledBy === 'user'` (line 35), reaching the else branch means either no schedule or an auto schedule — both cases where the user should be able to initiate a switch.

## Step 10: Schedule Handler — `src/lib/kiloclaw/stripe-handlers.ts`

In `handleKiloClawScheduleEvent` (line 419):

- Update the doc comment to reflect auto intro→regular schedules (no longer "only created by user-initiated plan switches").
- No behavioral changes needed. The handler already processes `completed`/`released`/`canceled` generically. Auto intro→regular schedules use `end_behavior: 'release'`, so the natural transition fires as `released` (not `completed`), matching the existing behavior documented at line 454–460. On `released`, the handler clears the three schedule tracking fields. The actual plan update (intro → regular Standard) is handled by the `subscription.updated` webhook via `detectPlanFromSubscription` (line 59), which reads the new price from the live subscription. The `completed` branch at line 461 remains as a safety net but is not the primary path for `end_behavior: 'release'` schedules.

## Step 11: Reconciliation Sweep — `src/lib/kiloclaw/billing-lifecycle-cron.ts`

Add a new sweep to `runKiloClawBillingLifecycleCron` that repairs stranded intro-price subscriptions (the pre-create failure mode from Step 4).

**Query**: Find `kiloclaw_subscriptions` rows where:

- `status = 'active'`
- `stripe_schedule_id IS NULL`
- `stripe_subscription_id IS NOT NULL`
- `cancel_at_period_end = false`

For each matching row, call `stripe.subscriptions.retrieve` and check if `isIntroPriceId(items.data[0].price.id)`. If true and `.schedule` is null, call `ensureAutoIntroSchedule`. If false (already on regular price), no action needed — the subscription rolled over naturally or was never on the intro price.

**Frequency**: This runs on the existing cron cadence. The query is lightweight (indexed columns, small result set) and the Stripe calls are bounded by the number of stranded subscriptions (expected to be near zero under normal operation).

**Logging**: Log each repaired subscription as a structured event. Emit a count metric for alerting — a sustained non-zero count indicates a systemic issue with schedule creation in `handleKiloClawSubscriptionCreated`.

## Step 12: Cleanup

- Remove `STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID` from `src/lib/config.server.ts:186–188`.
- Remove the env var from `src/routers/kiloclaw-billing-router.test.ts:4–5`.
- Remove the import of the coupon config in `kiloclaw-router.ts`.

## Step 13: Tests — `src/routers/kiloclaw-billing-router.test.ts`

### Test harness updates (required before any new tests)

The existing test file's setup and mocks must be updated for the new exports, or tests will fail during module initialization.

**Env var setup** (top of file, line 1–6):

- Add `process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';`
- Remove `process.env.STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID ||= 'coupon_test_kiloclaw_standard_first_month';` (line 4–5).

**Jest mock for `@/lib/kiloclaw/stripe-price-ids.server`** (line 51–58):

- Add `getStripePriceIdForClawPlanIntro: jest.fn((plan: string) => plan === 'standard' ? 'price_standard_intro' : 'price_commit')` to the mock exports.
- Add `isIntroPriceId: jest.fn((priceId: string) => priceId === 'price_standard_intro')` to the mock exports.

**Stripe mock** (line 34–45):

- Add `subscriptions: { retrieve: jest.fn(), ... }` — the existing mock already has `retrieve` on `subscriptions` (line 38), so verify it is reset in `beforeEach` and returns a sensible default (e.g., `{ schedule: null, items: { data: [{ price: { id: 'price_standard' } }] } }`).
- Add `subscriptionSchedules: { retrieve: jest.fn(), ... }` — new code paths in `ensureAutoIntroSchedule` (step 3) and `switchPlan` (hidden-schedule reconciliation) call `subscriptionSchedules.retrieve` to read schedule metadata and phase data. The mock should return a sensible default (e.g., `{ id: 'sub_sched_test', metadata: {}, phases: [], end_behavior: 'release', status: 'active' }`) and be configurable per-test for auto-intro metadata (`{ metadata: { origin: 'auto-intro' } }`) and phase structures.

### Checkout tests (update existing at line 242)

- Standard first-time checkout uses the intro price and `allow_promotion_codes: true`; no `discounts`.
- Standard returning-canceled checkout uses the regular price and `allow_promotion_codes: true`.
- Commit checkout uses `allow_promotion_codes: true`; no `discounts`.
- Rewardful `client_reference_id` still passes through when the referral cookie exists.

### `ensureAutoIntroSchedule` helper tests (new)

- Creates a schedule and persists `scheduled_by: 'auto'`, `scheduled_plan: 'standard'` when no schedule exists and subscription is on the intro price.
- Price gate: if `subscriptions.retrieve` returns a non-intro price, no-ops without creating a schedule — even if the caller previously believed it was on the intro price.
- Idempotency (Stripe): if `subscriptions.retrieve` returns a non-null `.schedule`, persists the existing schedule ID without calling `subscriptionSchedules.create`.
- Stale DB pointer: if the DB row has `stripe_schedule_id` set but `subscriptions.retrieve` returns `.schedule: null`, clears the stale pointer and creates a new schedule.
- Race: if `subscriptionSchedules.create` fails because a schedule was attached concurrently, recovers by fetching and persisting the existing schedule.
- Phase 1 price is derived from the schedule created by `from_subscription`, not hardcoded to the intro price ID.

### Auto-schedule lifecycle tests (new)

- `handleKiloClawSubscriptionCreated` with an intro-price subscription calls `ensureAutoIntroSchedule` and persists the schedule.
- `handleKiloClawSubscriptionCreated` with a regular-price subscription (returning subscriber) does not call `ensureAutoIntroSchedule`.
- Schedule `released` event clears DB fields without surfacing a user-visible plan switch.

### Cancel / reactivate during intro month (new)

- Cancel releases the auto schedule, sets `cancel_at_period_end`, clears schedule fields.
- Reactivate during intro month recreates the auto schedule.
- Reactivate after intro month (regular price) does not recreate a schedule.
- Partial failure (pre-create): if `ensureAutoIntroSchedule` throws before Stripe schedule creation, the mutation still succeeds (cancel_at_period_end is unset), logs the error, and leaves no schedule anywhere.
- Partial failure (post-create): if `ensureAutoIntroSchedule` throws after Stripe schedule creation but before DB persist, the mutation still succeeds, logs the error, and leaves a hidden schedule that subsequent flows or re-invocation can reconcile.

### switchPlan during intro month (new)

- Switch from Standard (intro) to Commit updates the auto schedule in place, preserving phase 1 timing and price, sets `scheduled_by: 'user'`, `scheduled_plan: 'commit'`.
- Switch when auto schedule is stale/released: clears local pointer and falls through to fresh schedule creation.
- Switch when no schedule exists (regular price) creates a new user schedule (existing behavior preserved).
- Hidden auto schedule: DB has no `stripe_schedule_id` but Stripe has an attached schedule with `metadata.origin === 'auto-intro'`. switchPlan detects it via live fetch, identifies it as auto by metadata, and updates it in place.
- Hidden user schedule: DB has no `stripe_schedule_id` but Stripe has an attached schedule without auto-intro metadata. switchPlan detects it via live fetch, releases it conservatively, and creates a fresh schedule.

### Cancel / switchPlan with hidden schedule (new)

- Cancel when DB has no `stripe_schedule_id` but Stripe has an attached schedule (auto or user): live-fetch detects it, releases the hidden schedule, then proceeds with `cancel_at_period_end`.
- switchPlan with hidden auto schedule: detected via live fetch, identified by `metadata.origin === 'auto-intro'`, updated in place.
- switchPlan with hidden user schedule: detected via live fetch, no auto-intro metadata, released conservatively then fresh schedule created.

### cancelPlanSwitch during intro month (new)

- Cancel a user switch while on intro price restores the auto intro→regular schedule.
- Cancel a user switch while on regular price just clears fields (existing behavior).
- Cancel a user switch when the schedule is already released/inactive: swallows error, clears fields, still restores auto schedule if on intro price.
- Partial failure (pre-create): if `ensureAutoIntroSchedule` throws before Stripe schedule creation, the mutation still succeeds (user switch is canceled), logs the error, and leaves no schedule anywhere.
- Partial failure (post-create): if `ensureAutoIntroSchedule` throws after Stripe schedule creation but before DB persist, the mutation still succeeds, logs the error, and leaves a hidden schedule that subsequent flows or re-invocation can reconcile.

### Schedule metadata (new)

- `ensureAutoIntroSchedule` sets `metadata: { origin: 'auto-intro' }` on created schedules.
- Idempotency check uses `metadata.origin === 'auto-intro'` to identify auto schedules, not phase structure.
- switchPlan hidden-schedule reconciliation uses `metadata.origin` to classify hidden schedules.

### Reconciliation sweep (new)

- Cron sweep finds an active intro-price subscription with no schedule and calls `ensureAutoIntroSchedule`, repairing the stranded state.
- Cron sweep skips active subscriptions on the regular price (no repair needed).
- Cron sweep skips subscriptions that already have a `stripe_schedule_id`.
- Cron sweep skips canceled subscriptions and subscriptions with `cancel_at_period_end`.

### Invoice classification (new)

- Intro-price invoices are recognized as KiloClaw by `invoiceLooksLikeKiloClawByPriceId`.

## Assumptions

- Rollout lands after March 23, 2026 — no need to handle the `trial_end` launch-gating path.
- Rewardful promo codes apply only on initial KiloClaw checkout, not plan switches or billing-portal actions. Stripe promotion code restrictions (first-time orders, new customers only) enforce this.
- `allow_promotion_codes: true` enables a promo code input on Stripe's hosted checkout. No KiloClaw-side promo input needed.
- Existing Rewardful link-based attribution via `client_reference_id` continues unchanged. Rewardful's first-affiliate-wins attribution model means entering a different affiliate's promo code doesn't override prior link attribution.
- The auto-schedule creation pattern follows the same `subscriptionSchedules.create({ from_subscription })` → `subscriptionSchedules.update()` two-step as the existing `switchPlan` implementation.
- The price migration script (`src/scripts/d2026-03-19_migrate-kiloclaw-prices.ts`) and helper (`src/lib/kiloclaw/price-migration.ts`) assume one canonical price ID per plan (`Record<ClawPlan, string>`). After this change, Standard has two live prices (intro and regular). These scripts are not in the runtime path and do not need updating for this deploy, but **any future price migration must account for the intro price** — either by extending `newPriceIds` to include it or by ensuring the migration only targets subscriptions on the regular price. Without this, a migration run against an intro-month subscriber would swap their intro price for the new regular price, breaking the intro→regular schedule.

## Files Changed

| File                                                         | Change                                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/config.server.ts`                                   | Add intro price env var, remove coupon env var                                                                                                                                                                        |
| `src/lib/kiloclaw/stripe-price-ids.server.ts`                | Add intro price to metadata map, new `getStripePriceIdForClawPlanIntro`, new `isIntroPriceId`                                                                                                                         |
| `src/routers/kiloclaw-router.ts`                             | Checkout: intro price + `allow_promotion_codes`. switchPlan: handle auto schedule with stale-schedule defense. cancelPlanSwitch: restore auto schedule on intro price. reactivateSubscription: recreate auto schedule |
| `src/lib/kiloclaw/stripe-handlers.ts`                        | New `ensureAutoIntroSchedule` shared idempotent helper (DB + live Stripe fetch guard). Called from `handleKiloClawSubscriptionCreated`, `reactivateSubscription`, and `cancelPlanSwitch`. Update comments             |
| `src/lib/kiloclaw/billing-lifecycle-cron.ts`                 | New sweep: detect and repair stranded intro-price subscriptions with no attached schedule                                                                                                                             |
| `src/app/(app)/claw/components/billing/SubscriptionCard.tsx` | Gate switch button on `scheduledBy === 'user'` not `scheduledPlan` presence                                                                                                                                           |
| `src/routers/kiloclaw-billing-router.test.ts`                | Update checkout assertions, add lifecycle tests for auto-schedule, cancel/reactivate, switchPlan, cancelPlanSwitch, invoice classification, reconciliation sweep                                                      |
