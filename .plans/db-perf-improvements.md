# `microdollar_usage` Query Performance Optimization

## Goal

Reduce connection-pool saturation from `microdollar_usage` reads with the lowest-risk changes first, while preserving a path to rollups only if measurement proves they are needed.

## Recommendation

Execute the bounded-query + covering-index strategy first.

Do **not** start with rollup tables or dual-write on the ingestion path. The current incident is caused by a small set of expensive interactive reads, including several with no date bound. The existing schema is missing the indexes needed for current read patterns, but the query shapes are still simple enough that bounded reads plus covering indexes may be sufficient.

Revisit rollups only if post-index measurements still show unacceptable latency or pool waiting for large tenants.

## Problem

Slow aggregation queries on `microdollar_usage` are saturating the connection pool (15 max connections). User-facing queries take 10-22s, holding connections and causing pool waiting spikes of 17k-28k during peak hours.

## Root Cause

The `microdollar_usage` table has grown large enough that per-user/org aggregation queries are expensive:

- Three high-traffic queries have **no date filter**, scanning all rows for a user/org
- Existing indexes (`kilo_user_id, created_at`) require heap fetches for every matched row to read aggregated columns (`cost`, `input_tokens`, etc.)
- No covering indexes exist for the aggregation patterns
- Org-scoped queries lack a `(organization_id, created_at)` composite index
- No `statement_timeout` is configured for interactive reads (despite `POSTGRES_MAX_QUERY_TIME` being validated at startup)
- Admin aggregation queries run on the primary instead of the replica

## Current Schema

```
packages/db/src/schema.ts (lines 566-600)
```

**Indexes:**

| Name                                    | Columns                    | Condition                           |
| --------------------------------------- | -------------------------- | ----------------------------------- |
| `idx_created_at`                        | `created_at`               | -                                   |
| `idx_abuse_classification`              | `abuse_classification`     | -                                   |
| `idx_kilo_user_id_created_at2`          | `kilo_user_id, created_at` | -                                   |
| `idx_microdollar_usage_organization_id` | `organization_id`          | `WHERE organization_id IS NOT NULL` |

## Current Hotspots

### Important code facts

- Personal usage endpoints support three modes:
  - `personal` = `organization_id IS NULL`
  - `all` = all rows for a `kilo_user_id`
  - specific org = `organization_id = ?`
- Because of that, a single partial personal index `WHERE organization_id IS NULL` is **not** a complete replacement for a broader user-scoped index.
- The org usage page already has a period selector, but org autocomplete currently ignores it.
- `readDb` already exists and can be used for replica-safe analytics reads.
- `POSTGRES_MAX_QUERY_TIME` is validated at startup but is not currently wired into query execution behavior.

### Slow query sources

| File                                                                     | Query Pattern                                                     | Date Filter?        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------- |
| `src/app/api/profile/usage/route.ts:63-68`                               | SUM(cost), COUNT(\*), SUM(tokens) grouped by DATE(created_at)     | **None**            |
| `src/routers/user-router.ts:162-169`                                     | SUM(cost), COUNT(\*), SUM(tokens) for autocomplete model          | **None**            |
| `src/routers/kilo-pass-router.ts:190-202`                                | SUM(cost) for billing period                                      | Bounded range       |
| `src/routers/kilo-pass-router.ts:268-279`                                | SUM(cost) last 3 months                                           | Lower bound only    |
| `src/routers/organizations/organization-router.ts:282-295`               | SUM(cost), COUNT(id), SUM(tokens) last 30 days                    | Lower bound only    |
| `src/routers/organizations/organization-usage-details-router.ts:158-188` | SUM/COUNT grouped by time bucket, model, provider, project + JOIN | Bounded range       |
| `src/routers/organizations/organization-usage-details-router.ts:296-319` | SUM/COUNT grouped by date, user, model + JOIN                     | Lower bound or none |
| `src/routers/organizations/organization-usage-details-router.ts:345-357` | SUM(cost), COUNT(\*), SUM(tokens) for org autocomplete model      | **None**            |
| `src/app/admin/api/abuse/daily-stats/route.ts:38-45`                     | SUM(CASE WHEN abuse) grouped by day, 7-day window                 | Lower bound only    |
| `src/app/admin/api/abuse/stats/route.ts:35-54`                           | SUM/COUNT 1h and 24h windows                                      | Lower bound only    |
| `src/app/admin/api/abuse/hourly-stats/route.ts:36-45`                    | SUM(CASE WHEN abuse) grouped by hour, 12h window                  | Lower bound only    |

## Success Criteria

### Operational

- Primary pool `total_waiting` remains near zero during normal peak traffic.
- No interactive usage endpoint has p95 above 500 ms under normal load if feasible, and p99 remains below 2 s.
- Slow-query counts for target query fingerprints drop materially after each phase.

### Product

- Usage pages return the same totals for the same requested time range.
- Users see explicit time-period labeling wherever totals are no longer all-time by default.
- No silent change to displayed totals.

### Database

- `EXPLAIN (ANALYZE, BUFFERS)` for target queries shows materially better plans (covering index scans, fewer heap fetches) compared to pre-change baselines.
- Insert latency remains acceptable after new indexes are added.

## Measurement Framework

Capture before/after data for every phase. Before and after each change:

### SQL

- `EXPLAIN (ANALYZE, BUFFERS)` via Supabase SQL editor for each target query with representative heavy-tenant `kilo_user_id` / `organization_id` values
- Record: execution time, rows scanned, scan type (`Index Scan` vs `Index Only Scan`), heap fetches, `shared_hit`, `shared_read`

### Application

- route name
- query label (stable identifier for fingerprinting)
- scope type: user or org
- selected period
- duration
- row count returned

### Supabase

- pool `total_waiting` and active connections during peak hours
- slow query counts by fingerprint
- peak-window CPU and I/O if available
- p50, p95, p99 latency per endpoint across at least one full peak window

### Query fingerprints to track

1. Profile usage grouped by date
2. Kilo Pass personal-period sum
3. User autocomplete aggregate
4. Org 30-day summary
5. Org usage details daily breakdown
6. Org usage details time-series breakdown

---

## Phase 1: Stabilize and instrument

No schema changes. Low risk. Deploy each independently.

### 1a. Add query timing and tagging for hot endpoints

- **Files:** All files listed in the slow query sources table above
- **Change:** Wrap key DB queries with `performance.now()` timing. For each query, log:
  - route name
  - query label (stable identifier for fingerprinting)
  - organization or user scope
  - requested period
  - duration
  - row count returned
- **Effect:** Application-level before/after data for every subsequent phase.
- **Risk:** None (read-only logging).

### 1b. Enforce scoped statement timeouts

Do **not** apply one blanket timeout policy to all reads.

- **File:** `src/lib/drizzle.ts`
- **Change:** Configure differentiated statement timeouts:
  - Interactive usage reads (dashboard, billing, autocomplete): **3-5 seconds**. These are the queries causing pool saturation. If they haven't completed in 5s, they are already degrading the system.
  - Admin/reporting reads (abuse stats): **20 seconds** or route to replica (see 1c). These can tolerate longer execution but should still have an upper bound.
- **Implementation:** The existing `POSTGRES_MAX_QUERY_TIME` env var is validated at startup but never used. Preferred approach: route-scoped `SET LOCAL statement_timeout` before hot queries. Acceptable fallback: a dedicated pool/connection config for interactive usage queries. Avoid relying only on the global value if it would affect unrelated reads and writes through the shared pool.
- **Implementation caveat:** `SET LOCAL` only takes effect inside an explicit transaction block. Most of the hot queries currently use bare `db.select()` calls, which run as implicit single-statement transactions — `SET LOCAL` before them would behave like a session-scoped `SET` and could leak the timeout to subsequent queries on the same pooled connection. The implementer must either: (1) wrap the hot read in `db.transaction()` so `SET LOCAL` is properly scoped, (2) use `SET` with an explicit reset after the query, or (3) use a separate pool/connection with a configured `statement_timeout`. Do not assume `SET LOCAL` works without verifying the transaction context.
- **Effect:** Runaway interactive queries are cancelled in seconds instead of holding connections for 10-22s.
- **Risk:** Low. Any interactive query hitting 5s is already broken from a UX perspective.

### 1c. Route read-only microdollar_usage aggregation queries to replica

All queries listed below are pure SELECT/aggregation over `microdollar_usage`, return data directly, and do not participate in read-then-write flows. `readDb` is already used in user-facing hot paths (`getUserFromAuth()` in `user.server.ts:674`, FIM balance gating in `fim/completions/route.ts:155`) with documented replication lag of typically <100ms (`drizzle.ts:207`).

- **Admin abuse stats:**
  - `src/app/admin/api/abuse/daily-stats/route.ts`
  - `src/app/admin/api/abuse/stats/route.ts`
  - `src/app/admin/api/abuse/hourly-stats/route.ts`
  - **Change:** Use `readDb` instead of `db`. Slight staleness is acceptable for admin dashboards.

- **Profile usage:**
  - `src/app/api/profile/usage/route.ts:63`
  - **Change:** Use `readDb` instead of `db`. Pure aggregation returned as JSON.

- **User autocomplete metrics:**
  - `src/routers/user-router.ts:162`
  - **Change:** Use `readDb` instead of `db`. Pure aggregation returned directly.

- **Kilo Pass billing reads:**
  - `src/routers/kilo-pass-router.ts:190` (`getCurrentPeriodUsageUsd`)
  - `src/routers/kilo-pass-router.ts:268` (`getAverageMonthlyUsageLast3Months`)
  - **Change:** Use `readDb` instead of `db`. These are safe to move: `getCurrentPeriodUsageUsd` is used in the user-facing `getState` response, but acceptable replica staleness for billing-period display is ~100ms against aggregations over multi-day windows.

- **Org summary:**
  - `src/routers/organizations/organization-router.ts:282`
  - **Change:** Use `readDb` instead of `db`. Pure 30-day cost/token aggregation.

- **Org usage details (microdollar_usage queries only):**
  - `src/routers/organizations/organization-usage-details-router.ts:158` (`getTimeSeries`)
  - `src/routers/organizations/organization-usage-details-router.ts:296` (`get`)
  - `src/routers/organizations/organization-usage-details-router.ts:345` (`getAutocomplete`)
  - **Change:** Use `readDb` instead of `db`. All three are pure aggregations with JOINs, returned directly. Note: `getAIAdoptionTimeseries` (line 367) is excluded — it is not a `microdollar_usage` hotspot.

- **Effect:** Moves all hot `microdollar_usage` aggregation reads off the primary's connection pool, not just the admin subset. This materially reduces the number of long-running reads competing for the primary's 15-connection pool.
- **Risk:** Very low. All queries are pure reads. Replication lag (~100ms) is acceptable for dashboard and billing-period display.

### Phase 1 exit criteria

- Timing logs appear for all target endpoints with all required fields.
- Timed-out interactive reads fail fast (3-5s) instead of holding connections for 10-22s.
- Primary pool `total_waiting` improves or at minimum stops worsening.

### Phase 1 expected impact

Does not speed up queries, but:

- Prevents pool exhaustion via timeout
- Reduces primary load via replica routing
- Provides measurement infrastructure for subsequent phases

---

## Phase 2: Bound the worst reads

This is the highest-value application change and a **product change**, not just a performance change. The current profile usage page shows all-time totals with no period selector (the org usage page already has one). Silently capping the date range would change user-visible totals without explanation. Gate behind a feature flag and add explicit period selection to both the API and UI.

### 2a. Profile usage endpoint — add `period` parameter and default to 90 days

- **API file:** `src/app/api/profile/usage/route.ts`
- **UI file:** `src/app/(app)/usage/page.tsx`
- **API change:** Accept a new `period` query parameter (`7d` | `30d` | `90d` | `365d` | `all`, default `90d`). Translate to a bounded window: `created_at >= start AND created_at < end` (where `end` is `now()` for non-`all` periods). The `all` option preserves the current unbounded behavior.
- **UI change:** Add a period selector (matching the org usage page's existing `Tabs` pattern: Past Week / Past Month / Past Quarter / Past Year / All) above the usage table. The "Total Cost", "Total Requests", and "Total Tokens" summary cards must reflect the selected period — update their labels to include the period (e.g., "Cost (Past Quarter)") so users understand the scope.
- **Effect:** Default `90d` substantially reduces rows scanned for users with 12+ months of data, while `all` remains available for users who need full history.
- **Risk:** Medium — this is a user-visible change. Requires frontend work and testing. The `all` option preserves backward compatibility.

### 2b. User autocomplete metrics — add `period` parameter, default to 90 days

- **API file:** `src/routers/user-router.ts` (lines 144-168)
- **UI file:** `src/app/(app)/usage/page.tsx` (autocomplete cards)
- **API change:** Accept a `period` parameter (same enum as 2a). Translate to a bounded `created_at >= start AND created_at < end` window. Default to `90d`.
- **UI change:** Autocomplete summary cards should respect the same period selector added in 2a, so totals are consistent across the page.
- **Risk:** Same as 2a.

### 2c. Org autocomplete metrics — wire existing period parameter

- **API file:** `src/routers/organizations/organization-usage-details-router.ts` (lines 339-366)
- **UI file:** `src/components/organizations/usage-details/OrganizationUsageDetails.tsx`
- **Change:** The org usage details page already has a period selector (`week`/`month`/`year`/`all`), but `getAutocomplete` ignores it and always scans all history. Wire the existing period parameter through to the autocomplete query's WHERE clause so it respects the same date bound as the rest of the org usage page. Use bounded windows (`created_at >= start AND created_at < end`) where possible.
- **Effect:** Large orgs no longer trigger unbounded full-history scans for autocomplete metrics.
- **Risk:** Low — the UI already has the selector; this just makes the backend respect it.

### 2d. Standardize ranged queries to use closed-open intervals

- **Files:** All endpoints with lower-bound-only date filters (kilo-pass billing, org summary, org usage details, admin abuse stats)
- **Change:** Where queries currently use only `created_at >= start`, add an explicit upper bound: `created_at >= start AND created_at < end`. This gives the query planner a precise range to work with and prevents scans from running into future rows if data skew or clock drift occurs.
- **Risk:** Very low. Semantic no-op for correctly-clocked data.

### 2e. Roll out behind a feature flag

Because this changes user-visible totals by default:

- Gate the new periodized personal usage experience behind a feature flag.
- Compare behavior on sampled users before broad rollout.
- The `all` option must remain explicit in the UI and instrumented.

### Residual risk: the `all` option

The `all` option still permits an expensive full-history scan for heavy users. This is acceptable in the short term only if:

- it is explicit in the UI (user must actively choose it)
- it is instrumented (timing logs capture every `all` request)
- timeout protection is in place (Phase 1b)

If `all` remains operationally expensive after later phases, treat that as evidence for a separate rollup or export path.

### Phase 2 exit criteria

- Default requests scan far fewer rows — confirm via EXPLAIN ANALYZE.
- Personal and org autocomplete no longer scan full history by default.
- Labels clearly indicate the selected period — no silent change to displayed totals.
- Feature flag gates the new experience; sampled user comparison validates correctness.

### Phase 2 expected impact

Immediate query time reduction for the three unbounded queries. The existing composite index `idx_kilo_user_id_created_at2` can efficiently range-scan the bounded window. Org autocomplete benefits from the org index added in Phase 3.

---

## Phase 3: Covering indexes

Schema change. Requires `CREATE INDEX CONCURRENTLY` on production.

These are the primary database optimization step, not merely a bridge to rollups.

### 3a. Covering index for user-scoped queries

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mu_user_created_covering
ON microdollar_usage (kilo_user_id, created_at DESC)
INCLUDE (cost, input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens, model, organization_id);
```

**Supports:** Profile usage, kilo-pass billing, autocomplete metrics.

**Why these INCLUDE columns:**

- `cost, input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens` — all aggregated columns
- `model` — used in GROUP BY (profile usage) and WHERE (autocomplete)
- `organization_id` — used in WHERE filters (`IS NULL`, `= ?`)

**Why non-partial (no WHERE clause):** The current profile and autocomplete endpoints support `viewType='all'` and org-specific views, not just personal usage. A partial index on `WHERE organization_id IS NULL` would not cover these query paths without adding a second index. Do not replace this with a personal-only partial index unless measurements show `viewType='all'` is operationally unimportant.

**Why `created_at DESC`:** The dominant access pattern is recent-window queries (last 7/30/90 days). Descending order lets Postgres scan forward through the index for these windows rather than scanning backwards.

**Effect:** Enables index-only scans when the visibility map is current, materially reducing heap fetches. On recently-written pages (the tail of the recent window), Postgres may still need heap fetches until autovacuum updates the visibility map. The goal is materially fewer heap fetches and better plans, not a guarantee of zero heap access on every query.

**Follow-up:** After verifying the new index, drop `idx_kilo_user_id_created_at2` (fully subsumed).

### 3b. Covering index for org-scoped queries

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mu_org_created_covering
ON microdollar_usage (organization_id, created_at DESC)
INCLUDE (cost, input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens, kilo_user_id, model, provider, project_id, id)
WHERE organization_id IS NOT NULL;
```

**Supports:** Org summary, org usage details (time series + daily breakdown), org autocomplete.

**Why these INCLUDE columns:**

- `cost, input_tokens, output_tokens, cache_write_tokens, cache_hit_tokens` — all aggregated columns (the `get` query at `organization-usage-details-router.ts:303` sums `input_tokens + output_tokens + cache_write_tokens + cache_hit_tokens` for tokenCount)
- `kilo_user_id` — JOIN condition in org usage detail queries
- `model, provider, project_id` — GROUP BY in time series query
- `id` — `COUNT(id)` aggregations
- Partial index (`WHERE organization_id IS NOT NULL`) reduces index size — appropriate here because org queries always filter on a specific non-null org

**Why `created_at DESC`:** Same rationale as 3a — recent-window queries are the dominant pattern.

**Width caveat:** This index is wide (10 INCLUDE columns). It covers both org summary queries (which only need `cost` and token counts) and org detail queries (which need `model`, `provider`, `project_id`, `kilo_user_id` for GROUP BY and JOIN). Treat this single-index approach as a hypothesis to validate. If post-creation measurements show unacceptable write amplification on the ingestion path, consider splitting into two narrower indexes: one for the summary pattern and one for the detail pattern. Measure before committing to either approach.

**Follow-up:** After verifying the new index, drop `idx_microdollar_usage_organization_id` (fully subsumed).

### 3c. Measure write amplification explicitly

These indexes are wide and will increase maintenance cost on every insert. Do **not** assume the wide org index is free.

After index creation, measure:

- Insert latency on the usage ingestion path (`processUsage.ts`)
- Storage growth rate
- Plan adoption for all target queries

### Migration approach

1. Add both indexes to `packages/db/src/schema.ts`
2. Run `pnpm drizzle generate` to create the migration `.sql`
3. Edit the generated `.sql` to use `IF NOT EXISTS`
4. **On production:** Run the `CONCURRENTLY` versions via Supabase SQL editor before deploying
5. **Deploy code:** Migration is a no-op on prod (index already exists), creates indexes normally on fresh dev/test DBs
6. After verification, create a follow-up migration to drop the old indexes

### 3d. Delay index cleanup until verified

Do not drop existing indexes until:

- New plans are confirmed in production via `EXPLAIN (ANALYZE, BUFFERS)`
- Insert cost is acceptable
- Old indexes are shown to be redundant

### Phase 3 exit criteria

- `EXPLAIN (ANALYZE, BUFFERS)` on each target query with representative heavy users/orgs shows `Index Only Scan` instead of `Index Scan`, with materially fewer heap fetches than baseline. Note: true zero-heap-fetch behavior depends on the visibility map being current; recently-inserted pages will still require heap access until autovacuum processes them. If the recent window consistently shows elevated heap fetches, consider tuning `autovacuum_vacuum_scale_factor` for this table.
- Pool waiting drops materially during peak windows.
- Insert latency regression is acceptable — monitor before and after to confirm the wider indexes do not meaningfully slow the ingestion path.

### Phase 3 expected impact

Highest-impact change. Queries that currently do index scan + heap fetch for every matched row should move toward covering-index-driven plans with materially fewer heap fetches. The actual degree of improvement depends on table size, tenant data volume, and visibility map freshness — run `EXPLAIN (ANALYZE, BUFFERS)` with representative heavy tenants to quantify the gain before and after.

---

## Phase 4: Reassess before adding architecture

After Phases 1-3 are deployed and measured across at least one full peak window, stop and measure.

### Decision gate

Run `EXPLAIN (ANALYZE, BUFFERS)` on all target queries with representative heavy tenants. Collect p95/p99 latency and pool waiting metrics over a peak period.

### If the numbers are good

If:

- Default interactive queries are comfortably under ~500ms p95
- Pool waiting is near zero
- `all` usage is rare and bounded by timeout

Then stop here. The covering index approach is sufficient. Monitor for table growth and revisit if performance degrades.

Optional next steps:

- Small TTL cache for repeated dashboard reads (in-memory LRU, TTL 30-60s, keyed by user/org + period + grouping dimensions)
- Follow-up cleanup migration to drop superseded indexes
- Connection pool tuning (currently `max: 15`, may warrant adjustment based on post-optimization query times)

### If the numbers are still bad

Only then consider rollups. Triggers for escalation:

- Large-org queries still exceed ~2 seconds after bounded windows and covering indexes
- Heavy use of explicit `all` still causes incidents
- Index maintenance cost is acceptable but read latency remains too high

---

## Phase 5: Rollups only if justified by measurement

Do not commit to this phase until earlier phases prove insufficient.

### Rollup principles

- `microdollar_usage` remains the source of truth
- Cut readers over one endpoint family at a time
- Dual-read and reconcile before removing base-table fallbacks
- Feature-flag rollup-backed readers

### Major risks to solve before implementation

- Nullable-dimension uniqueness semantics
- Write-path latency from dual-write upserts (the current write path is already a complex single-statement insert flow)
- Backfill load and checkpointing
- Retention cleanup for recent hourly data

### Preferred rollout order if needed

1. Kilo Pass windowed reads
2. User autocomplete
3. Org summary
4. Personal usage history
5. Org daily details
6. Org time series

### Other future considerations

Documented for reference if growth continues beyond the rollup threshold:

- **Table partitioning by month** — Operations optimization for the raw ledger (autovacuum, index maintenance), not a substitute for summary reads. Only warranted if Supabase maintenance queries create sustained load after rollups are handling interactive reads.
- **Connection pool tuning** — Currently `max: 15`. May need adjustment based on post-optimization query times.

---

## Rollout Summary

| Step | Phase                                                         | Deploy independently?     | Requires migration? | Risk     |
| ---- | ------------------------------------------------------------- | ------------------------- | ------------------- | -------- |
| 1    | 1a: Add query timing and tagging                              | Yes                       | No                  | None     |
| 2    | 1b: Enforce scoped statement timeouts                         | Yes                       | No                  | Low      |
| 3    | 1c: Route read-only microdollar_usage aggregations to replica | Yes                       | No                  | Very low |
| 4    | 2a: Profile usage period selector (API + UI)                  | Yes (behind flag)         | No                  | Medium   |
| 5    | 2b: User autocomplete period param                            | With step 4 (behind flag) | No                  | Medium   |
| 6    | 2c: Org autocomplete date bound                               | Yes                       | No                  | Low      |
| 7    | 2d: Standardize ranged queries                                | Yes                       | No                  | Very low |
| 8    | 2e: Feature flag rollout                                      | After validating 4-7      | No                  | Low      |
| 9    | 3a: User covering index                                       | Yes                       | Yes (CONCURRENTLY)  | Low      |
| 10   | 3b: Org covering index                                        | Yes                       | Yes (CONCURRENTLY)  | Low      |
| 11   | 3c: Measure write amplification                               | After 9+10                | No                  | N/A      |
| 12   | 3d: Drop old indexes                                          | After verifying 9+10+11   | Yes                 | Low      |
| 13   | Phase 4: Reassess                                             | After measuring 1-3       | No                  | N/A      |
| 14   | Phase 5: Rollups                                              | Only if justified         | Yes                 | High     |

Each step can be deployed, measured, and verified before proceeding to the next.
