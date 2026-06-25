# Cost Insights data layer implementation plan

## Status

Ready for implementation. This plan covers Credit-spend capture, owner-hour rollups, read repositories, historical backfill, repair, and rollout validation. Alert evaluation, Cost Insight Events, notifications, tRPC routes, and UI are follow-on work.

The business rules remain in `.specs/cost-insights.md`. Canonical terminology remains in `CONTEXT.md`. The broader feature sequence remains in `.plans/cost-insights.md`.

## Goal

Create a Postgres data source that can answer, for one Spend owner:

- Variable and Scheduled Credit spend by UTC hour.
- Current-hour Variable Credit spend.
- Zero-filled hourly evidence for 24h, 7d, 30d, and 90d ranges.
- Top spend drivers by source, product or feature, model or plan, provider, and actor user.
- Whether a requested historical range is complete enough to treat missing rows as zero.

Every production operation that increments `microdollars_used` must update this data source in the same database transaction. Snowflake is not part of capture, repair, or correctness.

## Non-goals

- Do not build anomaly or Spend Threshold Alert evaluation yet.
- Do not create Cost Insight Events, notification delivery rows, settings, or owner alert state.
- Do not change current Credit pricing, admission, low-balance behavior, auto-top-up, or Kilo Pass behavior.
- Do not replace `microdollar_usage_daily`; its Kilo Pass consumer remains unchanged.
- Do not make all-time historical backfill a launch gate. Bootstrap 90 days, retain those rows and all new rows indefinitely, then expand older history only if product needs exceed the v1 90-day evidence window.
- Do not add user email, display name, request prompt, project, session, instance name, or arbitrary client metadata to rollups.

## Decisions

### Storage shape

Add four unpartitioned tables:

1. `cost_insight_owner_hour_totals`
2. `cost_insight_owner_hour_driver_buckets`
3. `cost_insight_rollup_coverage`
4. `cost_insight_rollup_degraded_intervals`

The first two are sparse. Zero-spend hours do not create rows. Coverage metadata and unresolved degraded intervals tell readers when a missing row is a trustworthy zero.

Do not add a second per-spend contribution ledger. Existing source rows and idempotent billing records remain the contribution ledger. Duplicating every AI Gateway request would defeat the purpose of compact rollups.

### No partitioning in the first version

The current daily table is not partitioned, despite the conversation suggesting it as precedent. Hourly totals and driver buckets are compact aggregate tables with conflict updates, not append-only request logs. Partitioning would add partition-provisioning failure modes to mandatory Credit-spend writes and cannot be generated cleanly through the current Drizzle schema workflow.

Ship unpartitioned tables, measure row growth, index size, autovacuum behavior, update latency, and owner-hour lock contention. Revisit monthly `hour_start` partitioning only when measured table maintenance or index size requires it. Missing future partitions must never become a reason Credit spend fails.

### Owner identity

Use the established exactly-one-owner pattern:

- `owned_by_user_id text NULL`
- `owned_by_organization_id uuid NULL`
- Check constraint requiring exactly one value.
- Separate partial unique indexes for personal and organization owners.

Do not use a polymorphic `(owner_type, owner_id)` pair. Typed foreign keys and partial indexes keep owner integrity and query plans explicit.

### Spend classification

Persist two controlled categories:

- `variable`
- `scheduled`

Persist four controlled sources from the Cost Insights spec:

- `ai_gateway`
- `kiloclaw`
- `coding_plan`
- `other`

Exa uses `other` in v1 because `exa` is not in the approved source taxonomy. Its `product_key` remains `exa`, so the UI can still identify it.

### Consistency

Live capture is additive and transaction-bound. Backfill and repair are absolute replacements computed from canonical Postgres sources.

The shared capture helper never opens or commits a transaction. Callers pass their current transaction. A source row, owner balance mutation, owner-hour total, and driver bucket either commit together or roll back together.

### Timestamps

Use the source spend timestamp, not processing or backfill time. Normalize buckets with explicit UTC SQL, for example `date_trunc('hour', occurred_at, 'UTC')`. Do not rely on database session timezone.

## Data model

### Controlled schema values

Add `CostInsightSpendCategory` and `CostInsightSpendSource` runtime/type values to `packages/db/src/schema-types.ts`. Register them in `SCHEMA_CHECK_ENUMS` and enforce them through `enumCheck` constraints in `packages/db/src/schema.ts`.

### Owner-hour totals

`cost_insight_owner_hour_totals` stores the amount used by charts and alert evaluation.

| Column | Contract |
|---|---|
| `id` | UUID primary key |
| `owned_by_user_id` | Nullable FK to `kilocode_users.id` |
| `owned_by_organization_id` | Nullable FK to `organizations.id` |
| `hour_start` | UTC-truncated `timestamptz` |
| `spend_category` | `variable` or `scheduled` |
| `total_microdollars` | Positive `bigint`, Drizzle number mode |
| `spend_record_count` | Positive `bigint`, one per contributing source spend record |
| `created_at` | Insert timestamp |
| `updated_at` | Explicitly updated by conflict updates |

Constraints and indexes:

- Exactly one owner check.
- UTC-hour check.
- Positive amount and record-count checks.
- Personal partial unique index on `(owned_by_user_id, hour_start, spend_category)` where organization is null.
- Organization partial unique index on `(owned_by_organization_id, hour_start, spend_category)` where user is null.

Index order keeps an owner's 24h through 90d rows contiguous. At most two total rows exist per owner-hour.

### Driver buckets

`cost_insight_owner_hour_driver_buckets` stores compact attribution. Each captured spend record contributes to one combined driver bucket, not one row per dimension.

| Column | Contract |
|---|---|
| `id` | UUID primary key |
| `owned_by_user_id` | Nullable owner FK |
| `owned_by_organization_id` | Nullable owner FK |
| `hour_start` | Same UTC bucket as total row |
| `spend_category` | Controlled category |
| `driver_key` | SHA-256 digest of normalized source, dimensions, and actor identity |
| `source` | Controlled source |
| `product_key` | Non-null controlled product key or `other` |
| `feature_key` | Non-null controlled operation/feature key or `other` |
| `model_or_plan_key` | Non-null existing model/plan identifier or `other` |
| `provider_key` | Non-null existing provider identifier or `other` |
| `actor_user_id` | FK to charged/attributed user; required for personal and organization spend |
| `total_microdollars` | Positive `bigint` |
| `spend_record_count` | Positive `bigint` |
| `created_at` | Insert timestamp |
| `updated_at` | Explicitly updated by conflict updates |

Use non-null `other` sentinels for unavailable dimensions. This prevents null uniqueness from creating duplicate buckets and keeps grouping simple.

Compute `driver_key` in the shared package from a fixed v1, length-prefixed serialization of source, all four driver dimensions, and actor user ID. Store a 32-byte/64-hex SHA-256 digest. This keeps the mandatory conflict index narrow while retaining readable dimension columns.

The v1 serialization and normalization contract is immutable. Any later mapping/key change must increment the global `rollup_version`, delete and rebuild affected driver rows from canonical sources, and re-establish coverage; it must not mix key versions in one covered interval. Bulk backfill deletes every driver row in its target hour before insertion. Targeted repair deletes every driver row for its owner-hour before insertion. Reruns therefore cannot leave parallel old-key buckets.

Create separate personal and organization partial unique indexes on owner, hour, category, and `driver_key`. On live-write conflict, update only when stored dimensions exactly match the incoming dimensions; a digest/dimension mismatch throws and rolls back rather than merging unrelated buckets. The owner/hour prefix also supports range scans. Benchmark top-driver reads before adding another range index.

Driver values must be bounded identifiers, not labels or arbitrary request strings. Normalize empty or unsupported values to `other` and cap identifier lengths before persistence.

### Coverage

`cost_insight_rollup_coverage` has one low-write global row for the current rollup format.

| Column | Contract |
|---|---|
| `rollup_version` | Small integer primary key; v1 is `1` |
| `live_capture_start_hour` | First UTC hour after all production spend writers had mandatory capture |
| `coverage_start_hour` | Earliest UTC hour rebuilt and verified across all canonical sources |
| `last_reconciled_at` | Last successful canonical-source reconciliation |
| `created_at` | Insert timestamp |
| `updated_at` | Explicit update timestamp |

`cost_insight_rollup_degraded_intervals` records known exceptions to the global claim.

| Column | Contract |
|---|---|
| `id` | UUID primary key |
| `start_hour` | Inclusive UTC hour |
| `end_hour_exclusive` | Exclusive UTC hour |
| `source` | Optional controlled source; null means all sources |
| `reason` | Controlled operational reason, not arbitrary error text |
| `detected_at` | Detection timestamp |
| `resolved_at` | Null until repair and reconciliation complete |
| `created_at` | Insert timestamp |
| `updated_at` | Explicit update timestamp |

Coverage is global because bootstrap scans every canonical source for each covered hour. A missing owner total is a trustworthy zero only when the hour is at or after `coverage_start_hour` and no unresolved degraded interval overlaps it. Before coverage begins, or inside a degraded interval, it is unknown.

Do not advance `coverage_start_hour` across an unprocessed hour. The backfill job moves it backward one contiguous completed hour at a time. Atomic live capture makes coverage continuous after `live_capture_start_hour`.

Create a degraded interval before an intentional capture bypass, and immediately when reconciliation detects a possible gap. Repair and reconcile the full interval before setting `resolved_at`. This preserves honest zero-fill semantics without creating per-owner coverage rows.

## Shared capture module

Add a subpath-only export `@kilocode/db/cost-insights-rollups`, backed by `packages/db/src/cost-insights-rollups.ts` and exported through `packages/db/package.json`. Do not add it to the broad root barrel; explicit imports keep the billing-critical persistence boundary visible in web and Worker call sites.

The module owns:

- Spend owner, category, source, and driver input types.
- Input validation.
- Explicit UTC bucket calculation.
- Transaction-scoped owner-hour advisory locking.
- Total and driver additive upserts in a fixed lock order.
- Generic owner-range read helpers that do not format USD or resolve labels.

Suggested input:

```ts
type CostInsightSpendOwner =
  | { type: 'user'; id: string }
  | { type: 'organization'; id: string };

type CaptureCostInsightSpendInput = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  spendRecordCount?: number;
  category: CostInsightSpendCategory;
  source: CostInsightSpendSource;
  productKey: string;
  featureKey: string;
  modelOrPlanKey: string;
  providerKey: string;
};
```

`captureCostInsightSpend(tx, input)` must:

1. Reject invalid timestamps, unsafe integers, non-positive amounts/counts, missing owner IDs, and uncontrolled category/source values.
2. Normalize driver keys to bounded values and `other` sentinels.
3. Compute the versioned driver digest and retain normalized dimensions for collision verification.
4. Acquire a transaction-scoped advisory lock derived from owner type, owner ID, and UTC hour.
5. Upsert the owner-hour total.
6. Upsert the combined driver bucket.
7. Increment amount and count and set `updated_at = now()` explicitly.

Every writer and targeted repair acquires the same owner-hour advisory lock. This prevents an absolute repair from overwriting a concurrent live contribution. Always lock total before driver to avoid lock-order drift.

The module must accept a structural transaction writer type. It must not import the web database singleton, create a Worker database client, or cache transport-owning state. KiloClaw Worker continues creating request-scoped clients through `getWorkerDb`.

### Idempotency contract

The helper is additive, so call it only after the authoritative source insertion or billing deduction is known to be new.

- AI Gateway and Exa source inserts are new UUID records.
- Coding Plan activation and renewal use their existing term/idempotency records.
- KiloClaw enrollment and renewal call capture only when the period-scoped credit deduction insert succeeds.
- Duplicate, free, failed, refunded, expired, or balance-repair paths do not call capture.

Rollback and retry are safe because source, balance, and rollup share one transaction. The helper does not claim to solve the existing lack of request-replay idempotency in AI Gateway or Exa.

## Driver mapping

| Spend path | Category | Source | Product | Feature | Model/plan | Provider | Actor |
|---|---|---|---|---|---|---|---|
| AI Gateway | `variable` | `ai_gateway` | Validated `X-KILOCODE-FEATURE` or `direct-gateway`/`other` | Validated API kind/operation or `other` | Requested model, then resolved model, then `other` | Inference provider, then gateway provider, then `other` | `kilo_user_id` |
| Charged Exa | `variable` | `other` | `exa` | Allowlisted Exa path, else `other` | `other` | `exa` | Requesting user |
| KiloClaw enrollment | `scheduled` | `kiloclaw` | `kiloclaw-hosting` | `enrollment` | `standard` or legacy `commit` | `other` | Charged user |
| KiloClaw renewal | `scheduled` | `kiloclaw` | `kiloclaw-hosting` | `renewal` | Effective plan | `other` | Charged user |
| Coding Plan activation | `scheduled` | `coding_plan` | `coding-plan` | `activation` | Plan ID | Provider ID | Charged user |
| Coding Plan renewal | `scheduled` | `coding_plan` | `coding-plan` | `renewal` | Plan ID | Provider ID | Charged user |

Coding Plan-backed inference is BYOK/zero-cost at AI Gateway and must not create a second Variable Credit spend record. KiloClaw Stripe-funded settlement is balance-neutral bookkeeping and must not create Scheduled Credit spend.

Every included canonical source has a stable charged or attributed user ID: `microdollar_usage.kilo_user_id`, `exa_usage_log.kilo_user_id`, `coding_plan_terms.user_id`, or `credit_transactions.kilo_user_id`. System-triggered renewals use the charged user as driver attribution; actor does not imply a human initiated the transaction. If a future Credit-spend source lacks actor user identity, it cannot silently write a null/synthetic actor; update the spec and schema contract first.

## Spend-writer audit gate

Before producer integration, repeat a repository-wide audit of every direct `kilocode_users.microdollars_used` and `organizations.microdollars_used` mutation. Record each production mutation in the implementation PR as included Credit spend or excluded balance/accounting mutation.

Current direct Credit-spend set:

| Mutation | Classification |
|---|---|
| AI Gateway personal balance update | Include: Variable `ai_gateway` |
| Organization usage helper used by AI Gateway | Include: Variable `ai_gateway` |
| Personal charged Exa balance update | Include: Variable `other`/`exa` product |
| Organization usage helper used by charged Exa | Include: Variable `other`/`exa` product |
| Coding Plan activation and renewal | Include: Scheduled `coding_plan` |
| KiloClaw pure-credit enrollment and renewal | Include: Scheduled `kiloclaw` |
| Balance recomputation | Exclude: repair canonical hours instead |
| Credit grants, purchases, auto-top-ups | Exclude: acquired credits, not spend |
| Expiration, refund, void, dispute, settlement | Exclude: accounting/acquired-credit changes |
| Admin corrections, seeds, development consume routes | Exclude from production evidence; seed rollups explicitly for local fixtures if needed |

No writer integration is complete until this audit has no unexplained production mutation. Add a focused static/repository test or documented grep check so future `microdollars_used` mutations require an explicit Cost Insights classification.

## Capture integrations

### AI Gateway personal and organization spend

Primary files:

- `apps/web/src/lib/ai-gateway/processUsage.ts`
- `apps/web/src/lib/organizations/organization-usage.ts`

First extract an executor-parameterized version of the existing raw multi-CTE statement without changing its one-statement behavior. Preserve the outer retry policy for current concurrency failures; each retry must start a fresh transaction and rerun source plus rollups together. Then wrap the complete personal/organization persistence path in one caller-owned transaction.

For personal usage, keep these effects together:

- `microdollar_usage` insert.
- Metadata and existing daily rollup.
- Personal `microdollars_used` update.
- Cost Insights total and driver upserts.

For organization usage, remove the current second-transaction boundary. Add a transaction-aware organization spend primitive that performs:

- Organization `microdollars_used` and legacy balance cache update.
- Organization member daily usage update.
- Cost Insights total and driver upserts.

Split the current organization helper into a transaction-aware mutation that returns `{ crossedMinimumBalance, recipients }` and a separate post-commit scheduler. AI and Exa organization paths must use the same mutation primitive. The source row, organization charge, member daily usage, and rollups share one transaction; low-balance email is scheduled exactly once only after commit.

Capture only positive `cost`. Zero-cost, free, and BYOK rows remain in source usage tables but are not Credit spend.

### Exa personal and organization spend

Primary files:

- `apps/web/src/lib/exa-usage.ts`
- `apps/web/src/app/api/exa/[...path]/route.ts`

Refactor `recordExaUsage` into one transaction. Precompute one source ID and timestamp, then use them for the log and rollup.

The transaction contains:

- `exa_usage_log` insert.
- `exa_monthly_usage` update.
- Personal or organization balance mutation when charged.
- Organization member daily usage when organization-owned.
- Cost Insights total and driver upserts when `charged_to_balance` is true and amount is positive.

Keep free-allowance requests in the Exa source tables without Cost Insights spend. Do not insert synthetic `microdollar_usage` rows for Exa.

### Coding Plan activation and renewal

Primary files:

- `apps/web/src/lib/coding-plans/index.ts`
- `apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts`

Both paths already use transactions and idempotent term identities. Keep balance guard/update, negative credit transaction, term, and rollup in the same transaction. Capture Scheduled Credit spend only after the new deduction identity is established and before commit. If reordering the current balance update ahead of ledger insertion would complicate existing guards, retain current order and prove with failure-injection tests that any later ledger/rollup error rolls the balance update back.

Use the same explicit `occurredAt` on the credit transaction and rollup input. Skip duplicate activation/renewal, insufficient balance, cancellation, and past-due paths.

### KiloClaw credit enrollment and renewal

Primary files:

- `apps/web/src/lib/kiloclaw/credit-billing.ts`
- `services/kiloclaw-billing/src/lifecycle.ts`

Both pure-credit charge paths already use transactions. Call capture only after a new period-scoped negative credit transaction is inserted. Capture before balance and subscription changes commit.

Do not capture:

- Duplicate deduction reconciliation.
- Stripe-funded settlement categories.
- Auto-top-up funding.
- Failed or deferred renewal.
- Cancellation without deduction.
- Organization-managed rows skipped by personal pure-credit renewal.

The Worker receives the shared helper through `@kilocode/db/cost-insights-rollups` and passes its existing transaction. It must not cache database clients or pools in module scope.

### Explicit exclusions

Do not derive Cost Insights spend from arbitrary negative `credit_transactions`. The table also contains expirations, refunds, voids, disputes, settlement entries, and accounting adjustments.

Do not capture direct balance recomputation deltas, admin corrections, seed scripts, or development consume endpoints as production spend. Repair rollups from canonical source records in their original hours instead.

## Read repository

Add `apps/web/src/lib/cost-insights/spend-repository.ts`. It should accept a database executor and typed Spend owner, with no tRPC, authorization, USD formatting, or UI labels.

### `getOwnerHourlySpend`

Inputs: owner, `startHour`, `endHourExclusive`.

Return one row per UTC hour with:

- Variable microdollars.
- Scheduled microdollars.
- Total microdollars.
- Variable and scheduled record counts.
- `isCovered`.

Use `generate_series` and left joins so covered zero-spend hours are present. Return canonical timestamps, not display labels. Allow up to 2,160 buckets for the 90-day range.

### `getOwnerTopSpendDrivers`

Inputs: owner, half-open time range, optional category, limit capped at 5 for alert evidence.

Group by the combined persisted dimensions. Sum amount and record count, order by amount descending with stable dimension tie-breakers, and limit before resolving actor labels. Actor label resolution belongs in a later application layer and uses current user rows.

### `getOwnerCurrentHourSpend`

Return current UTC-hour Variable and Scheduled totals from the primary database. Future post-spend evaluation must not use a lagging replica.

### `getCostInsightRollupCoverage`

Return live capture start, coverage start, last reconciliation, overlapping unresolved degraded intervals, and whether a requested range is fully covered. Reads must not turn uncovered or degraded missing rows into zero.

### `getOwnerRolling24HourSpendExact`

The spec requires an exact elapsed `[asOf - 24h, asOf)` window. Hourly totals alone cannot apportion the oldest and current partial hours.

Add a repository helper that:

1. Uses owner-hour totals for the fully enclosed UTC hours.
2. Uses the canonical Postgres source union for `[asOf - 24h, ceilToUtcHour(asOf - 24h))` and `[floorToUtcHour(asOf), asOf)` boundary fragments, skipping either fragment when its bounds are equal.
3. Returns Variable, Scheduled, and total microdollars under one database snapshot/as-of value.
4. Refuses to claim completeness when the interior range overlaps an unresolved degraded interval.

This preserves exact threshold semantics without a second per-spend ledger. Benchmark the two bounded raw fragments for high-volume organizations before the threshold evaluator uses this helper after every spend; follow-on evaluation may need coalescing, but it may not replace exact rolling semantics with a 24-bucket approximation.

## Backfill and repair

### Canonical Postgres sources

| Source family | Inclusion rule |
|---|---|
| AI Gateway | `microdollar_usage.cost > 0`; owner from organization when present, otherwise user; occurrence is `microdollar_usage.created_at` |
| Exa | `exa_usage_log.charged_to_balance = true` and positive cost; occurrence is `exa_usage_log.created_at` |
| Coding Plan | `coding_plan_terms` joined to its negative `credit_transactions` row; occurrence is `credit_transactions.created_at`, not term period bounds |
| KiloClaw | Pure-credit `kiloclaw-subscription:*` and `kiloclaw-subscription-commit:*` deductions only; exclude settlement; occurrence is `credit_transactions.created_at`, not renewal boundary |

Live scheduled-spend writers set `credit_transactions.created_at` from the same explicit `occurredAt` passed to capture. Backfill, targeted repair, and exact rolling-window fragments use that field, so scheduled spend lands in the same hour under every path.

The existing daily rollup is a secondary checksum, not a backfill source. It lacks Scheduled spend, hourly timestamps, and drivers.

### Shared canonical mapping

Add source-specific canonical aggregation functions under `apps/web/src/lib/cost-insights/`. Live and historical mapping must share constants for category, source, product, feature, and fallback values.

Backfill SQL may need source-specific `CASE` expressions for set-based aggregation. Add parity fixtures proving live mapping and historical mapping produce the same driver keys for representative source rows.

Historical gaps map to `other`; do not infer mutable event-time data from current subscriptions or user profiles.

### Bulk backfill script

Add an operator script under `apps/web/src/scripts/` and register it in the existing script index. It must default to dry run and require explicit execution.

Parameters:

- `--execute`
- `--start-hour`
- `--end-hour`
- `--max-hours`
- `--sleep-ms`
- Optional source/owner diagnostics without changing mapping semantics.

Process newest completed hours first so every successful step extends one contiguous interval backward from live capture:

1. Deploy all live writers.
2. Record `live_capture_start_hour` as the first full UTC hour after every writer is active.
3. Rebuild the immediately preceding hour, then continue backward through the newest 7 days.
4. Continue the same contiguous sequence to 90 days before the public dashboard relies on 30d/90d evidence.
5. Retain the bootstrapped 90 days and all future rollups indefinitely. Older historical expansion is optional follow-up work, not a launch requirement.

Before execution, run `EXPLAIN` against production-shaped data for every source query. Confirm `microdollar_usage.created_at` range scans, Exa partition pruning, and bounded credit-transaction/term scans. Do not add or replace indexes on the large raw usage table without a separate online-index rollout plan.

For each completed pre-cutover hour:

1. Aggregate all four canonical source families into temporary/staging results using half-open timestamp predicates.
2. Build owner/category totals and owner/category/source/driver buckets.
3. In one bounded `REPEATABLE READ` transaction, delete existing aggregate rows for that hour and insert absolute staged results.
4. Verify owner totals equal the sum of driver amounts and counts.
5. Commit.
6. Move `coverage_start_hour` back only when the new hour is contiguous with existing coverage.

Absolute replacement makes reruns safe. Never reuse the live additive `total = total + excluded.total` behavior for backfill. Pre-cutover ranges run only after normal async persistence has drained; overlapping or unexpectedly late owner-hours use targeted advisory-locked repair instead of a global serializable transaction.

Start with one hour per source scan and no concurrency. After benchmarks, permit a bounded multi-hour staging scan only if it reduces repeated raw-table IO while keeping replacement transactions and coverage advancement small. Bound statement and lock timeouts. Stop on elevated database load, replication lag, lock waits, or reconciliation differences.

The deployment boundary and preceding hour need a second reconciliation pass after normal async usage persistence has drained. If a later source row exposes a gap, create a degraded interval first, repair affected owner-hours, reconcile the interval, then resolve it.

### Targeted owner repair

Add `repairOwnerSpendRollups(owner, startHour, endHourExclusive)` with an explicit maximum supplied by the caller. Future Spend Alert enablement uses a hard seven-day cap. Operator repair may use up to 90 days with lower concurrency and stricter timeouts.

For each owner-hour:

1. Acquire the same owner-hour advisory lock used by live capture.
2. Re-read every canonical source family for that owner and hour.
3. Build absolute totals and driver buckets.
4. Replace that owner's aggregate rows for the hour in one transaction.
5. Verify totals against drivers.

Delete aggregate rows when the canonical result is zero. The repair path must be idempotent and safe to retry.

### Reconciliation

Add a dry-run reconciliation mode that compares rollups with canonical source sums for bounded owner/hour samples and reports:

- Missing totals.
- Amount differences.
- Record-count differences.
- Driver sum differences.
- Unknown taxonomy values.
- Coverage holes.

Run canaries for high-volume organizations, normal personal users, Exa users, KiloClaw users, and Coding Plan users before any alert evaluator consumes the tables.

## Observability

Instrument capture by source without logging sensitive request data:

- Capture latency.
- Total and driver upsert failures.
- Advisory-lock wait duration.
- Transaction rollback count.
- Rows and microdollars captured by source/category.
- Backfill hour duration and staged row counts.
- Reconciliation mismatch count and amount.
- Coverage start and age.
- Unresolved degraded-interval count and age.
- Exact rolling-24h boundary-fragment query latency.

Add Sentry context with source, category, owner type, and source record ID where available. Do not attach prompts, auth headers, cookies, tokens, Exa request bodies, user email, or display name.

Monitor database tuple/advisory lock waits, WAL volume, index growth, autovacuum lag, replica lag, and AI Gateway/Exa persistence latency through existing database telemetry.

## Tests

### Schema and helper tests

- Exactly-one-owner constraints.
- Controlled category/source constraints.
- UTC-hour normalization across session timezones and DST boundaries.
- Personal and organization uniqueness.
- Driver fallback normalization, length bounds, deterministic digest, and collision mismatch failure.
- Additive total and driver updates.
- Amount and record-count overflow/unsafe-integer rejection.
- Forced driver failure rolls back total and source spend transaction.
- Concurrent updates produce exact sums.
- Same owner/hour repair and live capture do not lose a contribution.

### Source integration tests

- AI personal positive spend updates raw usage, daily rollup, balance, total, and driver atomically.
- AI organization positive spend updates raw usage, organization balance, member daily usage, total, and driver atomically.
- AI zero-cost/BYOK rows create no Cost Insights rows.
- Charged Exa personal and organization requests produce Variable spend.
- Exa free allowance produces no Cost Insights spend.
- Coding Plan activation and renewal produce Scheduled spend once.
- KiloClaw enrollment and Worker renewal produce Scheduled spend once.
- Duplicate KiloClaw/Coding Plan paths do not increment rollups.
- KiloClaw settlement, credit grants, top-ups, expirations, refunds, and accounting adjustments produce no rollups.
- Rollup failure prevents the corresponding charge/source transaction from committing.

### Read tests

- 24h, 7d, 30d, and 90d queries return exact UTC bucket counts.
- Covered missing hours return zero.
- Uncovered and degraded hours remain marked unknown.
- Category totals equal bucket totals.
- Exact rolling-24h reads combine full rollup hours and raw boundary fragments without double counting.
- Top drivers aggregate combined dimensions and use deterministic tie-breaking.
- Personal and organization owner data cannot cross scopes.

### Backfill and repair tests

- Canonical source fixtures map to the same category/source/driver values as live capture.
- Backfill rerun produces identical totals and drivers.
- Failed hour does not move coverage.
- Empty source hour advances coverage without aggregate rows.
- Unresolved degraded intervals suppress zero-fill until repair and reconciliation resolve them.
- Targeted repair corrects missing and inflated rows.
- Targeted repair deletes rows whose canonical source sum is zero.
- Concurrent late source contribution plus repair is counted exactly once.
- Historical unknown fields use `other` rather than mutable current values.

## Delivery sequence

### Slice 0: spend-writer audit

Repeat the direct balance-mutation audit, classify every production mutation, and fail planning/implementation review on unexplained writers. Record exclusions and canonical source identity in tests or repository-local code comments next to the central capture contract.

Outcome: implementation has a closed producer inventory before it claims complete coverage.

### Slice 1: schema and capture primitive

Files:

- `packages/db/src/schema-types.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/cost-insights-rollups.ts`
- `packages/db/package.json`
- Generated migration and schema/helper tests

Outcome: tables and transaction-bound capture helper exist, with no producer calling them yet.

Generate migration with `pnpm drizzle generate`. Do not hand-write or edit generated migration SQL, snapshot, or journal.

### Slice 2: already-transactional scheduled spend

Integrate Coding Plan activation/renewal and KiloClaw web/Worker charge paths. These paths need the least transaction restructuring and validate the shared helper in both Next.js and Cloudflare Worker environments.

Outcome: all Scheduled Credit spend dual-writes atomically.

### Slice 3: AI Gateway transaction consolidation

Refactor personal and organization AI persistence into one caller-owned transaction, add capture, and move organization low-balance email scheduling after commit.

Outcome: AI Gateway Variable Credit spend dual-writes atomically for both owner types.

### Slice 4: Exa transaction consolidation

Combine Exa log, monthly counter, owner charge, organization member usage, and capture in one transaction.

Outcome: all known Variable Credit spend paths dual-write atomically.

### Slice 5: read repository and coverage

Implement dense hourly evidence, current-hour totals, exact rolling-24h composition, top drivers, coverage, and degraded-interval reads.

Outcome: application work can consume one Postgres datasource without knowing source ledgers.

### Slice 6: backfill, repair, and shadow validation

Implement canonical aggregation, dry-run reconciliation, 7-day then 90-day backfill, and targeted owner repair.

Outcome: coverage reaches 90 days with zero reconciliation differences before alerts or dashboard data rely on it.

## Verification commands

Before database-backed tests, check Postgres with:

```sh
docker compose -f dev/docker-compose.yml ps postgres
```

Start it if needed with `pnpm test:db`.

Run the narrowest tests for each slice, including:

```sh
pnpm --filter @kilocode/db typecheck
pnpm test -- apps/web/src/lib/ai-gateway/processUsage.test.ts
pnpm test -- apps/web/src/lib/exa-usage.test.ts
pnpm test -- apps/web/src/lib/coding-plans
pnpm --filter kiloclaw-billing test
scripts/typecheck-all.sh --changes-only
pnpm format
```

Use actual package/test paths discovered during implementation where directory arguments are unsupported. Full monorepo `pnpm typecheck` is not the default because repository guidance requires targeted checks unless the change breadth warrants the full run.

Benchmark AI Gateway capture against production-shaped concurrency using the existing usage benchmark before rollout. Compare baseline versus rollup-enabled p50/p95/p99 persistence latency and inspect lock waits.

## Acceptance criteria

- Every production `microdollars_used` increment has an explicit included/excluded classification.
- AI Gateway, charged Exa, pure-credit KiloClaw, and Coding Plan spend update totals and one driver bucket atomically with the charge.
- Snowflake is absent from capture, reads used for correctness, repair, and backfill.
- A failed mandatory rollup write rolls back its source spend transaction.
- Duplicate billing attempts do not duplicate rollups.
- Hour keys are explicit UTC hours.
- Personal and organization totals cannot collide or leak across scopes.
- Covered zero-spend hours are distinguishable from unknown or degraded history.
- Exact rolling-24h reads use rollup interiors plus canonical raw boundary fragments.
- Newest 7 days reconcile before anomaly work starts; full 90 days reconcile before 30d/90d dashboard evidence is treated as complete.
- Bootstrapped and newly captured rollup rows have no retention expiry.
- Backfill and targeted repair are absolute, idempotent, bounded, and resumable.
- No email, display name, secret, prompt, or arbitrary request payload is persisted in rollup tables.
- Capture latency and lock contention stay within limits agreed from benchmark results.
