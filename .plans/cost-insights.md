# Cost Insights Implementation Plan

This plan covers Cost Insights v1, including Spend Alerts and Cost Suggestions. Durable product behavior and invariants live in `.specs/cost-insights.md`. `CONTEXT.md` owns canonical domain language. `.plans/cost-insights-data-layer.md` is the implementation plan for Credit-spend capture, owner-hour rollups, read primitives, coverage, backfill, and repair.

## Status

Draft plan. Core product decisions are confirmed. Storybook UI exists as design reference. Backend implementation has not started.

## Confirmed Decisions

- Cost Insights is account-level surface for Spend Alerts.
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

## Vertical Slices

Prerequisite: complete the spend-writer audit from `.plans/cost-insights-data-layer.md` so every production `microdollars_used` mutation has an included/excluded classification.

| Slice | Goal | Primary outcomes |
|---|---|---|
| 1. Schema and policy primitives | Establish durable storage and pure policy contracts | Alert and suggestion config/state, owner-hour total, driver-bucket, coverage, degraded-interval, and event tables; shared policy helpers; defaults and validation |
| 2. Spend evidence data layer | Record and expose spend evidence across every Credit-spend path | Atomic Variable/Scheduled capture, dense hourly reads, exact rolling-24h reads, top drivers, 7-day enablement repair, 90-day bootstrap, reconciliation |
| 3. Spend Alert evaluation | Detect anomalies and threshold crossings | Async post-spend evaluation, hourly sweep, event creation, exact threshold semantics, episode dedupe |
| 4. Cost Suggestion evaluation | Create advisory cost-efficiency recommendations | Eligibility/evidence evaluation, active suggestion state, dismissal identity, suggestion events, CTA destinations |
| 5. Notifications and banners | Surface alerts and suggestions without request-side side effects | Email dispatch with per-recipient delivery rows, owner-scoped in-app banner, active suggestion cards, Cost Insights deep links |
| 6. Cost Insights UI | Let owners inspect evidence, configure features, and review outcomes | Dashboard, settings, event history, org member driver links, suggestion actions, sidebar attention state |
| 7. Retention and audit cleanup | Keep event history bounded while preserving rollups and dedupe state | Daily event deletion after 90 days, notification row cleanup, owner state remains compact, rollups remain indefinite |

## Implementation Areas

| Area | Expected change |
|---|---|
| `packages/db/src/schema.ts` | Add Cost Insights config, state, rollup, coverage, degraded-interval, suggestion, notification, and event tables. |
| `packages/db/src/cost-insights-rollups.ts` | Add transaction-bound capture primitive shared by web and Worker spend paths. |
| `packages/db/src/migrations/` | Generate migration from schema with `pnpm drizzle generate`. |
| `apps/web/src/lib/ai-gateway/` | Classify Variable Credit spend and atomically update owner-hour rollups without changing request admission. |
| `apps/web/src/lib/organizations/` | Consolidate organization spend mutation and defer existing low-balance email scheduling until commit. |
| `apps/web/src/lib/exa-usage.ts` | Capture charged Exa requests as Variable Credit spend under source `other` and product `exa`. |
| `apps/web/src/lib/kiloclaw/` | Classify pure-credit hosting enrollment as Scheduled Credit spend and update rollups. |
| `services/kiloclaw-billing/` | Capture pure-credit KiloClaw renewals inside existing Worker billing transactions. |
| `apps/web/src/lib/coding-plans/` | Classify plan purchases and renewals as Scheduled Credit spend when applicable. |
| `apps/web/src/lib/cost-insights/` | Add spend reads, coverage, backfill/repair, alert evaluation, Cost Suggestion evaluation, and event workflows. |
| `apps/web/src/routers/` | Add owner-scoped Cost Insights tRPC procedures. |
| `apps/web/src/app/(*)` | Add personal and organization Cost Insights routes. |
| `apps/web/src/components/` | Add dashboard, settings, banners, suggestions, and sidebar attention UI following existing app patterns. |
| `apps/web/src/emails/` | Add Spend Alert and Cost Suggestion emails with appropriate deep links. |

## Required Tests

- Alert and suggestion config defaulting, validation, independence, authorization, and organization billing-manager access.
- Closed spend-writer audit covering every production `microdollars_used` mutation.
- Hourly rollup writes for AI Gateway and charged Exa Variable Credit spend plus KiloClaw and Coding Plan Scheduled Credit spend.
- All-owner owner-hour total and driver-bucket writes plus enablement baseline reuse.
- Spend-write rollback when required owner-hour total or driver-bucket capture cannot commit.
- Covered zero-spend hours versus uncovered or degraded unknown hours.
- Prior-7-day enablement backfill/repair and reconciled 90-day completeness before 30d/90d evidence is treated as complete.
- Exact rolling `[asOf - 24h, asOf)` spend reads without UTC-bucket approximation or boundary double counting.
- Fixed anomaly formula (`max(3 * baseline, 10 USD floor)`), 25 USD starter floor, 7-day p95 baseline, and once-per-hour dedupe.
- Single spend-threshold crossing dedupe across exact rolling 24-hour windows.
- Cost Suggestion eligibility, default enablement, independent disablement, evidence windows, dismissal identity, CTA destination, and non-guarantee copy.
- Alert-only regression coverage for AI Gateway, Exa, KiloClaw, Coding Plan, and auto-top-up paths.
- Regression coverage that Spend Alerts and Cost Suggestions never reject paid requests or alter spend/subscription state.
- Org event evidence includes member spend drivers without exposing unauthorized org data.
- Sidebar attention state for unreviewed alert; suggestions alone do not use alert attention semantics.
- Email links route to the correct alert review or suggestion context.
- Per-recipient notification retry without duplicate owner-scoped events.
- Recipient access revalidation that skips org recipients who lost manager access before send.
- Current-manager banner, review, suggestion CTA, and dismissal visibility for owners and billing managers.

## Verification

- Run targeted tests for changed web, database, billing, usage, and Cost Insights areas.
- Run targeted type checking or `scripts/typecheck-all.sh --changes-only`; avoid full monorepo typecheck unless broad changes require it.
- Run `pnpm format` before commit.
