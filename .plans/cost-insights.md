# Cost Insights Implementation Plan

This plan covers Cost Insights v1, including Spend Alerts and Cost Suggestions. Durable product behavior and invariants live in `.specs/cost-insights.md`. `CONTEXT.md` owns canonical domain language. `.plans/cost-insights-data-layer.md` is the implementation plan for Credit-spend capture, owner-hour rollups, read primitives, coverage, backfill, and repair.

## Status

Implemented in this branch. The Spend evidence data layer was implemented in commit `f060ef557`; this follow-on slice adds Spend Alert and Cost Suggestion config, owner state, events, notification delivery, evaluation, tRPC procedures, live UI wiring, sidebar attention, email templates, cron jobs, and retention.

Current state:

- Credit-spend capture, owner-hour rollups, canonical Postgres reads, coverage, degraded intervals, exact rolling-24-hour reads, backfill, repair, reconciliation, operator scripts, and a local dev seed are implemented.
- Spend Alert and Cost Suggestion config, owner state, active suggestions, Cost Insight Events, notification deliveries, alert/suggestion evaluation, hourly sweep, and 90-day retention cleanup are implemented.
- Personal and organization routes are wired to live tRPC data and mutations. `/config` is the settings route; old `/settings` paths redirect. Ask Kilo v1 routes render UI-only conversation controls without processing questions.
- Cost Insights sidebar placement is directly below Usage. Sidebar attention uses the lightweight unreviewed-alert endpoint.
- Post-commit evaluation scheduling is wired for web spend paths: AI Gateway, charged Exa, Coding Plan activation and renewal, and pure-credit KiloClaw enrollment. KiloClaw Worker renewal captures remain covered by the hourly evaluation sweep.
- Production rollout is not complete. Migration deployment, coordinated web/Worker cutover, production EXPLAINs, latency and lock benchmarks, Exa historical index rollout, contiguous 7-day then 90-day reconciliation, and live notification smoke tests remain operational gates.

## Confirmed Decisions

- Cost Insights is the Usage-adjacent surface for Spend Alerts.
- Spend Alerts are opt-in for personal users and organizations.
- Spend Alerts are alert-only.
- Spend Alerts must not block spend, pause usage, throttle usage, suppress auto-top-up, reject paid requests, or emit Spend Alerts-specific HTTP 402 responses.
- Existing depleted-credit and low-balance billing behavior remains separate.
- Cost Insights v1 is publicly visible to eligible owners without a release-toggle gate.
- Cost Insights routes mirror Security Agent shape: dashboard plus settings for personal and organization owners.
- Cost Insights dashboard shows read-only recent spend evidence even when Spend Alerts are disabled.
- Cost Insights dashboard default evidence shows 24-hour spend summary plus 7-day hourly chart.
- Cost Insights dashboard supports preset evidence ranges: 24h, 7d, 30d, and 90d.
- Spend Alert settings expose only Spend Alert enablement and one optional spend threshold in v1.
- Cost Suggestions are enabled by default through an owner-scoped setting independent from Spend Alert enablement.
- Disabling Cost Suggestions suppresses new suggestion emails and active suggestion cards without removing prior suggestion activity from Cost Insight Event history.
- Active Cost Suggestions appear on the Cost Insights dashboard, with Spend Alerts taking visual and ordering priority when both are active.
- Cost Suggestions are advisory: they do not guarantee savings, purchase or change subscriptions, or alter spend behavior.
- V1 does not expose spend limits, spend pauses, anomaly sensitivity controls, custom anomaly multipliers, custom anomaly floors, custom recipients, product exclusions, model exclusions, or per-member Spend Alert policy.
- First enable immediately evaluates current anomaly state and configured spend threshold state.
- First enable can create alert email/banner when current spend already crosses enabled alert state.
- Disabling Spend Alerts keeps owner config row disabled rather than deleting it.
- Re-enabling Spend Alerts reuses existing saved settings unless changed.
- Re-enable immediately evaluates current rolling spend and current-hour anomaly state.
- While disabled, settings changes save only and do not evaluate controls, create events, or send emails.
- Spend Alerts evaluate all owner Credit spend, with anomaly alerts focused on hourly Variable Credit spend bursts.
- Organization Cost Insights is visible and manageable only by active organization owners and billing managers.
- Organization members without Cost Insights access are told to contact an organization owner or billing manager.
- Kilo admins may inspect Spend Alerts under existing admin patterns but cannot disable alerts or change customer Spend Alert settings in v1 without owner/billing-manager authority.
- Detection uses Postgres source-of-truth data, not Snowflake-only usage analytics.
- Spend Alerts use dedicated normalized tables for owner config, owner state, owner-hour totals, owner-hour driver buckets, rollup coverage, degraded coverage intervals, and Cost Insight Events.
- Owner-hour totals and driver buckets are sparse aggregates; covered zero-spend hours are derived at read time rather than stored as zero rows.
- Missing rows count as zero only inside reconciled coverage that does not overlap an unresolved degraded interval; uncovered or degraded hours remain unknown.
- Spend Alerts owner-hour totals and driver buckets are maintained for all owners, including owners who have not enabled alerts.
- Spend Alerts driver buckets use controlled taxonomy values, with `other` for unknown source classification.
- V1 source taxonomy is `ai_gateway`, `kiloclaw`, `coding_plan`, and `other`.
- V1 owner-hour totals and driver buckets are retained indefinitely.
- Owner-hour totals are keyed by spend category, with separate rows for Variable and Scheduled Credit spend.
- Owner-hour buckets use UTC hour start timestamps.
- Driver buckets are keyed by spend category as well as source and driver dimensions.
- Driver buckets and event snapshots may retain actor user IDs but must not copy actor email or actor display name.
- Driver buckets store actor user ID for both personal and organization spend; UI resolves labels from current user rows at render time.
- Driver buckets store total spend and contributing spend-record count.
- Every Credit spend path updates owner-hour totals and applicable driver buckets atomically with spend recording.
- Credit spend does not commit if corresponding owner-hour total or driver-bucket update fails.
- Enablement uses existing hourly owner rollups for baseline, with Postgres backfill or repair when rollups are missing.
- Enablement repair targets the prior 7 days; 30d and 90d dashboard evidence is not treated as complete until contiguous reconciled coverage reaches the requested range.
- Initial rollout bootstraps 90 days of Postgres evidence. Bootstrapped and newly captured rollups are retained indefinitely.
- Async evaluation uses current config at evaluation time.
- V1 anomaly detection uses product-managed fixed sensitivity.
- V1 anomaly threshold is `max(3 * baseline, 10 USD floor)` when baseline data is available.
- Owners without at least 24 completed hourly buckets use a 25 USD current-hour Variable Credit spend starter floor.
- Anomaly detection compares current partial-hour Variable Credit spend to full-hour threshold and can trigger before hour end.
- Anomaly baseline uses completed prior UTC-hour buckets and excludes current hour.
- Anomaly baseline includes zero-spend completed hours in trailing 7-day window.
- Owners with at least 24 completed hourly buckets use available-history p95 before 7 full days exist.
- Anomaly acknowledgment reviews current UTC-hour anomaly episode; future anomalous hours can alert again.
- Spend threshold is one optional USD cent value stored as microdollars.
- Spend threshold crossings create email, event history, and in-app review banner.
- Spend Threshold Alert evaluation uses exact elapsed `[asOf - 24h, asOf)` spend, not a 24-UTC-bucket approximation.
- Threshold review offers acknowledge, adjust threshold, or disable threshold; acknowledge alone is allowed.
- Threshold acknowledgment reviews current threshold-crossing episode until exact rolling spend falls below threshold and crosses again.
- Disabling threshold clears current threshold episode state.
- Config and review actions do not require reason text; events record actor, action, old/new values where applicable, and timestamp.
- Event history retains summarized Cost Insight Events for 90 days.
- Event history remains fixed to 90 days even though hourly rollups are retained indefinitely.
- Cost Insight Events are deleted after 90 days rather than merely hidden.
- Event retention is enforced by daily app cron deletion.
- Alert events snapshot top drivers at event creation time.
- Alert event snapshots include top 5 spend drivers.
- Events store direct evaluated settings in snapshots and do not require config version tracking in v1.
- Config events store changed fields plus resulting key settings, not full config snapshots.
- Owner state stores active episode dedupe/review state separately from 90-day event history.
- Owner state stores minimal current episode markers for anomaly hour, threshold crossing state, and review status.
- Spend Alerts store owner-scoped events separately from per-recipient notification delivery rows.
- Spend Alerts snapshot intended recipients at event creation and revalidate access before delivery.
- Notification delivery rows are deleted with parent event after 90 days.
- Active banners and review actions are visible to all current authorized managers, regardless of original email recipient snapshot.
- Every production `microdollars_used` mutation must be classified as included Credit spend or an explicit non-spend/accounting exclusion before rollup ingestion is considered complete.
- Data-layer implementation and rollout follow `.plans/cost-insights-data-layer.md`; physical schema, locking, driver-key, source-mapping, backfill, and repair mechanics remain there rather than being duplicated in this plan.
- Implementation should ship as independently verifiable vertical slices.

## Vertical slices

The spend-writer audit prerequisite is complete and guarded by `apps/web/src/lib/cost-insights/spend-writer-audit.test.ts`.

| Slice | Status | Implemented | Remaining |
|---|---|---|---|
| 1. Schema and policy primitives | Implemented | Owner-hour totals, driver buckets, coverage, degraded intervals, config, owner episode state, active suggestions, Cost Insight Events, notification delivery, and pure policy helpers | Production migration deployment |
| 2. Spend evidence data layer | Implemented locally; production rollout pending | Atomic capture for AI Gateway, charged Exa, Coding Plan, and pure-credit KiloClaw; dense hourly reads; exact rolling 24h; top drivers; canonical repair/backfill/reconciliation; local seed | Production cutover, 7-day and 90-day backfill, production reconciliation, query-plan checks, performance benchmarks, and operational telemetry |
| 3. Spend Alert evaluation | Implemented | Fixed anomaly policy, threshold crossing logic, first-enable/re-enable evaluation, web post-spend scheduling, hourly sweep, events, notification delivery creation, and episode dedupe | Production smoke tests and KiloClaw Worker post-renewal dispatch if lower latency than hourly sweep is required |
| 4. Cost Suggestion evaluation | Implemented | Default-on config, eligibility heuristics, evidence windows, active identity, CTA selection, dismissal, and events | Product tuning from production evidence |
| 5. Notifications and banners | Implemented | Recipient snapshots, retryable email deliveries, dispatch-time access checks, Spend Alert email template, dashboard banners, suggestion cards, and deep links | Live email provider smoke test |
| 6. Cost Insights UI | Implemented | Personal/org dashboard, `/config`, activity, UI-only Ask Kilo, tRPC reads/mutations, actor labels, sidebar attention, admin read-only settings, and route cleanup | Browser smoke after deployment |
| 7. Retention and audit cleanup | Implemented | Daily deletion of 90-day events and child delivery rows while compact owner state remains | Production cron smoke |

## Implementation areas

| Area | Current state | Remaining work |
|---|---|---|
| `packages/db/src/schema.ts` | Spend evidence, config, owner state, active suggestion, event, and notification delivery tables are implemented | Production migration deployment |
| `packages/db/src/cost-insights-rollups.ts` | Transaction-bound capture is implemented for web and Worker callers | Add telemetry only if it belongs at this boundary; generic reads remain in the web repository |
| `packages/db/src/migrations/` | Generated migrations `0173_workable_carlie_cooper.sql` and `0174_young_molecule_man.sql` contain Spend evidence and alert/suggestion/event storage | Never edit generated migration artifacts by hand |
| `apps/web/src/lib/ai-gateway/` | Positive personal and organization Variable Credit spend captures atomically and schedules async evaluation after commit | Production smoke |
| `apps/web/src/lib/organizations/` | Organization mutation is transaction-aware; Cost Insights reuses owner/billing-manager authorization and recipient checks | Production smoke |
| `apps/web/src/lib/exa-usage.ts` | Charged positive Exa usage captures atomically as `other`/`exa` and schedules async evaluation after commit | Finish production partition-index rollout |
| `apps/web/src/lib/kiloclaw/` | Pure-credit enrollment captures Scheduled Credit spend and schedules async evaluation after commit | Production smoke |
| `services/kiloclaw-billing/` | Pure-credit renewal captures Scheduled Credit spend with request-scoped DB use | Hourly sweep evaluates renewal spend; add direct side-effect dispatch only if production latency requires it |
| `apps/web/src/lib/coding-plans/` | Activation and renewal capture Scheduled Credit spend and schedule async evaluation after commit | Production smoke |
| `apps/web/src/lib/cost-insights/` | Spend reads, config/state/event repositories, alert policy/evaluation, suggestion evaluation, notification workflows, jobs, retention, and presentation mapping exist | Production smoke and tuning |
| `apps/web/src/routers/` | Personal and organization Cost Insights procedures exist for dashboard, settings, event history, acknowledgment, suggestion dismissal, and attention state | Authorization regression expansion |
| `apps/web/src/app/(app)` | Personal and organization routes render live dashboard, activity, UI-only Ask Kilo, and `/config`; old `/settings` paths redirect | Browser smoke |
| `apps/web/src/components/cost-insights/` | Dashboard, UI-only Ask Kilo, settings, activity, banners, suggestions, loading/error states, and actor-label display are wired to live data | Browser smoke |
| `apps/web/src/emails/` | Spend Alert email exists with owner-correct links | Live email provider smoke |
| `apps/web/src/app/api/cron/` and `apps/web/vercel.json` | Hourly evaluation sweep and daily 90-day retention cleanup are registered | Production cron smoke |

## Required tests

| Test area | Status | Remaining coverage |
|---|---|---|
| Spend-writer inventory | Done | Keep the repository guard current when new balance mutations are added |
| Atomic capture and rollback | Done for current producers | Add real-rollup integration coverage for Coding Plan and KiloClaw paths that currently mock capture |
| Owner isolation, UTC buckets, covered zero, unknown/degraded history | Done at repository/data-layer level | Add more API authorization and organization read-scope tests |
| Exact rolling `[asOf - 24h, asOf)` | Done | Benchmark high-volume boundary fragments before per-spend threshold evaluation |
| Backfill, repair, reconciliation | Partial | Add production canaries and broader degraded-interval lifecycle coverage |
| Preset evidence ranges | Partial | Add exact 24h, 7d, 30d, and 90d bucket-count tests plus top-driver tie/category tests |
| Config and authorization | Partial | Threshold validation has pure coverage; add router-level owner/billing-manager/member/admin tests |
| Spend Anomaly Alerts | Partial | Policy helper coverage exists; add repository-backed dedupe, acknowledgment, and first-enable tests |
| Spend Threshold Alerts | Partial | Add exact crossing/recovery/recrossing, adjustment, disablement, and first-enable tests |
| Cost Suggestions | Partial | Add repository-backed default enablement, materially-new identity, CTA, and dismissal tests |
| Non-enforcement | Partial | Targeted spend-writer tests still pass; add end-to-end proof that alerts never reject spend or change billing state |
| Events, notifications, banners, and attention | Partial | Add event snapshot, delivery retry/revalidation, and sidebar attention tests |
| Retention | Partial | Add retention job coverage for event and child delivery deletion without owner-state reset |

## Next implementation order

1. Deploy migrations and complete data-layer production rollout gates from `.plans/cost-insights-data-layer.md`.
2. Run production EXPLAINs, capture latency and lock benchmarks, and live cron/email smoke tests.
3. Complete contiguous 7-day then 90-day backfill, canary reconciliation, and deployment-boundary reconciliation.
4. Add router/repository integration tests for organization authorization, alert episode dedupe, notification retry/revalidation, and retention.
5. Decide whether KiloClaw Worker renewals need direct post-commit side-effect dispatch or whether hourly sweep latency is acceptable.

## Verification completed

Implementation commit `f060ef557` was locally validated with targeted web, database, and KiloClaw Worker tests, targeted typechecks/lint, `pnpm format`, `git diff --check`, and empty-database migration bootstrap. Full monorepo typecheck was skipped under repository guidance.

This branch was locally validated with:

- `pnpm --filter @kilocode/db typecheck`
- `pnpm --filter web typecheck`
- `pnpm --filter web lint`
- `pnpm --filter @kilocode/db lint`
- `pnpm --filter web test -- src/lib/cost-insights/policy.test.ts src/lib/exa-usage.test.ts src/lib/coding-plans/index.test.ts src/lib/coding-plans/billing-lifecycle-cron.test.ts src/lib/usageDeduction.test.ts`
- `pnpm format`
- `git diff --check`
- Disposable database migration smoke with `POSTGRES_URL=postgres://postgres:postgres@localhost:5432/<temp> pnpm drizzle migrate`

`pnpm test:db` started healthy Postgres but `drizzle-kit migrate` returned an unhelpful `undefined` error because the local long-lived test database already had a migration row at the new index from prior local state. A disposable database migration smoke passed with the generated migration set. This local migration-table issue is not evidence of SQL invalidity.

The local seed was run twice and reconciled across 2,160 hourly buckets with zero mismatches and zero coverage holes. Canonical totals matched rollups for personal and organization fixture owners. This validates local behavior only; it is not evidence of production rollout.
