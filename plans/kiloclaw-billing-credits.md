# KiloClaw Stripe-to-Credits Billing Migration

## Background

This plan converts KiloClaw Stripe subscriptions into credit-accounted
subscriptions, where Stripe still collects payment but the local billing
engine tracks the period via credits. The result is a "hybrid" row:
`payment_source='credits'` with a non-null `stripe_subscription_id`.

Based on PLAN-OPUS-CODEX.md (source of truth for ownership model and
implementation order) and PLAN-OPUS-OPUS.md (supplementary reference for
concrete code examples and risk walkthroughs).

## Design Summary

On each KiloClaw `invoice.paid`:

1. Classify the invoice as KiloClaw by price ID
2. Add credits via `processTopUp()` using the invoice's charge ID
3. Insert a matching negative `credit_transactions` row (same transaction)
4. Advance the billing period using invoice-derived boundaries
5. Set `payment_source = 'credits'`, preserving `stripe_subscription_id`

The user's visible credit balance never changes — the positive and negative
entries cancel out atomically within a single DB transaction.

Key design properties:

- **Lazy migration**: existing Stripe rows convert on their next paid
  invoice. No backfill, no flag day.
- **Invoice amount in, same amount out**: the settled Stripe amount becomes
  the credit deduction. First-month discounts ($5) flow through naturally.
- **Balance neutrality**: `processTopUp` and the deduction share a single
  DB transaction via `dbOrTx` (`credits.ts:59`).
- **Idempotency**: positive entry keyed by Stripe charge ID via
  `processTopUp()`; negative entry keyed by `buildCreditCategory()` with
  `onConflictDoNothing()`.
- **Explicit ownership split**: successful settlement owned by
  `invoice.paid`; dunning/failure by `subscription.updated`; pure-credit
  renewals by the local sweep.

## Three Valid Subscription States

After migration, these are the only valid `(payment_source,
stripe_subscription_id)` combinations:

| State         | payment_source | stripe_subscription_id | Owner                                                               |
| ------------- | -------------- | ---------------------- | ------------------------------------------------------------------- |
| Legacy Stripe | `stripe`       | non-null               | Stripe webhooks own everything                                      |
| Hybrid        | `credits`      | non-null               | `invoice.paid` owns settlement; `subscription.updated` owns dunning |
| Pure credit   | `credits`      | null                   | Local credit sweep owns renewal                                     |

## Ownership Model

- **`invoice.paid`**
  - Authoritative for hybrid-row successful settlement
  - Authoritative for hybrid-row period advancement
  - Authoritative for hybrid-row plan transition at renewal
  - Authoritative for hybrid-row recovery to `active`
  - Authoritative for hybrid-row `commit_ends_at` when a settled commit
    period is applied
- **`subscription.updated`**
  - Authoritative for legacy Stripe rows (current behavior, unchanged)
  - For hybrid rows: cancel intent and non-active Stripe dunning state
    propagation ONLY
  - Must NOT recover hybrid rows to `active`, clear suspension fields,
    or overwrite plan/period/commitment fields
- **`subscription_schedule.*`**
  - Still authoritative for schedule lifecycle cleanup
  - Must NOT be relied on for hybrid plan mutation during natural releases
- **`runCreditRenewalSweep()`**
  - Authoritative only for pure credit-funded rows
- **`billing-lifecycle-cron`**
  - Retries interrupted auto-resumes for ALL credit-accounted rows,
    including hybrid

Critical behavioral boundary:

- Hybrid success path -> `invoice.paid`
- Hybrid failure path -> `subscription.updated`
- Pure-credit renewal path -> renewal sweep

## Prerequisite: Billing Spec Update

The spec at `.specs/kiloclaw-billing.md` must be updated first. Current
rules that prohibit the hybrid state:

- Rule 2 (line 62): "A subscription with payment source `credits` MUST
  have a null payment provider subscription ID."
- Rule 5 (line 68): switching payment source requires cancel + re-enroll.

The spec update must define:

1. Three valid `(payment_source, stripe_subscription_id)` states (table
   above)
2. Hybrid-row ownership: `invoice.paid` owns settlement, plan mutation,
   period fields, `credit_renewal_at`, and recovery to `active`;
   `subscription.updated` owns cancel intent and non-active dunning state
   propagation only
3. Renewal-sweep scope: hybrid rows are excluded
4. Auto-resume retry scope: the interrupted auto-resume retry
   (`billing-lifecycle-cron.ts:155-179`) still includes hybrid rows
5. Hybrid plan switching: when a settled invoice reflects a new plan, the
   local plan mutation and schedule-field cleanup happen atomically in
   the invoice-settlement path

## Risks and Mitigations

### 1. `subscription.created` races with `invoice.paid`

Stripe fires both for a new checkout. Either can arrive first.
`handleKiloClawSubscriptionCreated` (`stripe-handlers.ts:89-217`)
unconditionally sets `payment_source: 'stripe'`, `plan`, `commit_ends_at`,
`current_period_start`, and `current_period_end` — all of which would
revert a row already converted by `invoice.paid`.

**Mitigation (Step 2)**: Guard the upsert's `onConflictDoUpdate.set` with
SQL `CASE` expressions. If the existing row has `payment_source = 'credits'`,
preserve `payment_source`, `plan`, `commit_ends_at`, `current_period_start`,
`current_period_end`, and `credit_renewal_at`. Still update
`stripe_subscription_id`, `cancel_at_period_end`, and other Stripe metadata.

### 2. `subscription.updated` reverts converted rows

`handleKiloClawSubscriptionUpdated` (`stripe-handlers.ts:222-318`)
unconditionally writes `payment_source: 'stripe'`, `plan`, period fields,
`commit_ends_at`, and — when the incoming status is `active` — clears
`suspended_at` and `destruction_deadline` (line 299).

The suspension-clearing behavior is a real bug surface for hybrid rows.
Current code at line 299:

```ts
...(status === 'active' ? { suspended_at: null, destruction_deadline: null } : {})
```

If `subscription.updated(active)` fires for a hybrid row before
`invoice.paid` arrives, it would falsely clear suspension without the
settlement having occurred. The success page
(`KiloClawCheckoutSuccessClient.tsx:19`) also treats `status === 'active'`
as sufficient, compounding the issue.

**Mitigation (Step 3)**: Pre-read the row. For hybrid rows, allow ONLY:

- `cancel_at_period_end`
- Non-active Stripe dunning states (`past_due`, `unpaid`, defensive
  terminal fallback)
- `past_due_since` (via existing `COALESCE(...)` pattern)

For hybrid rows, do NOT sync:

- `payment_source`
- `plan`
- `current_period_start`, `current_period_end`
- `credit_renewal_at`
- `commit_ends_at`
- Recovery to `active`
- Clearing of `past_due_since`
- Clearing of `suspended_at`
- Clearing of `destruction_deadline`
- `autoResumeIfSuspended()` side effects

### 3. Sweep acts on hybrid rows before `invoice.paid` arrives

The credit renewal sweep (`credit-billing.ts:329-360`) selects all
`payment_source='credits'` rows with `credit_renewal_at <= now()`. After
conversion, hybrid rows match this query.

Concrete failure scenario:

1. Hybrid row's `credit_renewal_at` passes
2. Stripe is processing the subscription invoice; webhook hasn't fired
3. Sweep runs, selects the row, checks balance: user has $2 in credits
4. $2 < $9 (standard) or $2 < $48 (commit) -> insufficient balance
5. If auto-top-up enabled: `triggerAutoTopUpForKiloClaw` fires
   (`credit-billing.ts:533`), creating a spurious Stripe charge — user
   gets double-billed
6. If auto-top-up disabled: sweep marks the row `past_due` and sends a
   `credit-renewal-failed` email for a subscription Stripe is about to
   pay successfully

The `buildCreditCategory` idempotency key prevents double _deduction_,
but the insufficient-balance path (auto-top-up trigger, `past_due` marking,
notification emails) executes _before_ the deduction attempt. The
idempotency key protects the wrong layer.

**Mitigation (Step 5)**: Add `isNull(stripe_subscription_id)` to the
sweep's WHERE clause. For hybrid rows, Stripe's dunning handles payment
failure; `subscription.updated` (with Step 3's guard) propagates
`past_due` to the local row.

### 4. Router blocks billing portal for converted rows

`createBillingPortalSession` (`kiloclaw-router.ts:1547-1552`) blocks when
`payment_source === 'credits'`. After conversion, hybrid rows need portal
access for Stripe payment method management.

**Mitigation (Step 4)**: Branch on `stripe_subscription_id` presence, not
`payment_source`. This is a safe no-op before hybrid rows exist — no
pure-credit rows have a `stripe_subscription_id`.

### 5. `subscription.updated(active)` falsely implies successful settlement

Current code clears suspension on `active` (`stripe-handlers.ts:299`) and
the success page treats `active` alone as success. For hybrid rows, an
`active` status from Stripe does not mean the invoice has been locally
settled — `invoice.paid` owns that.

**Mitigation**: Step 3's hybrid guard blocks recovery writes from
`subscription.updated`. Step 9's success page change waits for both
`status === 'active'` AND `paymentSource === 'credits'`.

### 6. Natural schedule releases clear tracking before invoice settlement

`handleKiloClawScheduleEvent` (`stripe-handlers.ts:406-412`) has a comment
that says `subscription.updated` picks up the new price via
`detectPlanFromSubscription`. The same assumption appears in `switchPlan`
(`kiloclaw-router.ts:1468-1473`). Under the hybrid design, this is wrong:
`invoice.paid` owns the plan mutation.

If the schedule release event arrives before `invoice.paid`, it clears
`scheduled_plan`, `scheduled_by`, and `stripe_schedule_id`. The settlement
helper then has no local record of the pending switch.

**Mitigation (Step 8)**: Update `handleKiloClawScheduleEvent` so hybrid
rows don't rely on schedule events for plan mutation. The `invoice.paid`
handler (Step 7) must derive the plan from the invoice line item's price
ID, not from `scheduled_plan`.

### 7. Invoice field extraction must be null-safe

Relevant Stripe fields may be missing, string IDs instead of expanded
objects, or arrays with no matching KiloClaw line item.

**Mitigation**: Use explicit guards for `invoice.subscription`,
`invoice.charge`, line-item selection, `line.period.start`, and
`line.period.end`. No `!` assertions. No bare `[0]` indexing. Bail with
a warning log if any required field is missing.

Charge ID extraction pattern (from `stripe.ts:636`):

```ts
const chargeId = 'charge' in invoice && typeof invoice.charge === 'string' ? invoice.charge : null;
```

### 8. Balance inflation window

If `processTopUp` and the deduction are not in the same transaction, the
user's balance is temporarily inflated.

**Mitigation**: Pass `dbOrTx` into `processTopUp()` (`credits.ts:59`) and
perform the negative credit transaction, balance decrement, and
subscription-row mutation in the same DB transaction.

## Implementation Steps

### Step 1: Fix stale code artifacts

These misled adversarial reviews into flagging non-existent blockers. They
will mislead implementing engineers the same way.

**`src/lib/kiloclaw/stripe-handlers.ts` (line 271)**

Change:

```
// This fires naturally on monthly renewal webhooks
```

To:

```
// This fires naturally on renewal webhooks
```

The commit price is $48 every 6 months, not monthly.

**`src/lib/kiloclaw/credit-billing.ts` (line 48)**

Change:

```
/** Standard bills monthly (1 month), commit bills every 6 months ($54/6mo). */
```

To:

```
/** Standard bills monthly (1 month), commit bills every 6 months ($48/6mo). */
```

The $54 price was changed to $48 on 2026-03-19.

**`src/routers/kiloclaw-billing-router.test.ts` (line 176)**

The `makeStripeSubscription` fixture uses `now + 86400 * 30` (30-day
period) for all plans including commit, where the actual Stripe commit
period is 6 months. Either use `86400 * 180` for commit plan fixtures or
add a comment explaining the test is period-length-agnostic.

### Step 2: Guard `handleKiloClawSubscriptionCreated`

**File**: `src/lib/kiloclaw/stripe-handlers.ts` (lines 166-202)

Change the upsert's `onConflictDoUpdate.set` to preserve converted-row
state. For an existing hybrid row, preserve:

- `payment_source`
- `plan`
- `current_period_start`
- `current_period_end`
- `credit_renewal_at`
- `commit_ends_at`

Use SQL `CASE` expressions:

```ts
payment_source: sql`CASE
  WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' THEN 'credits'
  ELSE 'stripe'
END`,
plan: sql`CASE
  WHEN ${kiloclaw_subscriptions.payment_source} = 'credits'
    THEN ${kiloclaw_subscriptions.plan}
  ELSE ${plan}
END`,
current_period_start: sql`CASE
  WHEN ${kiloclaw_subscriptions.payment_source} = 'credits'
    THEN ${kiloclaw_subscriptions.current_period_start}
  ELSE ${periods.current_period_start}
END`,
current_period_end: sql`CASE
  WHEN ${kiloclaw_subscriptions.payment_source} = 'credits'
    THEN ${kiloclaw_subscriptions.current_period_end}
  ELSE ${periods.current_period_end}
END`,
commit_ends_at: sql`CASE
  WHEN ${kiloclaw_subscriptions.payment_source} = 'credits'
    THEN ${kiloclaw_subscriptions.commit_ends_at}
  ELSE ${commitEndsAt}
END`,
```

Still update regardless of conversion state:

- `stripe_subscription_id`
- `cancel_at_period_end`
- `status` (only for non-hybrid; for hybrid rows, `status` is already
  managed by `invoice.paid` and `subscription.updated`'s dunning path)

This guard is a safe no-op before hybrid rows exist. The `CASE` always
takes the ELSE branch for existing `payment_source='stripe'` rows.

### Step 3: Guard `handleKiloClawSubscriptionUpdated` for hybrid rows

**File**: `src/lib/kiloclaw/stripe-handlers.ts` (lines 222-318)

Before the main update (line 259), pre-read the row:

```ts
const [existingRow] = await db
  .select({
    payment_source: kiloclaw_subscriptions.payment_source,
    stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
  })
  .from(kiloclaw_subscriptions)
  .where(
    and(
      eq(kiloclaw_subscriptions.user_id, kiloUserId),
      eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
    )
  )
  .limit(1);

const isHybrid =
  existingRow?.payment_source === 'credits' && existingRow?.stripe_subscription_id !== null;
```

**If `isHybrid`**, only sync:

- `cancel_at_period_end`
- Non-active Stripe dunning status: `past_due`, `unpaid`, defensive
  terminal fallback
- `past_due_since` (via existing `COALESCE(...)` pattern)

**If `isHybrid`**, do NOT sync:

- `payment_source`
- `plan`
- `current_period_start`, `current_period_end`
- `credit_renewal_at`
- `commit_ends_at`
- Recovery to `active`
- Clearing of `past_due_since`
- Clearing of `suspended_at`
- Clearing of `destruction_deadline`
- `autoResumeIfSuspended()` side effects

**If NOT hybrid** (`payment_source='stripe'`): keep current behavior
unchanged.

**Why status sync is needed for hybrid rows**: Step 5 excludes hybrid
rows from the credit sweep's insufficient-balance path. Stripe's
`subscription.updated` webhook is the only mechanism that can set
`past_due` for hybrid rows when payment fails.

**Why plan sync is skipped for hybrid rows**: `invoice.paid` is the
authoritative moment when the plan and period advance together. If
`subscription.updated` synced `plan` before the corresponding invoice
is paid (e.g. a scheduled plan switch executes), the local row would
show the new plan with the old period — an inconsistent state.

Also update the stale comment at line 271 (if not already done in Step 1).

### Step 4: Move router billing mutations to `stripe_subscription_id` branching

**File**: `src/routers/kiloclaw-router.ts`

Change branching from `payment_source === 'credits'` to
`stripe_subscription_id` presence in:

#### `cancelSubscription` (line 1284-1363)

- Current: `if (sub.payment_source === 'credits')` -> local-only
- New: `if (!sub.stripe_subscription_id)` -> local-only; else -> local + Stripe

Converted rows cancel both locally and on Stripe, keeping the funding
subscription in sync.

#### `reactivateSubscription` (line 1365-1403)

- Same change: `!sub.stripe_subscription_id` instead of
  `payment_source === 'credits'`

#### `switchPlan` (line 1405-1496)

- Same change: `!sub.stripe_subscription_id`
- Converted rows still use Stripe subscription schedules for plan switches

#### `cancelPlanSwitch` (line 1498-1538)

- Same change: `!sub.stripe_subscription_id` (and check
  `!sub.stripe_schedule_id`)

#### `createBillingPortalSession` (line 1540-1565)

- Current: blocks when `payment_source === 'credits'` (line 1547-1552)
- New: block when `!sub.stripe_subscription_id`

**Why this deploys before the conversion path**: Without this fix, a
freshly converted hybrid row would lose portal access. The branching
change is a safe no-op — no pure-credit rows have a
`stripe_subscription_id`, so behavior is identical for all existing rows.

### Step 5: Exclude hybrid rows from `runCreditRenewalSweep`

**File**: `src/lib/kiloclaw/credit-billing.ts` (lines 329-360)

Add `isNull(stripe_subscription_id)` to the sweep's WHERE clause:

```ts
.where(
  and(
    eq(kiloclaw_subscriptions.payment_source, 'credits'),
    isNull(kiloclaw_subscriptions.stripe_subscription_id),
    or(
      eq(kiloclaw_subscriptions.status, 'active'),
      eq(kiloclaw_subscriptions.status, 'past_due')
    ),
    lte(kiloclaw_subscriptions.credit_renewal_at, now)
  )
)
```

**Important non-change**: Do NOT add the same filter to the interrupted
auto-resume retry in `billing-lifecycle-cron.ts:155-179`. That retry
should continue to select hybrid rows. A hybrid row can need retry if
`autoResumeIfSuspended()` started but failed mid-flight —
`autoResumeIfSuspended` (`credit-billing.ts:215`) explicitly leaves
`suspended_at` set so the cron can retry.

**Why this deploys before the conversion path**: Without the sweep
exclusion, the sweep can act on newly converted rows before
`invoice.paid` arrives. The `isNull(stripe_subscription_id)` filter is a
safe no-op — no pure-credit rows have a `stripe_subscription_id`.

### Step 6: Add `applyStripeFundedKiloClawPeriod`

**File**: `src/lib/kiloclaw/credit-billing.ts`

New exported function alongside `enrollWithCredits`:

```ts
applyStripeFundedKiloClawPeriod({
  userId: string,
  plan: 'commit' | 'standard',
  invoiceAmountCents: number,
  stripeSubscriptionId: string,
  periodStart: string, // from invoice line item
  periodEnd: string, // from invoice line item
  chargeId: string, // for processTopUp stripe_payment_id
  user: User, // for processTopUp
});
```

Inside one DB transaction:

1. Load the existing subscription row:
   - `status`, `suspended_at`, `plan`, `commit_ends_at`, `scheduled_plan`,
     `scheduled_by`, `stripe_schedule_id`

2. Call `processTopUp(user, invoiceAmountCents, { type: 'stripe',
stripe_payment_id: chargeId }, { skipPostTopUpFreeStuff: true,
dbOrTx: tx })`

3. If `processTopUp()` returns false (duplicate charge ID), return early
   (idempotent)

4. Build the deduction key: `buildCreditCategory(plan,
new Date(periodStart))` — using the invoice's period start, not
   wall-clock time

5. Insert negative `credit_transactions` row with
   `check_category_uniqueness: true`, `onConflictDoNothing()`

6. Decrement `kilocode_users.total_microdollars_acquired` by
   `invoiceAmountCents * 10_000` (microdollars)

7. Upsert `kiloclaw_subscriptions`:
   - `plan` = invoice-derived plan
   - `status` = `'active'`
   - `payment_source` = `'credits'`
   - Preserve `stripe_subscription_id` (do NOT null it)
   - `current_period_start` = `periodStart`
   - `current_period_end` = `periodEnd`
   - `credit_renewal_at` = `periodEnd`
   - `commit_ends_at` = `periodEnd` for commit, `null` for standard
   - Clear `past_due_since`
   - Clear `auto_top_up_triggered_for_period`
   - On conflict update (keyed on `user_id`)

8. Hybrid plan-switch handling:
   - If the local row has `scheduled_plan === plan`, clear
     `scheduled_plan`, `scheduled_by`, and `stripe_schedule_id`
     atomically with the plan update
   - If the invoice plan differs from the local row and there is no
     matching `scheduled_plan`, trust the settled invoice as authoritative
     and log a warning

Post-transaction:

- If the pre-transaction row was `past_due` or `suspended_at` was set,
  call `autoResumeIfSuspended()`
- Call `evaluateKiloPassBonusAfterDeduction()`

**Important rules for this helper**:

- Use invoice-derived period boundaries only
- Do NOT call `periodLengthMonths()` for the hybrid path
- Do NOT call `planCostMicrodollars()` for the hybrid path
- Apply hybrid plan transitions here, not in `subscription.updated`

The deduction amount is `invoiceAmountCents * 10_000` (microdollars),
matching `processTopUp`'s conversion. $5 discounted first month in from
Stripe = $5 deducted from credits.

**Open verification item**: Confirm in tests that the commit invoice line
item's `period.end` is always the real six-month commitment boundary. If
that holds, `commit_ends_at = periodEnd` is correct and simpler than
computing from previous boundaries. If Stripe uses a different period
representation for commit, adjust `commit_ends_at` computation
accordingly.

### Step 7: KiloClaw `invoice.paid` webhook handler

**File**: `src/lib/stripe.ts` (in `processStripePaymentEventHook`,
`invoice.paid` case)

Insert new handling after the Kilo Pass check (line 623-628) and before
the auto-top-up check (line 630):

```ts
const isKiloClawByPriceId = invoiceLooksLikeKiloClawByPriceId(invoice);
if (isKiloClawByPriceId) {
  await handleKiloClawInvoicePaid({ eventId: event.id, invoice });
  break;
}
```

New handler function (in `stripe-handlers.ts` or a new file):

1. Extract `chargeId` safely (pattern from `stripe.ts:636`)
2. Extract subscription ID from `invoice.subscription` (handle string
   or expanded object)
3. Fetch subscription via `stripe.subscriptions.retrieve(subId)`
4. Extract `kiloUserId` from metadata via `getKiloClawMetadata`
   (`stripe-handlers.ts:23`)
5. Determine the settled plan from the matching KiloClaw invoice line
   item's price ID via `getClawPlanForStripePriceId`
   (`stripe-price-ids.server.ts:31`) — do NOT assume
   `invoice.lines.data[0]` is the relevant line; find the line item
   whose price ID maps to a KiloClaw plan
6. Extract `periodStart` and `periodEnd` from that same matching line
   item — verify `line.period` exists before accessing `.start`/`.end`
7. Load user row for `processTopUp`
8. Call `applyStripeFundedKiloClawPeriod(...)` from Step 6
9. Log success

**Null safety**: Every field extracted from the Stripe invoice must have
explicit null/undefined guards. No `!` assertions. No bare `[0]`
indexing without checking array length. Bail with a warning log if any
required field is missing.

This handler must not rely on `scheduled_plan` still existing locally
because a schedule release event may have already cleared it.

### Step 8: Align schedule-event behavior with hybrid ownership

**File**: `src/lib/kiloclaw/stripe-handlers.ts` (lines 371-439)

Update `handleKiloClawScheduleEvent()` to match the new ownership model.

Required changes:

- Remove or rewrite the comment at lines 406-412 that says
  `subscription.updated` picks up the new price on natural release
- Do not rely on schedule events to mutate hybrid `plan`
- If needed, add a hybrid-row guard so terminal schedule events clear
  tracking fields (`stripe_schedule_id`, `scheduled_plan`, `scheduled_by`)
  without mutating `plan` or `commit_ends_at` for hybrid rows

Legacy Stripe rows can keep their current schedule behavior until they
convert.

Also update `switchPlan` at `kiloclaw-router.ts:1468-1473` to remove the
comment that says the plan change is picked up by `subscription.updated`
via `detectPlanFromSubscription`.

### Step 9: Update billing status, types, and success flow

**File**: `src/routers/kiloclaw-router.ts` (lines 1110-1132)

Add `hasStripeFunding` to the subscription object:

```ts
hasStripeFunding: !!sub.stripe_subscription_id,
```

Note: this is `!!sub.stripe_subscription_id`, NOT
`payment_source === 'credits' && !!sub.stripe_subscription_id`. The
latter would mis-classify legacy Stripe rows — they have Stripe funding
too. The simpler form covers all Stripe-funded rows correctly:
`hasStripeFunding` is true for both legacy and hybrid rows, false only for
pure credit rows.

**File**: `src/app/(app)/claw/components/billing/billing-types.ts`

Add to the subscription type:

```ts
hasStripeFunding: boolean;
```

For `renewalCostMicrodollars`: for `hasStripeFunding` rows, display a
plan-based approximation ($9 standard, $48 commit), or set to `null` and
show "Billed via Stripe" in the UI.

**File**: `src/app/payments/kiloclaw/success/KiloClawCheckoutSuccessClient.tsx`
(line 19)

Change the activation check to wait for conversion:

```ts
const isActive =
  billingStatus?.subscription?.status === 'active' &&
  billingStatus?.subscription?.paymentSource === 'credits';
```

This ensures the success page waits until `invoice.paid` has processed
(which flips `payment_source` to `'credits'`), rather than showing success
as soon as `subscription.created` sets status `active` with
`payment_source='stripe'`.

### Step 10: Frontend UI updates

**File**: `src/app/(app)/claw/components/billing/SubscriptionCard.tsx`

- `ActiveSubscriptionCard`: show "Manage" button (billing portal) only
  when `hasStripeFunding` is true. Pure credit rows have no Stripe
  subscription to manage.
- `PastDueSubscriptionCard`: branch copy on `hasStripeFunding`:
  - Stripe-funded: "Update your payment method"
  - Pure credit: "Add credits" / "Top up balance"

**File**: `src/app/(app)/claw/components/billing/AccessLockedDialog.tsx`

- "Redirected to Stripe" messaging: show only for Stripe-funded rows.
  Pure credit rows should reference credits.
- `past_due_grace_exceeded` copy: branch on `hasStripeFunding`:
  - Stripe-funded: "Update your payment method"
  - Pure credit: "Insufficient KiloClaw credits"

### Step 11: Tests

**Files**:

- `src/lib/kiloclaw/credit-billing.test.ts` (existing)
- `src/routers/kiloclaw-billing-router.test.ts` (existing)
- New handler-specific test file for `invoice.paid` if needed

#### 1. `applyStripeFundedKiloClawPeriod`

- Standard discounted first invoice ($5)
- Standard full-price renewal ($9)
- Commit 6-month renewal ($48)
- Legacy Stripe row conversion (`payment_source` flips to `'credits'`)
- Idempotency: duplicate `invoice.paid` -> no double credit, no double
  deduction
- Past-due recovery: row is `past_due` -> invoice arrives -> active
- Suspended recovery: row has `suspended_at` -> invoice arrives ->
  auto-resumes
- Cancel-at-period-end + invoice arrives -> still advances period
- Period boundaries come from invoice, not from `periodLengthMonths`
- Settled hybrid plan switch applies plan and clears local schedule fields
- Invoice plan diverges from local row with no matching `scheduled_plan`
  -> trusts invoice, logs warning

#### 2. Webhook guards

- `subscription.created` after `invoice.paid` does NOT revert
  `payment_source` to `'stripe'`
- `subscription.created` after `invoice.paid` does NOT overwrite `plan`,
  `commit_ends_at`, `current_period_start`, `current_period_end`, or
  `credit_renewal_at`
- `subscription.created` still updates `stripe_subscription_id` and cancel
  intent for converted rows
- Hybrid `subscription.updated` propagates `past_due`
- Hybrid `subscription.updated` propagates `unpaid`
- Hybrid `subscription.updated(active)` does NOT clear suspension or
  advance period fields
- Hybrid `subscription.updated` does NOT overwrite `payment_source`,
  `plan`, `current_period_start`, `current_period_end`, or `commit_ends_at`
- Non-hybrid `subscription.updated`: full current behavior preserved

#### 3. Sweep exclusion

- Hybrid row due for renewal is NOT selected by the sweep
- Hybrid row due for renewal does NOT trigger KiloClaw auto-top-up
- Hybrid row due for renewal does NOT get marked `past_due`
- Pure credit sweep behavior remains unchanged

#### 4. Interrupted auto-resume retry

- Hybrid `active` row with non-null `suspended_at` is still selected
  by the retry query
- Retry still calls `autoResumeIfSuspended()` for hybrid rows

#### 5. Router mutations

- Hybrid cancel calls Stripe + local DB
- Hybrid reactivate calls Stripe + local DB
- Hybrid switch plan creates a Stripe schedule
- Hybrid cancel plan switch releases the Stripe schedule
- Hybrid billing portal is allowed
- Pure credit billing portal remains blocked

#### 6. Schedule/invoice ordering

- Natural schedule release before `invoice.paid` does not prevent settled
  invoice plan application
- Natural schedule release after `invoice.paid` is harmless

#### 7. Regressions

- Pure `enrollWithCredits()` still works
- Pure credit renewal sweep still works
- Kilo Pass `invoice.paid` handling is unchanged
- Generic top-up flow is unchanged

## Implementation Order

1. Update the billing spec (`.specs/kiloclaw-billing.md`)
2. **Step 1**: Fix stale code artifacts
3. **Step 2**: Guard `handleKiloClawSubscriptionCreated`
4. **Step 3**: Guard `handleKiloClawSubscriptionUpdated` for hybrid rows
5. **Step 4**: Router discriminant cleanup
6. **Step 5**: Sweep exclusion for hybrid rows
7. **Step 6**: `applyStripeFundedKiloClawPeriod` helper
8. **Step 7**: KiloClaw `invoice.paid` handler
9. **Step 8**: Schedule-event ownership cleanup
10. **Step 9**: Billing status / success page / types
11. **Step 10**: Frontend copy / visibility changes
12. **Step 11**: Full test suite
13. Run full test suite, typecheck, lint

**Critical ordering constraints**:

- Steps 3 and 4 must land before Steps 6 and 7
- Step 5 must land before or atomically with Steps 6 and 7
- Step 8 must land with or before Step 7

**Ordering rationale**: Steps 2-5 are safe no-ops that prepare the
codebase for converted rows. No hybrid rows exist yet, so:

- The `subscription.created` SQL CASE (Step 2) always takes the ELSE
  branch
- The `subscription.updated` pre-read (Step 3) never finds a hybrid row
- The router's `stripe_subscription_id` check (Step 4) behaves
  identically to the current `payment_source` check for all existing rows
- The sweep's `isNull(stripe_subscription_id)` filter (Step 5) excludes
  nothing

Steps 6-7 create converted rows. All guards are already in place.
Steps 8-10 can be deployed in any order after Steps 6-7.

## Permanent Complexity

These are accepted trade-offs, not items to be resolved:

- **Hybrid webhook guards are permanent.** The SQL `CASE` in Step 2 and
  the pre-read in Step 3 must remain for as long as hybrid rows exist.
  Future edits to `handleKiloClawSubscriptionCreated` or
  `handleKiloClawSubscriptionUpdated` must preserve the hybrid ownership
  split.

- **Two renewal engines exist by design.** Pure credit rows renew in the
  local sweep; hybrid rows renew in `invoice.paid`. Both use the same
  `buildCreditCategory` key with `onConflictDoNothing`, so the deduction
  itself is safe. But future changes to renewal logic must be applied to
  both paths.

- **Schedule ordering is eventually consistent.** Schedule events and
  settled invoices may arrive in either order. The code must tolerate
  either.

- **Synthetic ledger entries are intentional.** Each Stripe-funded
  renewal creates one positive credit event and one matching negative
  deduction in `credit_transactions`. Any transaction history UI should
  label them accordingly.
