# Slow Query Analysis: `microdollar_usage`

## Table Overview

The `microdollar_usage` table stores per-request billing records for every LLM API call. It is a high-write, high-volume append-only table that grows linearly with platform traffic.

**Existing indexes:**

| Index                                   | Columns                      | Notes                                        |
| --------------------------------------- | ---------------------------- | -------------------------------------------- |
| PK                                      | `id` (uuid)                  |                                              |
| `idx_created_at`                        | `created_at`                 |                                              |
| `idx_abuse_classification`              | `abuse_classification`       |                                              |
| `idx_kilo_user_id_created_at2`          | `(kilo_user_id, created_at)` | Composite                                    |
| `idx_microdollar_usage_organization_id` | `organization_id`            | Partial: `WHERE organization_id IS NOT NULL` |

There is also a `microdollar_usage_view` (12 LEFT JOINs to metadata + lookup tables) that several admin queries use.

---

## Top 10 Queries Most Likely to Be Slow

Ranked by estimated query cost based on: table scan size, lack of covering indexes, JOIN complexity, aggregation over large result sets, and absence of time-bounding.

---

### 1. Profile usage by date (unbounded full-history scan)

**File:** `src/app/api/profile/usage/route.ts:23-79`

```sql
SELECT DATE(created_at), SUM(cost), COUNT(*), SUM(input_tokens), ...
FROM microdollar_usage
WHERE kilo_user_id = ? [AND organization_id IS NULL]
GROUP BY DATE(created_at)
ORDER BY DATE(created_at) DESC
```

**Why it's slow:** No time bound at all. For power users this scans their _entire usage history_ to aggregate by day. The composite index `(kilo_user_id, created_at)` helps with filtering but the query still must aggregate over potentially hundreds of thousands of rows per user. The `DATE()` function call prevents index-only scans and forces a sort. Every column being summed (cost, input_tokens, output_tokens, cache_write/hit_tokens) requires fetching the full row from heap.

---

### 2. Recompute user balances (full user history, no aggregation)

**File:** `src/lib/recomputeUserBalances.ts:75-88`

```sql
SELECT cost, created_at
FROM microdollar_usage
WHERE kilo_user_id = ? AND cost > 0 AND organization_id IS NULL
ORDER BY created_at ASC
```

**Why it's slow:** Returns _every single row_ for a user where cost > 0, ordered by time. For heavy users this could be tens or hundreds of thousands of individual rows transferred to the application. The `cost > 0` filter and `organization_id IS NULL` filter are not part of any index, so they must be applied after the index scan. The entire result set is materialized in Node.js memory.

---

### 3. Recompute organization balances (full org history, no aggregation)

**File:** `src/lib/recomputeOrganizationBalances.ts:57-66`

```sql
SELECT cost, created_at
FROM microdollar_usage
WHERE organization_id = ? AND cost > 0
ORDER BY created_at ASC
```

**Why it's slow:** Same problem as user recompute but for orgs. The partial index on `organization_id` helps with the WHERE clause but doesn't cover `created_at` for ordering, so a sort is required. Large organizations could have millions of usage records. All rows are fetched into memory.

---

### 4. Abuse examples browser (view + LEFT JOIN + EXISTS subqueries + OFFSET pagination)

**File:** `src/app/admin/api/abuse/examples/route.ts:163-184`

```sql
SELECT view.*, users.*
FROM microdollar_usage_view view  -- 12 LEFT JOINs inside
LEFT JOIN kilocode_users ON ...
WHERE abuse_classification > 0
  AND user_prompt_prefix IS NOT NULL
  [AND many optional dynamic filters]
  [AND EXISTS (SELECT 1 FROM credit_transactions ...)]
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

**Why it's slow:** Queries through the `microdollar_usage_view` (which itself is 12 LEFT JOINs), then adds another LEFT JOIN to `kilocode_users`, plus correlated EXISTS subqueries against `credit_transactions`. The `abuse_classification` index exists but with dynamic filters on columns from the joined user table, the planner may not use it efficiently. OFFSET-based pagination degrades as page number increases. The view materialization alone is expensive.

---

### 5. Heuristic analysis grouped (view + CROSS JOIN LATERAL + dynamic GROUP BY)

**File:** `src/app/admin/api/users/heuristic-analysis/grouped/route.ts:69-89`

```sql
SELECT ..., computed.likely_abuse, COUNT(*), SUM(cost), ...
FROM microdollar_usage_view                    -- 12 LEFT JOINs
CROSS JOIN LATERAL (SELECT CASE ... END) computed
WHERE kilo_user_id = ?
GROUP BY <dynamic dimensions>, computed.likely_abuse
ORDER BY <dynamic>
```

**Why it's slow:** Full scan of the view (12 JOINs) for a user's entire history with no time bound. The CROSS JOIN LATERAL adds overhead per row. Dynamic GROUP BY dimensions (day/week/month/userAgent/model) prevent the planner from optimizing. No LIMIT. For a heavy user with metadata across many dimensions, this can be very expensive.

---

### 6. Heuristic analysis raw (view + paginated)

**File:** `src/app/admin/api/users/heuristic-analysis/raw/route.ts:32-43`

```sql
-- Count query:
SELECT COUNT(*) FROM microdollar_usage_view WHERE kilo_user_id = ?

-- Data query:
SELECT * FROM microdollar_usage_view
WHERE kilo_user_id = ?
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

**Why it's slow:** The COUNT query must scan the entire view (12 JOINs) for the user. The data query also goes through the view. Two separate full-view scans per request. OFFSET pagination means later pages are increasingly expensive.

---

### 7. Organization usage timeseries (JOIN + multi-dimensional GROUP BY)

**File:** `src/routers/organizations/organization-usage-details-router.ts:167-198`

```sql
SELECT DATE_TRUNC('hour'|'day', created_at), user_name, user_email,
       model, provider, project_id,
       SUM(cost), SUM(input_tokens), SUM(output_tokens), COUNT(id)
FROM microdollar_usage
INNER JOIN kilocode_users ON ...
WHERE organization_id = ? AND created_at BETWEEN ? AND ?
GROUP BY timebucket, user_name, user_email, model, provider, project_id
ORDER BY timebucket
```

**Why it's slow:** 6-column GROUP BY produces a very high cardinality result set (users x models x providers x projects x time buckets). The JOIN to `kilocode_users` adds I/O. For large orgs over wide time ranges (the caller allows up to 1 year), this can aggregate millions of rows into thousands of groups. The partial index on `organization_id` doesn't include `created_at`, so range filtering requires heap access.

---

### 8. Organization daily usage details (JOIN + GROUP BY + optional filters)

**File:** `src/routers/organizations/organization-usage-details-router.ts:316-339`

```sql
SELECT DATE(created_at), user_name, user_email, [model],
       SUM(cost), SUM(tokens), COUNT(id)
FROM microdollar_usage
INNER JOIN kilocode_users ON ...
WHERE organization_id = ? [AND created_at >= ?] [AND kilo_user_id = ?]
GROUP BY DATE(created_at), user_name, user_email, [model]
ORDER BY DATE(created_at) DESC
```

**Why it's slow:** Similar to #7 but without an upper time bound on `created_at` (only optional `>=` filter). Without a time range, this scans the entire org history. The `DATE()` function prevents index usage for ordering. High-cardinality GROUP BY.

---

### 9. Gateway error rate (view scan, hot path, 10-minute window)

**File:** `src/lib/providers/gateway-error-rate.ts:8-18`

```sql
SELECT provider, 1.0 * COUNT(*) FILTER(WHERE has_error) / COUNT(*)
FROM microdollar_usage_view
WHERE created_at >= now() - interval '10 minutes'
  AND is_user_byok = false
  AND provider IN ('openrouter', 'vercel')
GROUP BY provider
```

**Why it's slow:** Queries through the full 12-JOIN view when it only needs columns from `microdollar_usage` and `microdollar_usage_metadata` (`is_user_byok`). The 10-minute window limits rows, but during peak traffic this could still be thousands of rows going through 12 LEFT JOINs unnecessarily. This is on the **hot path** (called on every LLM request, cached 600s but with a 500ms timeout, suggesting known latency issues).

---

### 10. Abuse stats 24h (full day aggregation, no index for conditional SUM)

**File:** `src/app/admin/api/abuse/stats/route.ts:65-74`

```sql
SELECT
  SUM(CASE WHEN abuse_classification > 0 THEN cost ELSE 0 END),
  SUM(cost),
  SUM(CASE WHEN abuse_classification > 0 THEN input_tokens + output_tokens ELSE 0 END),
  SUM(input_tokens + output_tokens)
FROM microdollar_usage
WHERE created_at >= NOW() - INTERVAL '24 hours'
```

**Why it's slow:** Aggregates over all rows in the last 24 hours with no user/org scoping. During high traffic, this is a scan of potentially millions of rows. The `idx_created_at` index helps find the range but every row in that range must be fetched from heap for the conditional SUM expressions. No way to push the CASE down into the index.

---

## Three Queries with Actionable Performance Improvements

### Improvement 1: Profile usage by date -- add time bound + covering index

**File:** `src/app/api/profile/usage/route.ts:23-79`

**Problem:** Full-history scan for every user with no time limit. Aggregates 6 columns across all rows.

**Recommendations:**

1. **Add a default time bound.** Most users care about recent usage. Default to 90 days (or whatever the UI defaults to) and only scan further back if explicitly requested:

   ```typescript
   // Add to whereClause:
   gte(microdollar_usage.created_at, sql`NOW() - INTERVAL '90 days'`);
   ```

   This alone could reduce rows scanned by 10-100x for long-time users.

2. **Add a composite index that covers the common `personal` view type:**

   ```sql
   CREATE INDEX idx_mu_user_personal_created
   ON microdollar_usage (kilo_user_id, created_at)
   WHERE organization_id IS NULL;
   ```

   This partial index matches the most common query path (`viewType = 'personal'`) exactly, letting Postgres do an index-only scan for the filter and avoid testing `organization_id IS NULL` against every row.

3. **Consider a materialized daily rollup table** if the time-bounding approach isn't sufficient. The query groups by `DATE(created_at)` already, so a daily pre-aggregation (user_id, org_id, model, date -> sums) would turn this into a lookup rather than a scan.

**Expected impact:** 10-100x reduction in rows scanned. The time bound alone is the biggest win.

---

### Improvement 2: Gateway error rate -- bypass the view

**File:** `src/lib/providers/gateway-error-rate.ts:8-18`

**Problem:** Uses `microdollar_usage_view` (12 LEFT JOINs) when it only needs `provider`, `has_error`, and `created_at` from `microdollar_usage`, plus `is_user_byok` from `microdollar_usage_metadata`. This is on the hot path with a 500ms timeout already in place.

**Recommendation:** Query the base tables directly instead of the view:

```typescript
const { rows } = await db.execute(sql`
  SELECT
    mu.provider AS "gateway",
    1.0 * COUNT(*) FILTER (WHERE mu.has_error = true) / COUNT(*) AS "errorRate"
  FROM microdollar_usage mu
  INNER JOIN microdollar_usage_metadata meta ON mu.id = meta.id
  WHERE mu.created_at >= NOW() - INTERVAL '10 minutes'
    AND meta.is_user_byok = false
    AND mu.provider IN ('openrouter', 'vercel')
  GROUP BY mu.provider
`);
```

This eliminates 11 unnecessary LEFT JOINs (to `http_user_agent`, `http_ip`, `vercel_ip_city`, etc.) that contribute nothing to the result. The planner can use `idx_created_at` on `microdollar_usage` and the PK join to `microdollar_usage_metadata` is cheap.

Additionally, consider a **partial composite index**:

```sql
CREATE INDEX idx_mu_gateway_error_rate
ON microdollar_usage (created_at, provider, has_error)
WHERE provider IN ('openrouter', 'vercel');
```

**Expected impact:** Eliminating the 11 JOINs should reduce execution time significantly. The existing 500ms timeout + 600s cache suggests this query is already known to be slow; this fix addresses the root cause rather than working around it.

---

### Improvement 3: Recompute user balances -- use SUM instead of fetching all rows

**File:** `src/lib/recomputeUserBalances.ts:75-88`

**Problem:** Fetches every individual usage row for a user into Node.js memory to sum them up. For heavy users this could be hundreds of thousands of rows.

**Recommendation:** The recompute logic walks through usage records chronologically alongside credit transactions to calculate running balances. However, if the goal is just to verify `microdollars_used`, this can be done with a single `SUM(cost)` aggregate:

```sql
SELECT COALESCE(SUM(cost), 0)
FROM microdollar_usage
WHERE kilo_user_id = ? AND cost > 0 AND organization_id IS NULL
```

If the row-by-row walk is genuinely needed (e.g., to compute per-transaction baselines), consider:

1. **Add a partial covering index** to speed up the scan:

   ```sql
   CREATE INDEX idx_mu_user_recompute
   ON microdollar_usage (kilo_user_id, created_at, cost)
   WHERE cost > 0 AND organization_id IS NULL;
   ```

   This makes the query index-only (no heap fetches needed) since it covers all selected and filtered columns.

2. **Use cursor-based streaming** instead of loading all rows into memory at once, to reduce peak memory usage.

3. **Long-term: checkpoint-based recompute.** Store the last-verified cumulative cost + timestamp, and only scan rows after that checkpoint. This bounds the scan to new data since last verification.

**Expected impact:** The covering index alone should make the query 2-5x faster by eliminating heap fetches. The checkpoint approach would bound the scan size regardless of user age.

---

## Summary

| Rank | Query                      | Location                                   | Root Cause                         | Actionable?                 |
| ---- | -------------------------- | ------------------------------------------ | ---------------------------------- | --------------------------- |
| 1    | Profile usage by date      | `profile/usage/route.ts:23`                | Unbounded full-history scan        | **Yes**                     |
| 2    | Recompute user balances    | `recomputeUserBalances.ts:75`              | All rows fetched to memory         | **Yes**                     |
| 3    | Recompute org balances     | `recomputeOrganizationBalances.ts:57`      | All rows fetched to memory         | Similar to #2               |
| 4    | Abuse examples browser     | `abuse/examples/route.ts:163`              | View + JOINs + EXISTS + OFFSET     | Admin-only, lower priority  |
| 5    | Heuristic analysis grouped | `heuristic-analysis/grouped/route.ts:69`   | View + unbounded + dynamic GROUP   | Admin-only                  |
| 6    | Heuristic analysis raw     | `heuristic-analysis/raw/route.ts:32`       | Double view scan + COUNT           | Admin-only                  |
| 7    | Org usage timeseries       | `organization-usage-details-router.ts:167` | 6-col GROUP BY + wide ranges       | Bounded by date range input |
| 8    | Org daily usage details    | `organization-usage-details-router.ts:316` | Unbounded + high-cardinality GROUP | Could add time bound        |
| 9    | Gateway error rate         | `gateway-error-rate.ts:8`                  | 12-JOIN view on hot path           | **Yes**                     |
| 10   | Abuse stats 24h            | `abuse/stats/route.ts:65`                  | Full 24h table scan                | Admin-only, tolerable       |
