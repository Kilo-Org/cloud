# Cost Insights data layer implementation plan

## Status

Implemented in commit `f060ef557` and validated against local PostgreSQL. Slices 0 through 5 are complete in code. Slice 6 has working canonical aggregation, backfill, targeted repair, reconciliation, coverage, degraded-interval handling, and operator scripts, but production execution remains pending.

Do not mark this plan complete until production EXPLAINs, capture latency and lock-contention benchmarks, production Exa historical partition indexes, coordinated web/Worker cutover, contiguous 7-day and 90-day backfill, canary reconciliation, deployment-boundary reconciliation, and production observability are complete.

Alert evaluation, Cost Insight Events, notifications, tRPC routes, and UI are implemented in the follow-on Cost Insights slice described in `.plans/cost-insights.md`. Business rules remain in `.specs/cost-insights.md`; canonical terminology remains in `CONTEXT.md`.

## Implemented result

- Generated migration `packages/db/src/migrations/0173_workable_carlie_cooper.sql` adds four unpartitioned Spend evidence tables with owner, UTC-hour, taxonomy, amount, count, coverage, and degraded-interval constraints.
- `@kilocode/db/cost-insights-rollups` provides validated UTC bucketing, normalized driver dimensions, versioned SHA-256 driver keys, owner-hour advisory locking, and one-statement additive total/driver capture.
- AI Gateway, charged Exa, Coding Plan activation/renewal, and pure-credit KiloClaw enrollment/renewal capture Variable or Scheduled Credit spend in the same transaction as their source and balance mutations.
- AI Gateway, charged Exa, Coding Plan activation/renewal, and pure-credit KiloClaw enrollment schedule Cost Insights evaluation after web transactions commit. KiloClaw Worker renewal captures are evaluated by the hourly Cost Insights sweep.
- `apps/web/src/lib/cost-insights/spend-repository.ts` provides dense hourly reads, current-hour totals, top drivers, coverage state, and exact rolling `[asOf - 24h, asOf)` reads.
- `apps/web/src/lib/cost-insights/canonical-sources.ts` and `rollup-maintenance.ts` provide four-source canonical aggregation, bounded absolute replacement, owner repair, reconciliation, and degraded-interval workflows.
- `apps/web/src/scripts/db/cost-insights-rollups.ts` defaults to dry-run reconciliation and requires explicit bounded execution. `exa-usage-log-indexes.ts` performs bounded, newest-first partition-local Exa index rollout.
- `dev/seed/cost-insights/spend-evidence.ts` creates local-only personal and organization fixtures with 90 days of sparse evidence, current-hour spikes, Scheduled spend, and member driver attribution.

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

The implementation adds four unpartitioned tables:

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

`CostInsightSpendCategory`, `CostInsightSpendSource`, and `CostInsightRollupDegradedReason` are registered in `SCHEMA_CHECK_ENUMS` and enforced through `enumCheck` constraints in `packages/db/src/schema.ts`.

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

The subpath-only export `@kilocode/db/cost-insights-rollups` is backed by `packages/db/src/cost-insights-rollups.ts` and exported through `packages/db/package.json`. It is not re-exported from the broad root barrel, so the billing-critical persistence boundary remains visible in web and Worker call sites.

The module owns:

- Spend owner, category, source, and driver input types.
- Input validation.
- Explicit UTC bucket calculation.
- Transaction-scoped owner-hour advisory locking.
- Total and driver additive upserts in a fixed lock order.

Generic owner-range reads live in `apps/web/src/lib/cost-insights/spend-repository.ts`. Keeping them out of the shared package avoids pulling application read policy into the billing-critical web/Worker capture boundary.

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

The implemented helper performs lock acquisition, total upsert, driver upsert, and digest-collision outcome reporting in one SQL statement. Every writer and targeted repair acquires the same owner-hour advisory lock. This prevents an absolute repair from overwriting a concurrent live contribution. Total mutation precedes driver mutation in the statement.

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

Source-specific canonical aggregation lives in `apps/web/src/lib/cost-insights/canonical-sources.ts`. Live and historical mapping share constants for category, source, product, feature, and fallback values. Mapper fixtures cover representative values, while full real-source/live-digest parity remains a test gap.

Historical gaps map to `other`; the implementation does not infer mutable event-time data from current subscriptions or user profiles.

### Bulk backfill script

The operator script at `apps/web/src/scripts/db/cost-insights-rollups.ts` is auto-discovered by the existing script runner. It defaults to dry-run reconciliation and requires explicit execution for writes.

Implemented parameters:

- `--execute` to enable mutation; omission runs reconciliation only.
- Required `--start-hour`, `--end-hour`, and `--max-hours` bounds.
- Optional `--sleep-ms` pacing.
- Optional one-time `--live-capture-start-hour` coverage initialization.

Source/owner diagnostic filters and a targeted-repair command are not implemented. Add them only if they retain the same canonical mapping and bounded execution rules.

Process newest completed hours first so every successful step extends one contiguous interval backward from live capture:

1. Deploy all live writers.
2. Record `live_capture_start_hour` as the first full UTC hour after every writer is active.
3. Rebuild the immediately preceding hour, then continue backward through the newest 7 days.
4. Continue the same contiguous sequence to 90 days before the public dashboard relies on 30d/90d evidence.
5. Retain the bootstrapped 90 days and all future rollups indefinitely. Older historical expansion is optional follow-up work, not a launch requirement.

Before execution, run `EXPLAIN` against production-shaped data for every source query. Confirm `microdollar_usage.created_at` range scans, Exa partition pruning, and bounded credit-transaction/term scans. Do not add or replace indexes on the large raw usage table without a separate online-index rollout plan.

The implemented operator processes only completed pre-cutover hours and uses this shape:

1. Load up to 24 hours from all four canonical source families in one read-only `REPEATABLE READ` snapshot with half-open predicates.
2. Build owner/category totals and owner/category/source/driver buckets in memory.
3. Process hours newest-first. For each hour, delete existing aggregate rows and insert absolute staged results in its own bounded transaction.
4. Verify owner totals equal driver amounts and counts.
5. Move `coverage_start_hour` backward only when the hour is contiguous with existing coverage.
6. Reconcile the full requested range after execution. A mismatch records an unresolved degraded interval and fails the execute run.

The 24-hour source chunk avoids hourly source-query amplification while keeping writes and coverage advancement hour-sized. Absolute replacement makes reruns safe. The global path refuses live or post-cutover hours; overlapping or late owner-hours use advisory-locked targeted repair.

Production use must still set practical statement/lock limits and monitor database load, WAL, replication lag, lock waits, and reconciliation differences. The script does not stop automatically from those telemetry signals.

The deployment boundary and preceding hour need a second reconciliation pass after deferred usage persistence drains. If a later source row exposes a gap, create a degraded interval first, repair affected owner-hours, reconcile the interval, then resolve it. Current library functions support this lifecycle, but no single operator command performs targeted repair plus safe resolution.

### Targeted owner repair

`repairOwnerSpendRollups(owner, startHour, endHourExclusive)` is implemented with an explicit caller-supplied maximum. Future Spend Alert enablement must use a hard seven-day cap. Operator repair may use up to 90 days with lower concurrency and stricter timeouts, but no targeted-repair CLI is available yet.

For each owner-hour:

1. Acquire the same owner-hour advisory lock used by live capture.
2. Re-read every canonical source family for that owner and hour.
3. Build absolute totals and driver buckets.
4. Replace that owner's aggregate rows for the hour in one transaction.
5. Verify totals against drivers.

Delete aggregate rows when the canonical result is zero. The repair path must be idempotent and safe to retry.

### Reconciliation

Dry-run reconciliation compares rollups with canonical source sums for bounded hour ranges and reports:

- Missing totals.
- Amount differences.
- Record-count differences.
- Driver sum differences.
- Unknown taxonomy values.
- Coverage holes.

Run canaries for high-volume organizations, normal personal users, Exa users, KiloClaw users, and Coding Plan users before any alert evaluator consumes the tables.

## Observability

Current operator output reports backfill hour duration, staged total/driver/source counts, canonical microdollars, reconciliation mismatch classes, and coverage advancement. AI Gateway capture failures include bounded Cost Insights context without request payloads.

Production instrumentation still needs:

- Capture latency by source and category.
- Total/driver upsert failure and transaction rollback counts.
- Advisory-lock wait duration and contention.
- Captured rows and microdollars by source/category.
- Reconciliation mismatch amount, not only count/class.
- Coverage age and unresolved degraded-interval count/age.
- Exact rolling-24-hour boundary query latency.

Do not attach prompts, auth headers, cookies, tokens, Exa request bodies, user email, or display name. Monitor tuple/advisory lock waits, WAL volume, index growth, autovacuum lag, replica lag, and AI Gateway/Exa persistence latency through existing database telemetry during rollout.

## Test status

### Schema and capture

| Coverage | Status | Remaining |
|---|---|---|
| Exactly-one-owner, controlled values, UTC normalization, owner isolation | Done | Add direct duplicate-insert assertions for both partial unique indexes if schema regression coverage needs to be stricter |
| Driver fallback, bounds, digest determinism, collision rollback | Done | None for v1 contract |
| Additive totals/drivers, unsafe input rejection, concurrent exact sums | Done | Add existing-row additive overflow coverage near JavaScript safe-integer limit |
| Repair and live capture on same owner-hour | Done | None |

### Producer integration

| Coverage | Status | Remaining |
|---|---|---|
| AI personal source, metadata, daily aggregate, balance, total/driver, rollback | Done | Add explicit Coding Plan-backed BYOK no-spend fixture |
| AI organization source, balance, member usage, rollup | Partial | Add focused driver-dimension and forced organization rollback assertions |
| Charged/free Exa personal and organization behavior | Done | None for current mapping |
| Coding Plan activation and renewal | Partial | Existing tests verify capture inputs and rollback with a mocked helper; add real-rollup integration coverage |
| KiloClaw enrollment and Worker renewal | Partial | Existing tests verify idempotency/capture ordering with mocked helper; add real-rollup integration coverage |
| Explicit accounting exclusions | Partial | Add focused proof that settlement, grants, top-ups, expiration, refunds, and adjustments leave rollups unchanged |

### Reads and maintenance

| Coverage | Status | Remaining |
|---|---|---|
| Covered zero versus uncovered/degraded unknown | Done | None |
| Exact rolling 24h with raw boundary fragments | Done | Add production-shaped latency benchmark |
| Preset ranges | Partial | Add exact 24h, 7d, 30d, and 90d bucket-count tests |
| Top drivers | Partial | Add deterministic tie ordering, category filter, and organization-scope integration tests |
| Canonical mapping parity | Partial | Pure mapping fixtures cover all sources; add real-source/live-digest parity fixtures for all four families |
| Backfill rerun and zero-source deletion | Done | None |
| Coverage advancement failures and empty hours | Remaining | Add failed-hour no-advance and empty-hour advance tests |
| Targeted repair | Partial | Add nonzero missing/inflated correction; zero deletion and live-concurrency behavior are covered |
| Degraded lifecycle | Partial | Suppression and resolution are covered separately; add full record, repair, reconcile, resolve test |

## Delivery status

| Slice | Status | Result or remaining gate |
|---|---|---|
| 0. Spend-writer audit | Done | Current production increments are classified and guarded by `spend-writer-audit.test.ts`; keep the regex inventory updated for new mutation forms |
| 1. Schema and capture primitive | Done | Four tables, controlled values, generated migration, subpath export, capture helper, and database tests exist |
| 2. Scheduled spend | Done in code | Coding Plan and KiloClaw web/Worker paths dual-write atomically; real-rollup producer integration tests remain desirable |
| 3. AI Gateway consolidation | Done | Personal/organization source, charge, daily usage, and rollup share one transaction; low-balance scheduling occurs after commit |
| 4. Exa consolidation | Done | Log, monthly counter, charge, member usage, and rollup share one transaction |
| 5. Read repository and coverage | Done in code | Dense hourly, current hour, top drivers, exact rolling 24h, coverage, and degraded reads exist; preset/tie/scope test gaps remain |
| 6. Backfill, repair, shadow validation | Partial | Code and local validation are complete; production indexes, EXPLAINs, cutover, 7-day/90-day runs, canaries, boundary reconciliation, and observability remain |

## Production rollout checklist

- [ ] Deploy migration before mandatory capture code can execute.
- [ ] Roll out historical Exa partition indexes with an explicit small `--max-partitions` bound; verify created indexes are valid and ready.
- [ ] Run production-shaped EXPLAINs for AI Gateway, Exa, Coding Plan, and KiloClaw canonical queries.
- [ ] Benchmark capture-enabled AI Gateway and Exa persistence at production-shaped concurrency; record p50/p95/p99 latency and advisory-lock waits.
- [ ] Coordinate web and Worker deployments, then choose the first full UTC `live_capture_start_hour` after all writers are active.
- [ ] Let deferred AI Gateway/Exa persistence drain before replacing pre-cutover hours.
- [ ] Backfill and reconcile the newest contiguous seven days before anomaly evaluation uses baseline history.
- [ ] Continue contiguous backfill and reconciliation to 90 days before 30d/90d UI ranges claim complete evidence.
- [ ] Run canaries for high-volume organizations, ordinary personal owners, Exa, KiloClaw, and Coding Plan usage.
- [ ] Reconcile cutover hour and preceding hour again after deferred persistence drains.
- [ ] Monitor database load, WAL, replication lag, lock waits, index growth, autovacuum, capture latency, coverage age, and degraded intervals.
- [ ] Document or add a bounded operator workflow for targeted repair and degraded-interval resolution.

## Operator and local seed notes

`apps/web/src/scripts/db/exa-usage-log-indexes.ts` creates two partial indexes per historical Exa leaf partition with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Future partitions receive equivalent indexes during provisioning. Production runs should always set a small `--max-partitions`. Before and after each planned index, the operator checks the schema-qualified `pg_index.indisvalid` and `pg_index.indisready` state; an interrupted invalid index is dropped and rebuilt concurrently.

`dev/seed/cost-insights/spend-evidence.ts` is local-only and refuses production or non-loopback database targets. It seeds dedicated personal and organization owners with canonical AI Gateway, Exa, Coding Plan, and KiloClaw records and matching owner rollups. Default `--coverage-mode preserve` never deletes or rewrites global v1 coverage. For full 1h (current UTC hour), 24h, 7d, 30d, and 90d UI evidence on a disposable local database, run:

```sh
pnpm dev:seed cost-insights:spend-evidence --rollup-mode healthy --coverage-mode disposable-full
```

`disposable-full` verifies that the 90-day fixture range has no unrelated canonical records, owner rollups, or unresolved degraded intervals before replacing global v1 coverage, then verifies the written coverage state. It refuses databases containing unrelated evidence; use normal preserved coverage on shared or cloned databases.

## Verification completed

Local implementation validation recorded before commit:

- 389 web and Cost Insights tests passed.
- 41 database/schema tests passed.
- 185 KiloClaw Worker tests passed.
- Targeted web, database, and Worker typechecks and lint passed.
- `pnpm format`, `git diff --check`, and `pnpm drizzle:verify-bootstrap` passed.
- Full monorepo typecheck was skipped under repository guidance.

Local operator and seed validation:

- Four Exa partial indexes were created across two local historical partitions and rerun idempotently.
- Migration tables and journal entry were confirmed in local PostgreSQL. Drizzle CLI returned exit 1 after applying the migration, so production migration execution still needs normal deployment verification.
- One completed empty pre-seed hour was backfilled and reconciled with zero mismatches.
- The dev seed ran twice with identical results: 374 Variable records and 6 Scheduled records.
- All 2,160 seeded hourly buckets reconciled with zero mismatches and zero coverage holes; canonical and rollup totals matched for both fixture owners.

These results prove local behavior, not production rollout or performance acceptance.

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

| Criterion | Status |
|---|---|
| Every current production `microdollars_used` increment has an included/excluded classification | Met; keep audit guard current |
| AI Gateway, charged Exa, pure-credit KiloClaw, and Coding Plan spend atomically update totals and a driver bucket | Met in implementation |
| Snowflake is absent from capture, correctness reads, repair, and backfill | Met |
| Mandatory rollup failure rolls back source spend transaction | Met |
| Duplicate billing attempts do not duplicate rollups | Met in implementation; real-rollup producer integration proof is partial |
| Hour keys are explicit UTC hours | Met |
| Personal and organization totals cannot collide or leak across scopes | Met at schema/repository level |
| Covered zero-spend hours differ from unknown or degraded history | Met |
| Exact rolling 24h uses rollup interiors plus canonical raw boundaries | Met |
| Newest seven production days reconcile before anomaly work starts | Pending production rollout |
| Full 90 production days reconcile before 30d/90d evidence claims completeness | Pending production rollout |
| Bootstrapped and newly captured rollups have no retention expiry | Met |
| Backfill and targeted repair are absolute, idempotent, bounded, and resumable | Met in implementation |
| Rollups contain no email, display name, secret, prompt, or arbitrary request payload | Met |
| Capture latency and lock contention meet agreed limits | Pending production-shaped benchmark |
| Production telemetry detects capture failures, contention, stale coverage, and degraded intervals | Pending |
