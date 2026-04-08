# Exa $10/month Free Allowance + Credit Billing

## Problem

The Exa proxy (`apps/web/src/app/api/exa/[...path]/route.ts`) authenticates users but doesn't track or limit usage. Every request uses Kilo's shared Exa API key with zero cost accountability. Exa returns costs in the response body (`costDollars.total`), and we currently just `console.log` them.

## Design

**Free tier + overage model:**

- **≤ $10/month per user:** free — no impact on Kilo balance.
- **> $10/month per user:** charged to the user's (or their org's) Kilo credit balance, same as LLM usage.

The $10 free allowance is per-user regardless of org membership. When a user exceeds it, the overage is billed to whichever entity they're acting on behalf of (personal account or org, determined by the `X-KiloCode-OrganizationId` header — same as OpenRouter).

Available to **all authenticated users** regardless of plan.

### How it works

1. **Pre-request:** read user's monthly total from `exa_monthly_usage` counter table (single-row lookup).
   - If under $10 → **free request**, proceed.
   - If ≥ $10 → **paid request**, check Kilo balance via `getBalanceAndOrgSettings()`. Reject if no credits.
2. **Proxy** the request to Exa (with `stream` stripped from the body).
3. **Post-request** (async in `after()`):
   - Upsert the `exa_monthly_usage` counter (atomic increment).
   - Append to `exa_usage_log` (per-request audit trail).
   - If the request was **paid**, also deduct from Kilo credits via `logMicrodollarUsage()`.

**Edge case — request that crosses the $10 threshold:** if the user was at $9.99 and the request costs $0.05, the entire request is treated as free. The max "free overage" is one request's cost (~$0.001–$0.01), which is negligible.

### Storage strategy: counter + partitioned log

To avoid the unbounded growth problem that `microdollar_usage` suffers from:

- **`exa_monthly_usage`** — pre-aggregated counter table. One row per user per month. The hot-path pre-request check reads this (single indexed row lookup, always O(1)). Table size bounded at `users × months` — trivially small.
- **`exa_usage_log`** — per-request append-only audit trail, range-partitioned by month on `created_at`. Never read in the hot path. Old partitions can be dropped instantly (`DROP TABLE exa_usage_log_2025_10`) with no DELETE/VACUUM overhead. Partition creation automated via a cron job or on-demand in the `after()` callback.

## Changes

### 1. Schema: two new tables

**File:** `packages/db/src/schema.ts`

#### Counter table (hot path)

```typescript
export const exa_monthly_usage = pgTable(
  'exa_monthly_usage',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    kilo_user_id: text().notNull(),
    month: date({ mode: 'string' }).notNull(), // first day of month, e.g. '2026-04-01'
    total_cost_microdollars: bigint({ mode: 'number' }).notNull().default(0),
    total_charged_microdollars: bigint({ mode: 'number' }).notNull().default(0), // portion charged to balance
    request_count: integer().notNull().default(0),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [uniqueIndex('idx_exa_monthly_usage_user_month').on(table.kilo_user_id, table.month)]
);
```

#### Audit log table (partitioned, not in hot path)

The partitioned parent table and initial partitions are created via hand-written migration SQL (drizzle-kit can't generate partition DDL). The Drizzle schema definition is for type inference only:

```typescript
export const exa_usage_log = pgTable(
  'exa_usage_log',
  {
    id: uuid()
      .notNull()
      .default(sql`pg_catalog.gen_random_uuid()`),
    kilo_user_id: text().notNull(),
    organization_id: uuid(),
    path: text().notNull(),
    cost_microdollars: bigint({ mode: 'number' }).notNull(),
    charged_to_balance: boolean().notNull().default(false),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [index('idx_exa_usage_log_user_created').on(table.kilo_user_id, table.created_at)]
);
```

The migration appends hand-written SQL after the drizzle-generated DDL:

```sql
-- Convert to partitioned table
ALTER TABLE exa_usage_log RENAME TO exa_usage_log_old;

CREATE TABLE exa_usage_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kilo_user_id text NOT NULL,
  organization_id uuid,
  path text NOT NULL,
  cost_microdollars bigint NOT NULL,
  charged_to_balance boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_exa_usage_log_user_created ON exa_usage_log (kilo_user_id, created_at);

-- Create partitions for current and next month
CREATE TABLE exa_usage_log_2026_04 PARTITION OF exa_usage_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE exa_usage_log_2026_05 PARTITION OF exa_usage_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

DROP TABLE exa_usage_log_old;
```

New partitions are created by a monthly cron job (same pattern as partition maintenance in other systems). A simple approach: the `after()` callback creates the partition on-demand with `CREATE TABLE IF NOT EXISTS ... PARTITION OF ...` — PostgreSQL's `IF NOT EXISTS` makes this idempotent and safe under concurrency.

### 2. Constants

**File:** `apps/web/src/lib/constants.ts`

```typescript
/** $10/month free Exa allowance in microdollars */
export const EXA_MONTHLY_ALLOWANCE_MICRODOLLARS = 10_000_000;
```

### 3. Usage helpers: `apps/web/src/lib/exa-usage.ts`

```typescript
/**
 * Returns the user's total Exa spend (microdollars) for the current calendar month.
 * Single-row lookup on the counter table — always O(1).
 */
export async function getExaMonthlyUsage(userId: string): Promise<number> { ... }

/**
 * Records a single Exa request:
 * 1. Upserts exa_monthly_usage counter (atomic increment).
 * 2. Appends to exa_usage_log (audit trail).
 * 3. If chargedToBalance, deducts from Kilo credits.
 */
export async function recordExaUsage(params: {
  userId: string;
  organizationId: string | undefined;
  path: string;
  costMicrodollars: number;
  chargedToBalance: boolean;
}): Promise<void> { ... }
```

`getExaMonthlyUsage` queries:

```sql
SELECT COALESCE(total_cost_microdollars, 0)
FROM exa_monthly_usage
WHERE kilo_user_id = $userId AND month = date_trunc('month', now())
```

`recordExaUsage`:

1. Upserts `exa_monthly_usage`:
   ```sql
   INSERT INTO exa_monthly_usage (kilo_user_id, month, total_cost_microdollars, total_charged_microdollars, request_count)
   VALUES ($userId, date_trunc('month', now()), $cost, $charged, 1)
   ON CONFLICT (kilo_user_id, month) DO UPDATE SET
     total_cost_microdollars = exa_monthly_usage.total_cost_microdollars + $cost,
     total_charged_microdollars = exa_monthly_usage.total_charged_microdollars + $charged,
     request_count = exa_monthly_usage.request_count + 1,
     updated_at = now()
   ```
2. Inserts into `exa_usage_log` (fire-and-forget, failure here shouldn't block billing).
3. If `chargedToBalance` is true, calls the existing billing functions:
   - `insertUsageRecord()` to write to `microdollar_usage` + increment `kilocode_users.microdollars_used`.
   - `ingestOrganizationTokenUsage()` if `organizationId` is set, to update org balance + daily usage tracking.

### 4. Update the route: `apps/web/src/app/api/exa/[...path]/route.ts`

#### a. Disable streaming to guarantee cost tracking

Parse the request body, strip the `stream` property, and re-serialize before forwarding to Exa. This ensures every response is `application/json` with `costDollars` — no billing gaps.

```typescript
const requestBody = await request.json();
delete requestBody.stream;
const forwardBody = JSON.stringify(requestBody);
```

The existing `isStreaming` / `response.clone()` branching can be removed since the response is always JSON now.

#### b. Extract org context from auth

Change:

```typescript
const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
```

To:

```typescript
const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
```

#### c. Pre-request: check allowance + balance

After auth, before `fetch`:

```typescript
const monthlyUsage = await getExaMonthlyUsage(user.id);
const isPaidRequest = monthlyUsage >= EXA_MONTHLY_ALLOWANCE_MICRODOLLARS;

if (isPaidRequest) {
  const { balance } = await getBalanceAndOrgSettings(organizationId, user);
  if (balance <= 0) {
    return NextResponse.json(
      {
        error: 'Exa free allowance exhausted and no credit balance available',
        monthlyAllowance: '$10.00',
        used: `$${(monthlyUsage / 1_000_000).toFixed(2)}`,
      },
      { status: 402 }
    );
  }
}
```

#### d. Post-request: record usage + optionally bill

Replace the existing `after()` block (the `isStreaming` check is no longer needed since we force JSON responses):

```typescript
const cloned = response.clone();
after(async () => {
  try {
    const body: unknown = await cloned.json();
    const costDollars = (body as { costDollars?: { total?: number } })?.costDollars?.total;
    if (costDollars !== undefined && costDollars > 0 && response.status < 400) {
      const costMicrodollars = Math.round(costDollars * 1_000_000);
      await recordExaUsage({
        userId: user.id,
        organizationId,
        path: exaPath,
        costMicrodollars,
        chargedToBalance: isPaidRequest,
      });
    }
  } catch {
    // Response wasn't JSON — nothing to log
  }
});
```

### 5. Partition maintenance

A Vercel cron endpoint (e.g., `apps/web/src/app/api/cron/exa-partition-maintenance/route.ts`) runs monthly to create the next month's partition and optionally drop partitions older than N months:

```sql
-- Create next month's partition
CREATE TABLE IF NOT EXISTS exa_usage_log_2026_06
  PARTITION OF exa_usage_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Drop old partitions (e.g., 6-month retention)
DROP TABLE IF EXISTS exa_usage_log_2025_10;
```

Alternatively, the `recordExaUsage` function itself can `CREATE TABLE IF NOT EXISTS` the current partition on every insert — PostgreSQL makes this idempotent and safe under concurrency. The cron job then only handles dropping old partitions.

### 6. Tests

**File:** `apps/web/src/lib/exa-usage.test.ts` — unit tests:

- `getExaMonthlyUsage` returns 0 when no usage
- `getExaMonthlyUsage` reads from counter table (not log)
- `recordExaUsage` upserts counter + appends to log
- `recordExaUsage` with `chargedToBalance: true` also deducts from Kilo credits
- Counter correctly accumulates across multiple requests in same month

**File:** `apps/web/src/app/api/exa/[...path]/route.test.ts` — add integration tests:

- Request succeeds (free) when under $10 limit
- Request succeeds (paid) when over $10 limit but has credits
- Request returns 402 when over $10 limit and no credits
- Cost is recorded after successful proxy (free and paid paths)
- Cost is NOT recorded for upstream error responses
- Org context is threaded through from `X-KiloCode-OrganizationId` header
- `stream: true` is stripped from request body

## Race Conditions

Two concurrent requests could both pass the pre-check before either records its cost, pushing the user slightly over $10 or slightly over their credit balance. This is acceptable because:

- Individual Exa requests cost ~$0.001–$0.01
- This matches how org daily limits and LLM billing work (eventual consistency)
- The counter upsert itself is atomic (ON CONFLICT DO UPDATE with += is safe)

## What This Does NOT Do

- **No cron job needed for the free allowance.** The counter table naturally scopes to the current month.
- **No admin UI.** Usage is queryable directly from the counter table or audit log.
- **Streaming disabled.** We strip `stream` from request bodies before forwarding to Exa. The Exa SSE format doesn't include `costDollars`, so allowing streaming would create an untrackable billing gap. All responses are forced to `application/json`.

## File Summary

| File                                                           | Action                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/db/src/schema.ts`                                    | Add `exa_monthly_usage` + `exa_usage_log` tables            |
| Migration (generated + hand-edited)                            | `pnpm drizzle generate`, then append partition DDL          |
| `apps/web/src/lib/constants.ts`                                | Add `EXA_MONTHLY_ALLOWANCE_MICRODOLLARS`                    |
| `apps/web/src/lib/exa-usage.ts`                                | New: `getExaMonthlyUsage`, `recordExaUsage`                 |
| `apps/web/src/app/api/exa/[...path]/route.ts`                  | Strip streaming, add org extraction, pre-check, post-record |
| `apps/web/src/app/api/cron/exa-partition-maintenance/route.ts` | New: monthly partition create + old partition drop          |
| `apps/web/src/lib/exa-usage.test.ts`                           | New: unit tests                                             |
| `apps/web/src/app/api/exa/[...path]/route.test.ts`             | Add allowance + billing + streaming-stripped tests          |
