# Cost Insights

## Role of This Document

This spec defines business rules and invariants for Cost Insights, Spend Alerts, and Cost Suggestions. It is source of truth for owner scope, anomaly alerts, threshold alerts, alert review, cost-efficiency suggestions, event history, authorization, and user-facing behavior. It deliberately does not prescribe table names, handler names, queue plumbing, or UI component structure.

## Status

Draft -- created 2026-06-24. Updated 2026-06-24 to remove spend-blocking controls. Updated 2026-06-25 to rename the feature from Spend Insights to Cost Insights and add Cost Suggestions. Updated 2026-06-26 to require local-time UI timestamps, make Spend Anomaly Alerts opt-out by default, add independent rolling 7-day and rolling 30-day spend thresholds, and limit initial access to Kilo platform admins. Updated 2026-07-03 to render the 7-day spend-over-time evidence chart in daily buckets instead of hourly for readability; hourly owner-hour rollups and anomaly detection remain unchanged.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Cost Insights**: Dedicated Usage-adjacent surface for viewing spend evidence and configuring Spend Alerts.
- **Spend Alerts**: Owner-scoped alerting capability for unusual or excessive Credit spend.
- **Spend owner**: Personal user or organization whose credit balance is charged for Credit spend.
- **Credit spend**: Existing Kilo billing concept for any operation that increments `microdollars_used`.
- **Variable Credit spend**: Credit spend created by request-metered product usage such as token usage or metered tool/API usage.
- **Scheduled Credit spend**: Predictable Credit spend created by subscription-like purchases, renewals, or hosting deductions.
- **Spend Anomaly Alert**: Spend Alert triggered when short-window owner Credit spend exceeds that owner's normal usage pattern.
- **Spend Threshold Alert**: Spend Alert triggered when owner Credit spend crosses a configured rolling 24-hour, rolling 7-day, or rolling 30-day spend threshold.
- **Spend threshold**: Optional configured rolling 24-hour, rolling 7-day, or rolling 30-day owner Credit-spend amount for Spend Threshold Alerts.
- **Alert acknowledgment**: Authorized owner action that marks the current alert episode as reviewed.
- **Cost Suggestion**: Owner-scoped recommendation based on observed Credit spend that offers an optional action to improve cost efficiency, such as moving eligible usage to a Coding Plan or Kilo Pass.
- **Suggestion dismissal**: Authorized owner action that hides a specific Cost Suggestion without changing spend, subscriptions, or future suggestion eligibility.
- **Cost Insight Event**: Durable owner-scoped record of Spend Alert notifications and reviews, Cost Suggestion creation and dismissal, configuration changes, and disablement.

## Overview

Cost Insights gives personal users and organizations visibility into Credit spend, unexpected increases, and optional ways to improve cost efficiency. Spend Alerts evaluates spend at the owner boundary, sends emails, and shows in-app review banners for anomaly and threshold events. Cost Suggestions uses observed spend to recommend an eligible Coding Plan or Kilo Pass when that option may reduce cost.

Spend Alerts are alert-only. Cost Suggestions are advisory only. Neither capability MUST block spend, pause usage, throttle usage, suppress auto-top-up, reject paid requests, automatically purchase or change a subscription, or return Cost Insights-specific HTTP 402 responses. Existing low-balance and depleted-credit billing behavior remains separate from Cost Insights.

Cost Insights does not replace low-balance alerts, auto-top-up setup, existing organization member daily limits, or product-specific subscription billing. It sits above product surfaces as owner-level spend insight, alerting, and cost-efficiency guidance.

## Rules

### Owner Scope

1. Spend Alerts MUST belong to exactly one Spend owner: one personal user or one organization.
2. Spend Alerts MUST evaluate Credit spend at the Spend owner boundary, not per product by default.
3. All Credit spend charged to a Spend owner MUST count toward that owner's Spend Alert evaluation.
4. Spend Alerts MUST remain inactive until a Spend owner explicitly enables them.
5. During initial rollout, Cost Insights v1 MUST be available only to users whose current Kilo platform user record has `is_admin` set to `true`; this access restriction MUST NOT depend on a release-toggle gate.
6. First enabling Spend Alerts MUST immediately evaluate every enabled alert sub-option: current anomaly state plus each configured rolling 24-hour, rolling 7-day, and rolling 30-day threshold window.
7. First enabling Spend Alerts MAY create alert email and banner when current spend already crosses enabled controls.
8. Disabling Spend Alerts MUST keep the owner config row disabled rather than deleting it.
9. Re-enabling Spend Alerts MUST reuse existing saved settings unless an authorized manager changes them.
10. Re-enabling Spend Alerts MUST immediately evaluate every enabled alert sub-option using current spend, including all three configured threshold windows.
11. While Spend Alerts are disabled, settings changes MUST save only and MUST NOT evaluate controls, create Cost Insight Events, or send emails.

### Authorization

1. Personal Spend Alerts MUST be visible and manageable only when the personal user is a Kilo platform admin.
2. Organization Cost Insights MUST be visible only to Kilo platform admins.
3. Users whose current Kilo platform user record does not have `is_admin` set to `true` MUST NOT view personal or organization Cost Insights dashboards or settings, including through direct route or API access.
4. Cost Insights navigation and attention queries MUST be hidden from non-admin users.
5. Kilo platform admins MAY inspect organization Spend Alerts according to existing administrative access patterns.
6. Kilo platform admins MUST NOT disable organization Spend Alerts or change customer Spend Alert settings in v1 unless they also have owner or billing-manager authority for that owner.

### Routes

1. Personal Cost Insights dashboard MUST be served at `/cost-insights`.
2. Personal Cost Insights settings MUST be served at `/cost-insights/config`.
3. Organization Cost Insights dashboard MUST be served at `/organizations/[id]/cost-insights`.
4. Organization Cost Insights settings MUST be served at `/organizations/[id]/cost-insights/config`.
5. Cost Insights MUST appear directly below Usage in personal and organization sidebars for Kilo platform admins only.
6. Cost Insights sidebar item MUST show attention state when owner has an unreviewed Spend Alert or active Cost Suggestion.
7. Cost Insights routes MUST require current Kilo platform admin authorization and MUST NOT require a feature flag in v1.

### Dashboard and Settings

1. Cost Insights dashboard MUST show current alert state, review actions, and spend evidence.
2. Cost Insights settings MUST own Spend Alert enablement, Spend Anomaly Alert opt-out, and spend threshold configuration.
3. Settings MUST show Spend Anomaly Alerts, the optional rolling 24-hour spend threshold, the optional rolling 7-day spend threshold, and the optional rolling 30-day spend threshold in that order as sub-options of Spend Alerts.
4. V1 settings MUST NOT expose hard spend limits, spend pauses, throttles, product exclusions, model exclusions, custom recipients, anomaly sensitivity controls, custom anomaly multipliers, custom anomaly floors, or per-member Spend Alert policy.
5. Cost Insights dashboard MUST show read-only recent spend evidence even when Spend Alerts are disabled.
6. Cost Insights dashboard default evidence MUST show a 24-hour spend summary and 7-day spend chart.
7. Cost Insights dashboard MUST support preset evidence ranges: current UTC hour, 24h, 7d, 30d, and 90d.
8. Selecting current UTC hour MUST update both spend-over-time evidence and top spend drivers to the current partial UTC-hour bucket.

### Cost Suggestions

1. Cost Suggestions MUST be enabled by default for every eligible Spend owner.
2. Cost Suggestions MUST have an owner-scoped setting independent from Spend Alert enablement.
3. Disabling Cost Suggestions MUST suppress new suggestion emails and active suggestion cards until the owner enables them again.
4. Disabling Cost Suggestions MUST NOT hide prior suggestion activity from Cost Insight Event history.
5. Cost Suggestions MUST be based on observed owner Credit spend and MUST identify the evidence window used for the recommendation.
6. V1 Cost Suggestions MAY recommend an eligible Coding Plan for concentrated model usage or Kilo Pass for pay-as-you-go usage.
7. A Cost Suggestion MUST state the recommended product or plan, the observed spend basis, and the additional credits, included usage, or other cost-efficiency benefit available under current plan terms without guaranteeing future savings.
8. A Cost Suggestion MUST provide one destination CTA that opens the relevant product, plan, pricing, or checkout location.
9. A Cost Suggestion MUST provide a dismissal action.
10. Suggestion dismissal MUST hide that specific active suggestion and create a Cost Insight Event.
11. Suggestion dismissal MUST NOT purchase a plan, modify billing, disable future Cost Suggestions, or acknowledge a Spend Alert.
12. Dismissed suggestions MUST NOT reappear unchanged for the same evaluation window.
13. A materially new evaluation MAY create a new Cost Suggestion after prior dismissal when observed spend, recommendation, price, plan, or eligibility changes.
14. Cost Suggestions MUST NOT be presented as alerts, warnings, required actions, or guaranteed savings.
15. Active Cost Suggestions MUST appear on the Cost Insights dashboard in addition to active Spend Alerts.
16. Spend Alerts MUST take visual and ordering priority over Cost Suggestions when both are active.
17. Cost Suggestion CTA and dismissal actions MUST be available to the same authorized users who can manage Cost Insights for the Spend owner.
18. Cost Suggestion evaluation and display MUST NOT depend on Spend Alerts being enabled.
19. Active, undismissed Cost Suggestions MUST count toward the Cost Insights sidebar attention count while Cost Suggestions are enabled.
20. Cost Suggestion emails MAY link directly to the relevant CTA destination or to Cost Insights suggestion context.

### Anomaly Detection

1. Spend Anomaly Alerts MUST detect hourly Credit-spend bursts, not only daily spend increases.
2. Spend Anomaly Alerts MUST evaluate bursty Variable Credit spend separately from predictable Scheduled Credit spend.
3. Spend Anomaly Alerts MUST use a Postgres owner-hourly spend rollup, not warehouse-only analytics.
4. Spend Alerts detection MUST NOT depend on Snowflake-only usage analytics.
5. Default Spend Anomaly Alert baseline MUST be trailing 7-day hourly p95 Variable Credit spend.
6. Spend Anomaly Alert baseline MUST use completed prior UTC-hour buckets and exclude the current UTC hour.
7. Spend Anomaly Alert baseline MUST include zero-spend completed hours in the trailing 7-day window.
8. Owners with at least 24 completed hourly buckets MUST use available-history p95 even before 7 full days exist.
9. Spend Anomaly Alerts MUST evaluate current partial-hour Variable Credit spend against the full-hour anomaly threshold.
10. Spend Anomaly Alerts MAY trigger before the current UTC hour ends.
11. Owners without at least 24 hourly baseline buckets MUST use a starter current-hour Variable Credit spend floor.
12. V1 Spend Anomaly Alert sensitivity MUST be product-managed and fixed.
13. V1 Spend Anomaly Alert threshold MUST be calculated as `max(3 * baseline, 10 USD floor)` when baseline data is available.
14. V1 starter anomaly floor MUST be 25 USD of current-hour Variable Credit spend.
15. Spend Anomaly Alerts MAY fire at most once per owner per hour while anomalous spend persists.
16. Alert acknowledgment MUST review the current UTC-hour anomaly episode.
17. Future anomalous UTC hours MAY create new Spend Anomaly Alerts after prior hour acknowledgment.
18. Spend Anomaly Alerts MUST use separate notification identity from Spend Threshold Alerts.
19. New Spend Anomaly Alert events MUST snapshot the top five current-hour Variable Credit spend drivers and their UTC-hour evidence window.
20. Active anomaly banners MUST expose their captured driver evidence inline without representing broader or later spend as causal evidence.
21. Spend Anomaly Alerts MUST be enabled by default as a sub-option when Spend Alerts are enabled.
22. Spend owners MUST be able to opt out of Spend Anomaly Alerts without disabling threshold alerts or Cost Suggestions.
23. Disabling Spend Anomaly Alerts MUST clear active anomaly episode state without deleting Cost Insight Event history.

### Spend Threshold Alerts

1. Spend owners MUST be able to configure independent optional rolling 24-hour, rolling 7-day, and rolling 30-day spend thresholds.
2. Spend threshold values MUST be stored as microdollars.
3. Spend threshold UI MUST accept and display USD amounts.
4. Each spend threshold input MUST accept positive USD amounts with cent precision only.
5. Each spend threshold input MUST reject amounts with more than two decimal places.
6. Spend threshold inputs MUST NOT enforce a product-level maximum.
7. Each Spend Threshold Alert MUST evaluate all owner Credit spend in its rolling window, including Variable Credit spend and Scheduled Credit spend.
8. The 24-hour threshold MUST use the exact `[asOf - 24h, asOf)` window.
9. The 7-day threshold MUST use the exact `[asOf - 7d, asOf)` window.
10. The 30-day threshold MUST use the exact `[asOf - 30d, asOf)` window.
11. Each threshold window MUST maintain independent crossing, review, recovery, and notification identity.
12. Each Spend Threshold Alert MUST fire once per below-to-above threshold crossing.
13. A threshold window MAY fire again only after spend in that window drops below its threshold and later crosses it again.
14. Spend Threshold Alerts MUST create email, Cost Insight Event history, and in-app review banner.
15. Threshold review MUST offer acknowledge and Manage threshold actions.
16. Manage threshold MUST open the matching 24-hour, 7-day, or 30-day threshold sub-option in Cost Insights settings, where authorized managers can adjust or disable it.
17. Threshold review MUST allow acknowledge without requiring threshold changes.
18. Threshold acknowledgment MUST review only the current crossing episode for that threshold window.
19. Disabling a spend threshold MUST clear current episode state only for that threshold window.
20. New Spend Threshold Alert events MUST snapshot the top five drivers from the exact evaluated rolling window across Variable and Scheduled Credit spend.
21. Active threshold banners MUST expose their captured driver evidence inline and MUST NOT substitute aligned-hour or later live spend.

### Rollups and Evidence

1. Spend Alerts MUST use dedicated normalized storage for owner configuration, owner state, owner-hour totals, owner-hour driver buckets, and Cost Insight Events.
2. Owner-hour totals MUST record all Credit spend for all Spend owners, including owners who have not enabled Spend Alerts.
3. Owner-hour total entries MUST label spend category so anomaly evaluation can distinguish Variable Credit spend from Scheduled Credit spend.
4. Owner-hour totals MUST be keyed by spend category with separate rows for Variable Credit spend and Scheduled Credit spend.
5. Owner-hour buckets MUST use UTC hour start timestamps.
6. Spend Alerts MUST store compact owner-hour driver buckets separately from owner-hour totals.
7. Driver buckets MUST be keyed by spend category as well as source and driver dimensions.
8. Driver buckets SHOULD group spend by product or feature, model or provider, and actor user where applicable.
9. Driver buckets MUST use controlled taxonomy values for Spend Alerts-owned dimensions.
10. Unknown source classification MUST map to `other`, not arbitrary source-specific labels.
11. V1 source taxonomy MUST include `ai_gateway`, `kiloclaw`, `coding_plan`, and `other`.
12. Driver buckets MUST store actor user ID for both personal and organization spend.
13. Driver buckets MUST store total spend and contributing spend-record count.
14. Every Credit spend path MUST update owner-hour totals and applicable driver buckets atomically with spend recording.
15. Credit spend MUST NOT commit unless the corresponding owner-hour total and applicable driver-bucket updates also commit.
16. Spend Alert evaluation and notification side effects SHOULD run asynchronously after spend recording.
17. Enabling Spend Alerts MUST use already-maintained owner-hour totals for baseline data when available.
18. Enabling Spend Alerts MUST backfill or repair the owner's last 7 days of hourly baseline from Postgres historical usage data when rollups are missing or incomplete.
19. Baseline backfill and repair MUST use Postgres source-of-truth data, not Snowflake.
20. When rolling 7-day or rolling 30-day rollup coverage is incomplete, threshold evaluation MUST fall back to exact Postgres source-of-truth spend for that window rather than suppressing the alert.

### Notifications

1. Spend Alerts v1 MUST send email and show owner-scoped in-app banner until alert acknowledgment.
2. Spend Alerts v1 MUST NOT send mobile or push notifications.
3. Personal Spend Alerts MUST be sent to the personal user's email only while that user is a Kilo platform admin.
4. Organization Spend Alerts MUST be sent only to active organization owners and billing managers who are also Kilo platform admins.
5. Spend Alert emails MUST link to Cost Insights dashboard review context.
6. Spend Alerts MUST store owner-scoped Cost Insight Events separately from per-recipient notification delivery rows.
7. Per-recipient notification delivery rows MAY be retried without creating duplicate owner-scoped Cost Insight Events.
8. Spend Alerts MUST snapshot intended notification recipients at event creation.
9. Spend Alerts MUST revalidate recipient access before email delivery.
10. Organization recipients who no longer have authorized access at dispatch time MUST NOT receive Spend Alert email.
11. Managers added after event creation SHOULD NOT receive already-created alert emails unless a new alert event is created.
12. Active Spend Alert in-app banners MUST be visible to all current authorized managers.
13. Alert review actions MUST be available to all current authorized managers.
14. Banner visibility MUST NOT be limited to users snapshotted as notification recipients.
15. Spend Alert notification delivery rows MUST be deleted with their parent Cost Insight Event after 90 days.

### Event History

1. Cost Insights MUST retain and display 90 days of Cost Insight Events.
2. Cost Insight Event history MUST remain fixed to 90 days even though hourly rollups are retained indefinitely.
3. Cost Insight Events MUST be deleted after 90 days rather than merely hidden.
4. Cost Insight Event retention MUST be enforced by daily app cron deletion.
5. Cost Insight Events MUST include configuration changes, anomaly alerts, threshold alerts, reviews, Cost Suggestion creation, Cost Suggestion dismissal, and disablement.
6. Cost Insight Events MUST store summarized decision snapshots.
7. Cost Insight Events MUST NOT copy raw request rows.
8. Summary snapshots SHOULD include threshold, rolling spend totals, current-hour variable spend, baseline, and top driver dimensions.
9. Top driver dimensions SHOULD include product or feature, model or provider, and organization member when applicable, with spend and request counts.
10. Alert Cost Insight Events MUST snapshot top drivers at event creation time.
11. Alert Cost Insight Events MUST snapshot top 5 spend drivers.
12. Cost Insight Events MUST store direct evaluated settings in snapshots.
13. Cost Insight Events MUST NOT require config version tracking in v1.
14. Spend Alert config events MUST store changed fields plus resulting key settings.
15. Spend Alert config events MUST NOT store full config snapshots in v1.
16. Cost Insight Events MUST NOT copy actor email or actor display name into snapshots.
17. Cost Insight Events MAY retain actor user IDs because soft-deleted user rows are anonymized.
18. Cost Insights UI MUST resolve actor display labels from current user rows at render time.
19. Spend Alerts MUST NOT depend on event-time actor display labels for org member driver display.
20. Owner state MUST store active episode dedupe and review state separately from 90-day event history.
21. Deleting expired Cost Insight Events MUST NOT cause old threshold or anomaly episodes to alert again unless the episode legitimately recrosses or reoccurs.
22. Owner state SHOULD store minimal current episode markers for anomaly hour, threshold crossing state, and review status.
23. Owner state MUST NOT duplicate full Cost Insight Event snapshots.
24. Cost Insights UI timestamps MUST be displayed in the viewer's current time zone using 24-hour time and without a time-zone suffix; UTC storage and evaluation boundaries MUST NOT determine user-facing timestamp formatting.

### Rollup Retention

1. V1 owner-hour totals MUST be retained indefinitely.
2. V1 owner-hour driver buckets MUST be retained indefinitely.
3. Indefinite rollup retention MUST NOT change the 90-day display window for Cost Insight Events.
4. Owner-hour driver buckets MAY retain actor user IDs indefinitely because soft-deleted user rows are anonymized.
5. Owner-hour driver buckets MUST NOT store actor email or actor display name.

### Organization Member Actions

1. Organization Cost Insights dashboard SHOULD identify organization member spend drivers when applicable.
2. Organization Cost Insights dashboard SHOULD link to existing organization member daily limit controls.
3. V1 MUST NOT add separate per-member Spend Alert policy.

### Evaluation and Non-Enforcement

1. Spend Alert evaluation MUST run asynchronously after Credit spend updates.
2. Spend Alerts MUST also run an hourly sweep to catch missed evaluations and rolling-window transitions.
3. Async Spend Alert evaluation MUST use current config at evaluation time.
4. V1 Spend Alert evaluation SHOULD run in `apps/web` through post-spend async execution and app cron hourly sweep.
5. Spend Alerts MUST NOT prevent any Credit spend path from running because of anomaly state, threshold state, alert review state, or owner Spend Alert configuration.
6. Spend Alerts MUST NOT alter auto-top-up eligibility or execution.
7. Spend Alerts MUST NOT use the existing `usage_limit_exceeded` error type for alert or threshold state.

## Decision References

- `CONTEXT.md` defines canonical Cost Insights and Spend Alerts language.
