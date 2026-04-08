# Fix recomputeBalance to account for paid Exa usage

## Problem

`deductFromBalance()` in `exa-usage.ts` mutates the cached balance columns directly:

- **Personal**: increments `kilocode_users.microdollars_used`
- **Org**: calls `ingestOrganizationTokenUsage` which increments `organizations.microdollars_used`

Neither path inserts into `microdollar_usage`. The recompute functions (`recomputeUserBalances.ts:75` and `recomputeOrganizationBalances.ts:57`) rebuild balances exclusively from `microdollar_usage`, so every billed Exa request vanishes the next time recompute runs.

## Approach

Rather than routing Exa through `microdollar_usage` (wrong data shape, pollutes LLM analytics), make the recompute functions also include charged Exa usage from `exa_usage_log`.

`exa_usage_log` already stores `{cost_microdollars, created_at, charged_to_balance, kilo_user_id, organization_id}` — exactly the shape the merge-sort algorithm needs (`{cost, created_at}`).

## Changes

### 1. `recomputeUserBalances.ts` — include Exa charged records in `fetchUserBalanceData()`

Add a second query alongside the existing `microdollar_usage` query:

```ts
import { exa_usage_log } from '@kilocode/db/schema';

const exaUsageRecords = await db
  .select({
    cost: exa_usage_log.cost_microdollars,
    created_at: exa_usage_log.created_at,
  })
  .from(exa_usage_log)
  .where(
    and(
      eq(exa_usage_log.kilo_user_id, userId),
      eq(exa_usage_log.charged_to_balance, true),
      isNull(exa_usage_log.organization_id)
    )
  )
  .orderBy(asc(exa_usage_log.created_at));
```

Then merge-sort the two sorted arrays before returning:

```ts
const usageRecords = mergeSortedByCreatedAt(llmUsageRecords, exaUsageRecords);
return { user, usageRecords, creditTransactions };
```

`computeUserBalanceUpdates` and `applyUserBalanceUpdates` need zero changes — they already work on the generic `{cost, created_at}[]` shape.

Update the docstring postcondition:

```
- microdollars_used = sum(microdollar_usage) + sum(exa charged usage)
```

### 2. `recomputeOrganizationBalances.ts` — same pattern

Add a second query for org Exa charged records:

```ts
const exaUsageRecords = await db
  .select({
    cost: exa_usage_log.cost_microdollars,
    created_at: exa_usage_log.created_at,
  })
  .from(exa_usage_log)
  .where(
    and(
      eq(exa_usage_log.organization_id, args.organizationId),
      eq(exa_usage_log.charged_to_balance, true)
    )
  )
  .orderBy(asc(exa_usage_log.created_at));
```

Same merge-sort before the baseline computation loop.

### 3. Add a shared `mergeSortedByCreatedAt` helper

A small utility (either in a shared module or inline) that merges two sorted `{cost: number, created_at: string}[]` arrays:

```ts
function mergeSortedByCreatedAt(
  a: { cost: number; created_at: string }[],
  b: { cost: number; created_at: string }[]
): { cost: number; created_at: string }[] {
  const result = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].created_at <= b[j].created_at) result.push(a[i++]);
    else result.push(b[j++]);
  }
  while (i < a.length) result.push(a[i++]);
  while (j < b.length) result.push(b[j++]);
  return result;
}
```

Both recompute files can import this. If we don't want a new file, it can be defined as a local function in each file (they're short enough).

### 4. Tests

**`recomputeUserBalances.test.ts`**:

- Add a test that inserts `exa_usage_log` rows with `charged_to_balance = true` alongside normal `microdollar_usage` rows, then verifies `recomputeUserBalances` includes both in `microdollars_used`.
- Add a pure test for `computeUserBalanceUpdates` with a pre-merged usage array that includes both LLM and Exa records interleaved by time, verifying baselines are computed correctly.

**`recomputeOrganizationBalances.test.ts`**:

- Same pattern — insert Exa charged usage for an org and verify recompute includes it.

## Not in scope

**Reliability of `exa_usage_log` inserts**: The audit log insert is currently fire-and-forget (`try/catch` that swallows errors at `exa-usage.ts:106-118`). If it fails, the balance deduction happens but no log row exists, so recompute would miss it. This is a pre-existing design tradeoff (partition might not exist). The risk is low because:

- Partition maintenance runs monthly and creates partitions ahead of time
- `exa_monthly_usage` (the counter) is always reliably written and could serve as a cross-check

If we want to tighten this later, the options are:

1. Make log inserts required when `charged_to_balance = true` (rethrow on failure)
2. Add a cross-check in recompute: compare `sum(exa_usage_log.cost WHERE charged)` vs `sum(exa_monthly_usage.total_charged)` and log a warning on mismatch
