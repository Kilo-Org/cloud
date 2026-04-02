# Coding Plans — Backend Implementation Plan

## Overview

Implement the backend for Coding Plans: a recurring subscription product that grants users a pre-purchased API key for an upstream provider, billed periodically in Kilo Credits. This plan covers **backend only** — no UI work.

### What Already Exists

| Component                                   | Status      | Location                                           |
| ------------------------------------------- | ----------- | -------------------------------------------------- |
| Provider definitions (BytePlus, Kimi, Z.AI) | ✅ Complete | `src/lib/providers/coding-plans/`                  |
| Traffic routing (separate from BYOK)        | ✅ Complete | `src/lib/providers/index.ts`                       |
| BYOK key storage + AES-256-GCM encryption   | ✅ Complete | `src/lib/byok/`, `byok_api_keys` table             |
| Credit transaction system + idempotency     | ✅ Complete | `credit_transactions` table, `enrollWithCredits()` |
| Obfuscated identity generation              | ✅ Complete | `src/lib/providerHash.ts`                          |
| GDPR soft-delete (deletes BYOK keys)        | ✅ Partial  | `src/lib/user.ts:softDeleteUser`                   |

### What Needs to Be Built

1. Two new database tables (subscription + key inventory)
2. Subscription purchase flow (atomic credit deduction + key assignment)
3. Pre-purchased key inventory management (admin upload, assignment)
4. Billing lifecycle cron (renewal + cancellation)
5. tRPC router (subscribe, cancel, list, admin endpoints)
6. GDPR soft-delete updates
7. Tests

### Key Decisions

| Decision                  | Choice                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Pricing                   | Env-configurable per provider via env vars (e.g., `CODING_PLAN_PRICE_BYTEPLUS_CODING`) |
| Billing period            | 30 days for all providers                                                              |
| Past-due grace period     | None — cancel immediately on failed renewal                                            |
| Extension behavior (§2.5) | Stack new period onto existing end date                                                |
| Auto-top-up               | Yes — trigger auto-top-up before canceling on failed renewal                           |
| Admin key upload          | Admin tRPC endpoint only                                                               |

---

## Step 1: Database Schema

### 1a. `coding_plan_subscriptions` table

New table in `packages/db/src/schema.ts`. Modeled after `kiloclaw_subscriptions` but scoped per-user-per-provider (not per-instance).

```
coding_plan_subscriptions
├── id                         uuid PK (gen_random_uuid)
├── user_id                    text NOT NULL FK→kilocode_users.id ON DELETE CASCADE
├── provider_id                text NOT NULL  (e.g. 'byteplus-coding', 'zai-coding', 'kimi-coding')
├── byok_key_id                uuid FK→byok_api_keys.id ON DELETE SET NULL
├── status                     text NOT NULL  ('active' | 'canceled')
├── cost_microdollars          bigint NOT NULL  (price per period in microdollars)
├── billing_period_days        integer NOT NULL  (30)
├── current_period_start       timestamptz
├── current_period_end         timestamptz
├── credit_renewal_at          timestamptz  (next renewal timestamp)
├── cancel_at_period_end       boolean NOT NULL DEFAULT false
├── canceled_at                timestamptz
├── auto_top_up_triggered_for_period  timestamptz
├── created_at                 timestamptz NOT NULL DEFAULT now()
├── updated_at                 timestamptz NOT NULL DEFAULT now()  ($onUpdateFn)
```

**Constraints:**

- `uniqueIndex('UQ_coding_plan_sub_user_provider').on(user_id, provider_id)` — enforces spec §2.4 (one subscription per provider per user). This constraint applies to ALL rows, including canceled ones. When re-subscribing after cancellation, we UPDATE the existing row back to `active` rather than inserting a new one.
- `enumCheck` on `status` for `['active', 'canceled']`

**Design notes:**

- No `past_due` status — if renewal fails (even after auto-top-up attempt), subscription cancels immediately.
- `byok_key_id` FK to `byok_api_keys` with `ON DELETE SET NULL` — if the BYOK row is deleted (e.g., during GDPR cleanup), the subscription record survives for billing history but the key link goes null.
- `cost_microdollars` and `billing_period_days` are stored per-subscription (snapshot at purchase time) so plan pricing can change without affecting existing subscribers.

### 1b. `coding_plan_key_inventory` table

New table for pre-purchased keys awaiting assignment (spec §4.1, §4.2).

```
coding_plan_key_inventory
├── id                         uuid PK (gen_random_uuid)
├── provider_id                text NOT NULL  (e.g. 'byteplus-coding')
├── encrypted_api_key          jsonb NOT NULL  (EncryptedData — same encryption as BYOK)
├── assigned_to_user_id        text FK→kilocode_users.id ON DELETE SET NULL
├── assigned_at                timestamptz
├── created_at                 timestamptz NOT NULL DEFAULT now()
```

**Constraints:**

- `index('IDX_coding_plan_key_inv_provider').on(provider_id)` — for fast lookups of available keys
- `index('IDX_coding_plan_key_inv_unassigned').on(provider_id).where(assigned_to_user_id IS NULL)` — partial index for fast "find next available key"

**Design notes:**

- Unassigned keys (`assigned_to_user_id IS NULL`) are the pool of available keys.
- Once assigned, `assigned_to_user_id` + `assigned_at` record provenance.
- Encryption reuses the existing `encryptApiKey()`/`decryptApiKey()` from `src/lib/byok/encryption.ts` (same `BYOK_ENCRYPTION_KEY` env var).
- Keys are never deleted from this table — they serve as an audit trail. The user-facing key is in `byok_api_keys`.

### 1c. Migration

Generate via `pnpm drizzle generate` after adding both tables to the schema. A single migration file for both tables.

---

## Step 2: Plan Catalog & Pricing

New file: `src/lib/coding-plans/pricing.ts`

Pricing is loaded from environment variables, with each provider having its own env var. The billing period is fixed at 30 days.

```typescript
import { getEnvVariable } from '@/lib/dotenvx';
import type { DirectUserByokInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';

type CodingPlanCatalogEntry = {
  costMicrodollars: number;
  billingPeriodDays: number;
  name: string;
};

const CODING_PLAN_PROVIDER_IDS = ['byteplus-coding', 'kimi-coding', 'zai-coding'] as const;
type CodingPlanProviderId = (typeof CODING_PLAN_PROVIDER_IDS)[number];

// Env var names: CODING_PLAN_PRICE_BYTEPLUS_CODING, CODING_PLAN_PRICE_KIMI_CODING, CODING_PLAN_PRICE_ZAI_CODING
// Values are in microdollars (integer). E.g., 4990000 = $4.99
function envVarName(providerId: CodingPlanProviderId): string {
  return 'CODING_PLAN_PRICE_' + providerId.toUpperCase().replace(/-/g, '_');
}

const PROVIDER_NAMES: Record<CodingPlanProviderId, string> = {
  'byteplus-coding': 'BytePlus Coding Plan',
  'kimi-coding': 'Kimi Code',
  'zai-coding': 'Z.AI Coding Plan',
};

export function getCodingPlanCatalog(): Record<CodingPlanProviderId, CodingPlanCatalogEntry> {
  // Build catalog from env vars; omit providers without a configured price
  const catalog = {} as Record<string, CodingPlanCatalogEntry>;
  for (const providerId of CODING_PLAN_PROVIDER_IDS) {
    const raw = getEnvVariable(envVarName(providerId));
    if (!raw) continue;
    const costMicrodollars = parseInt(raw, 10);
    if (Number.isNaN(costMicrodollars) || costMicrodollars < 0) continue;
    catalog[providerId] = {
      costMicrodollars,
      billingPeriodDays: 30,
      name: PROVIDER_NAMES[providerId],
    };
  }
  return catalog;
}

export function getCodingPlanPrice(providerId: string): CodingPlanCatalogEntry | null {
  const catalog = getCodingPlanCatalog();
  return catalog[providerId] ?? null;
}
```

**Design notes:**

- If an env var is missing or invalid, that provider is simply absent from the catalog — it won't be offered for purchase.
- Setting a price to `0` allows free subscriptions (key assignment only, no credit deduction).
- The catalog is computed at call time from env vars, so prices update on next deployment without code changes.

---

## Step 3: Core Business Logic

New file: `src/lib/coding-plans/index.ts`

### 3a. `subscribeToCodingPlan(userId, providerId)`

The main purchase flow. Implements spec §7.1 processing order:

1. **Validate catalog**: Call `getCodingPlanPrice(providerId)`. If null (provider not in catalog or price not configured), throw `PROVIDER_NOT_AVAILABLE`.
2. **Check existing subscription**: Query `coding_plan_subscriptions` for this user+provider.
   - If `status = 'active'`: handle extension (spec §2.5) — see §3d below.
   - If `status = 'canceled'`: will reactivate (update existing row).
3. **Verify credit balance**: Read user's `total_microdollars_acquired - microdollars_used`. If less than `costMicrodollars` and cost > 0, reject with `INSUFFICIENT_BALANCE` (spec §2.3).
4. **Atomic transaction** (single DB transaction):
   a. **Deduct credits** (if cost > 0): Insert into `credit_transactions` with `credit_category: 'coding-plan:{providerId}:{subscriptionId}:{yearMonth}'` and `check_category_uniqueness: true`. Use `onConflictDoNothing()` for idempotency. If `rowCount === 0`, the deduction was already processed — return existing subscription.
   b. **Increment `microdollars_used`** on the user row.
   c. **Assign a pre-purchased key**: `UPDATE coding_plan_key_inventory SET assigned_to_user_id = $userId, assigned_at = now() WHERE id = (SELECT id FROM coding_plan_key_inventory WHERE provider_id = $providerId AND assigned_to_user_id IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. If no key available, **roll back the entire transaction** (spec §4.3 — credits are never deducted if key assignment fails).
   d. **Decrypt the assigned key** and **insert into `byok_api_keys`** (re-encrypted under `kilo_user_id`). This makes it available in the user's BYOK configuration per spec §4.1.
   e. **Upsert subscription row**: Insert new `coding_plan_subscriptions` row with status `'active'`, linking the new `byok_key_id`, setting `current_period_start = now()`, `current_period_end = now() + 30 days`, `credit_renewal_at = now() + 30 days`. If re-subscribing after cancellation, UPDATE the existing row instead.
5. **Post-transaction**: Evaluate Kilo Pass bonus (following `enrollWithCredits` pattern).
6. **Return** the subscription record.

**Idempotency**: The `credit_category` unique index ensures duplicate requests are detected. The `FOR UPDATE SKIP LOCKED` on key assignment prevents concurrent assignment of the same key.

### 3b. `cancelCodingPlanSubscription(userId, providerId)`

User-facing cancellation (cancel at period end):

1. Find the active subscription for this user+provider.
2. Set `cancel_at_period_end = true`. The subscription remains active until `current_period_end`.
3. When the billing cron processes it at renewal time, it transitions to `'canceled'` and removes the BYOK key.

### 3c. `cancelCodingPlanImmediately(userId, providerId)`

For admin/GDPR use. Within a transaction:

1. Set status to `'canceled'`, `canceled_at = now()`, `byok_key_id = null`.
2. Delete the associated `byok_api_keys` row (spec §5.1 — remove from Kilo, do NOT revoke with upstream).

### 3d. `extendSubscription(existingSubscription, userId)` (internal)

Called when a user tries to subscribe to a provider they already have an active subscription for (spec §2.5). Within the same transaction as the purchase:

1. New credit deduction for the next period (same idempotency pattern, different `yearMonth` in category).
2. Extend `current_period_end` by `billing_period_days` (stacking onto existing end date).
3. Advance `credit_renewal_at` to the new `current_period_end`.
4. No new key assignment — user keeps the same key.

---

## Step 4: Billing Lifecycle Cron

New file: `src/lib/coding-plans/billing-lifecycle-cron.ts`

A cron job following the same pattern as `src/lib/kiloclaw/billing-lifecycle-cron.ts`. Triggered on a schedule (e.g., every 5 minutes via Vercel cron or equivalent).

### Sweeps:

**Sweep 1: Cancel at period end**

- Select subscriptions where `status = 'active'` AND `cancel_at_period_end = true` AND `current_period_end <= now()`.
- For each: transition to `'canceled'`, delete BYOK key (spec §5.1), set `canceled_at = now()`, `byok_key_id = null`.

**Sweep 2: Renewals**

- Select subscriptions where `status = 'active'` AND `credit_renewal_at <= now()` AND `cancel_at_period_end = false`.
- For each subscription:
  1. Read the current cost from the subscription row (`cost_microdollars`).
  2. Check user balance. If insufficient AND user has auto-top-up enabled:
     - Trigger auto-top-up (follow `fire-and-skip` pattern from KiloClaw — trigger the Stripe charge, then skip this subscription for now; on next cron run, the balance should be replenished).
     - Set `auto_top_up_triggered_for_period` to prevent duplicate triggers.
     - Skip to next subscription.
  3. If sufficient balance:
     - Atomic transaction: deduct credits (idempotent via `credit_category: 'coding-plan:{providerId}:{subscriptionId}:{yearMonth}'`), advance `current_period_start/end` and `credit_renewal_at` by `billing_period_days`.
  4. If insufficient balance AND (auto-top-up not enabled OR already triggered):
     - Cancel immediately: set `status = 'canceled'`, delete BYOK key, set `canceled_at = now()`, `byok_key_id = null`.

### Cron endpoint

New API route: `src/app/api/cron/coding-plans-billing/route.ts`

- Vercel cron config in `vercel.json` (or equivalent).
- Secured with cron secret header validation (same pattern as KiloClaw cron).

---

## Step 5: tRPC Router

New file: `src/routers/coding-plans-router.ts`

Register in `src/routers/root-router.ts` as `codingPlans: codingPlansRouter`.

### User endpoints:

| Method   | Name                | Input                    | Description                                                                                                                                       |
| -------- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| query    | `catalog`           | none                     | Returns the plan catalog with pricing (spec §1.1, §1.2). Calls `getCodingPlanCatalog()`. Converts microdollars to Kilo Credits via pricing layer. |
| query    | `listSubscriptions` | none                     | Returns all coding plan subscriptions for the authenticated user (active + canceled).                                                             |
| mutation | `subscribe`         | `{ providerId: string }` | Calls `subscribeToCodingPlan()`. Returns subscription record.                                                                                     |
| mutation | `cancel`            | `{ providerId: string }` | Calls `cancelCodingPlanSubscription()`. Sets cancel-at-period-end.                                                                                |

### Admin endpoints (nested under admin router or `codingPlans` router with `adminProcedure`):

| Method   | Name                     | Input                                    | Description                                                               |
| -------- | ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------- |
| query    | `keyInventory`           | `{ providerId?: string }`                | Lists key inventory counts (available/assigned per provider).             |
| mutation | `uploadKeys`             | `{ providerId: string, keys: string[] }` | Encrypts and inserts pre-purchased keys into `coding_plan_key_inventory`. |
| mutation | `cancelUserSubscription` | `{ userId: string, providerId: string }` | Admin immediate cancel. Calls `cancelCodingPlanImmediately()`.            |

---

## Step 6: GDPR Soft-Delete Updates

In `src/lib/user.ts:softDeleteUser`:

**Existing behavior**: BYOK keys are already deleted on line 604 (`await tx.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, userId))`). This handles spec §5.2.

**New additions** (within the existing transaction, BEFORE the `byok_api_keys` deletion):

1. Cancel all coding plan subscriptions:

   ```typescript
   await tx
     .update(coding_plan_subscriptions)
     .set({ status: 'canceled', canceled_at: sql`now()`, byok_key_id: null })
     .where(eq(coding_plan_subscriptions.user_id, userId));
   ```

2. Auto-cancel without blocking — user is deleting their account, so just cancel everything. No precondition check that blocks deletion (unlike Kilo Pass/KiloClaw which require the user to cancel first).

**New test** in `src/lib/user.test.ts`: Verify that coding plan subscriptions are canceled and BYOK keys are removed when a user is soft-deleted.

---

## Step 7: Model Visibility Integration

No new work needed. The existing `getCodingPlanModelsForUser(userId)` in `src/lib/providers/coding-plans/index.ts` already checks for BYOK keys to determine which coding plan models to show. Since the purchase flow creates a BYOK entry, model visibility is automatically gated by subscription status. When a subscription is canceled and the BYOK key is removed, the models automatically stop appearing for the user.

---

## Step 8: Tests

### Unit tests: `src/lib/coding-plans/index.test.ts`

1. **Happy path**: Subscribe → credits deducted, key assigned, BYOK entry created, subscription active.
2. **Insufficient balance**: Subscribe with low balance → rejected, no side effects.
3. **No keys available**: Subscribe when inventory is empty → rejected, no credits deducted (transaction rolled back).
4. **Idempotency**: Duplicate subscribe request → only one subscription created, only one credit deduction.
5. **Extension (spec §2.5)**: Subscribe when already subscribed to same provider → period extended (stacked), no new key assigned.
6. **Cancel at period end**: Cancel → status still active, cancel flag set. Cron sweep → canceled, BYOK key removed.
7. **Immediate cancel**: Admin immediate cancel → canceled immediately, BYOK key removed.
8. **Renewal success**: Cron deducts credits, advances period.
9. **Renewal failure — no auto-top-up**: Insufficient balance, no auto-top-up → canceled immediately, BYOK key removed.
10. **Renewal failure — auto-top-up triggered**: Insufficient balance, auto-top-up enabled → top-up triggered, subscription skipped (not canceled yet).
11. **Re-subscribe after cancellation**: Subscribe to previously canceled provider → existing row reactivated, new key assigned.
12. **Concurrent requests**: Two simultaneous subscribes → at most one succeeds (spec §2.4).
13. **Free plan (cost = 0)**: Subscribe with cost 0 → no credit deduction, key assigned, subscription active.

### GDPR test addition: `src/lib/user.test.ts`

14. **Soft-delete with coding plan**: User with active coding plan → soft-delete → subscription canceled, BYOK key removed.

### Admin tests: `src/routers/coding-plans-router.test.ts`

15. **Upload keys**: Admin uploads keys → encrypted in inventory, correct count.
16. **Key inventory query**: Returns correct available/assigned counts per provider.
17. **Catalog query**: Returns plan info with env-configured pricing. Missing env var → provider excluded.

---

## Implementation Order

| Phase | Work                                                   | Files                                                                                                   |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1     | Schema + migration                                     | `packages/db/src/schema.ts`, `packages/db/src/migrations/`                                              |
| 2     | Pricing catalog (env-driven)                           | `src/lib/coding-plans/pricing.ts`                                                                       |
| 3     | Core business logic (subscribe, cancel, extend)        | `src/lib/coding-plans/index.ts`                                                                         |
| 4     | tRPC router + root registration                        | `src/routers/coding-plans-router.ts`, `src/routers/root-router.ts`                                      |
| 5     | Billing lifecycle cron                                 | `src/lib/coding-plans/billing-lifecycle-cron.ts`, `src/app/api/cron/coding-plans-billing/route.ts`      |
| 6     | Admin endpoints (upload keys, inventory, admin cancel) | Nested in `src/routers/coding-plans-router.ts` with `adminProcedure`                                    |
| 7     | GDPR soft-delete updates                               | `src/lib/user.ts`                                                                                       |
| 8     | Tests                                                  | `src/lib/coding-plans/index.test.ts`, `src/lib/user.test.ts`, `src/routers/coding-plans-router.test.ts` |

---

## New Environment Variables

| Variable                            | Example   | Description                                                      |
| ----------------------------------- | --------- | ---------------------------------------------------------------- |
| `CODING_PLAN_PRICE_BYTEPLUS_CODING` | `4990000` | Price in microdollars for BytePlus Coding Plan per 30-day period |
| `CODING_PLAN_PRICE_KIMI_CODING`     | `4990000` | Price in microdollars for Kimi Code per 30-day period            |
| `CODING_PLAN_PRICE_ZAI_CODING`      | `4990000` | Price in microdollars for Z.AI Coding Plan per 30-day period     |

Omitting a variable disables that provider from the catalog. Setting to `0` makes it free.
