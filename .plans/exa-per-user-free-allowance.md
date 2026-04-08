# Per-User Free Allowance for Exa

## Problem

The current Exa free tier is a global constant (`EXA_MONTHLY_ALLOWANCE_MICRODOLLARS = 10_000_000`). There's no way to give different users different allowances, and no record of what allowance was in effect for a given month.

## Design

1. Add a `free_allowance_microdollars` column to `exa_monthly_usage` that records the free allowance granted for that user-month.
2. Add a pure helper function `getExaFreeAllowanceMicrodollars(date, user)` that computes the allowance. Today it returns $10 for everyone; tomorrow it can return different amounts based on user attributes.
3. The allowance is **locked in on the first request of the month**. Once the counter row is created, subsequent requests use the stored value — even if the helper's logic changes mid-month.

### Pre-check flow

```
{ usage, freeAllowance } = getExaMonthlyUsage(userId)
                                   ↓
                          row exists?
                         /          \
                       yes           no
                       ↓              ↓
              use stored           compute via helper:
              freeAllowance        getExaFreeAllowanceMicrodollars(now, user)
                       \            /
                        ↓          ↓
                  isPaidRequest = usage >= allowance
```

### Record flow (in `after()`)

`recordExaUsage({ ..., freeAllowanceMicrodollars })` upserts the counter row. The `free_allowance_microdollars` column is set on INSERT only — the ON CONFLICT clause does **not** update it.

## Changes

### 1. Schema: `packages/db/src/schema.ts`

Add column to `exa_monthly_usage`:

```typescript
free_allowance_microdollars: bigint({ mode: 'number' }).notNull().default(10_000_000),
```

The default of `10_000_000` ($10) keeps existing rows valid after migration and matches the current behavior.

### 2. Migration

`pnpm drizzle generate` — produces a single `ALTER TABLE ADD COLUMN ... DEFAULT 10000000`. No backfill needed since the default covers existing rows.

### 3. Helper: `apps/web/src/lib/exa-usage.ts`

New exported pure function:

```typescript
import type { KilocodeUser } from '@kilocode/db/schema';

/**
 * Computes the free Exa allowance in microdollars for a user in a given month.
 * Locked in on the first request of the month — see getExaMonthlyUsage.
 */
export function getExaFreeAllowanceMicrodollars(_date: Date, _user: KilocodeUser): number {
  return EXA_MONTHLY_ALLOWANCE_MICRODOLLARS;
}
```

`EXA_MONTHLY_ALLOWANCE_MICRODOLLARS` stays in `constants.ts` as the default. The helper is the single extension point for per-user/per-date logic in the future.

### 4. Update `getExaMonthlyUsage`

Change return type to include the stored allowance:

```typescript
export async function getExaMonthlyUsage(
  userId: string
): Promise<{ usage: number; freeAllowance: number | null }> {
  const result = await db
    .select({
      total: exa_monthly_usage.total_cost_microdollars,
      freeAllowance: exa_monthly_usage.free_allowance_microdollars,
    })
    .from(exa_monthly_usage)
    .where(
      sql`${exa_monthly_usage.kilo_user_id} = ${userId}
        AND ${exa_monthly_usage.month} = date_trunc('month', now())::date`
    )
    .limit(1);

  return {
    usage: result[0]?.total ?? 0,
    freeAllowance: result[0]?.freeAllowance ?? null,
  };
}
```

`null` means no row exists yet for this month → caller must compute from the helper.

### 5. Update `recordExaUsage`

Add `freeAllowanceMicrodollars` to params. Include in INSERT, exclude from ON CONFLICT UPDATE:

```typescript
export async function recordExaUsage(params: {
  userId: string;
  organizationId: string | undefined;
  path: string;
  costMicrodollars: number;
  chargedToBalance: boolean;
  freeAllowanceMicrodollars: number; // new
}): Promise<void> {
```

Upsert SQL:

```sql
INSERT INTO exa_monthly_usage (
  kilo_user_id, month, total_cost_microdollars, total_charged_microdollars,
  request_count, free_allowance_microdollars
)
VALUES ($userId, date_trunc('month', now())::date, $cost, $charged, 1, $allowance)
ON CONFLICT (kilo_user_id, month) DO UPDATE SET
  total_cost_microdollars = exa_monthly_usage.total_cost_microdollars + $cost,
  total_charged_microdollars = exa_monthly_usage.total_charged_microdollars + $charged,
  request_count = exa_monthly_usage.request_count + 1,
  updated_at = now()
  -- NOTE: free_allowance_microdollars is NOT updated — locked in on first INSERT
```

### 6. Update route: `apps/web/src/app/api/exa/[...path]/route.ts`

```typescript
const { usage: monthlyUsage, freeAllowance: storedAllowance } = await getExaMonthlyUsage(user.id);
const allowance = storedAllowance ?? getExaFreeAllowanceMicrodollars(new Date(), user);
const isPaidRequest = monthlyUsage >= allowance;

if (isPaidRequest) {
  const { balance } = await getBalanceAndOrgSettings(organizationId, user);
  if (balance <= 0) {
    return NextResponse.json(
      {
        error: 'Exa free allowance exhausted and no credit balance available',
        monthlyAllowance: `$${(allowance / 1_000_000).toFixed(2)}`,
        used: `$${(monthlyUsage / 1_000_000).toFixed(2)}`,
      },
      { status: 402 }
    );
  }
}
```

And in the `after()` callback:

```typescript
await recordExaUsage({
  userId: user.id,
  organizationId,
  path: exaPath,
  costMicrodollars,
  chargedToBalance: isPaidRequest,
  freeAllowanceMicrodollars: allowance,
});
```

### 7. Tests: `apps/web/src/lib/exa-usage.test.ts`

- Update all `getExaMonthlyUsage` assertions for the new `{ usage, freeAllowance }` return shape.
- Update all `recordExaUsage` calls to include `freeAllowanceMicrodollars`.
- Add: verify `free_allowance_microdollars` is stored on the counter row after `recordExaUsage`.
- Add: verify `free_allowance_microdollars` is NOT overwritten on subsequent requests (lock-in).
- Add: `getExaFreeAllowanceMicrodollars` returns the default constant (trivial but documents the contract).

### 8. Update plan

Update `.plans/exa-monthly-allowance.md` to reflect the new column and helper function.

## Files touched

| File                                          | Change                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema.ts`                   | Add `free_allowance_microdollars` column to `exa_monthly_usage`                                                  |
| Migration (generated)                         | `ALTER TABLE ADD COLUMN` with default                                                                            |
| `apps/web/src/lib/exa-usage.ts`               | New `getExaFreeAllowanceMicrodollars`; update return type of `getExaMonthlyUsage`; add param to `recordExaUsage` |
| `apps/web/src/app/api/exa/[...path]/route.ts` | Use helper + stored allowance instead of global constant                                                         |
| `apps/web/src/lib/exa-usage.test.ts`          | Update for new shapes + add allowance-specific tests                                                             |
| `.plans/exa-monthly-allowance.md`             | Document the new column and helper                                                                               |
