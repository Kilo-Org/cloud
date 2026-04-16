# KiloClaw Personal Reprovisioning via Successor Subscription Rows

## Summary

Switch personal reprovisioning from row reassignment to successor-row transfer.

- Keep `.specs/kiloclaw-datamodel.md` unchanged.
- Update `.specs/kiloclaw-billing.md` so reprovision:
  - creates successor subscription row on new instance
  - transfers live entitlement and provider ownership to successor
  - leaves predecessor row on destroyed instance as historical, terminal, non-live row
- Stop creating new detached personal subscription rows.
- Add one canonical lineage field only: `kiloclaw_subscriptions.transferred_to_subscription_id` on predecessor rows.
- Replace heuristic “effective subscription” selection in all live personal flows with one exact current-row resolver.

Important interface/type changes:

- Add nullable self-referential `transferred_to_subscription_id` to `kiloclaw_subscriptions`, with unique index on non-null values.
- Deprecate `getEffectiveKiloClawSubscription*` for live personal runtime paths; keep heuristic ranking only for remediation/admin diagnostics.
- Extend Admin KiloClaw state output to include lineage metadata for each subscription row.

## Implementation Changes

### Spec updates

- In billing spec, replace “reassign subscription to newly provisioned instance” with successor transfer semantics.
- Add explicit billing-spec rule: current personal row means personal row with `transferred_to_subscription_id IS NULL`.
- Add explicit billing-spec rule: live personal runtime must have at most one current personal row per user personal context. If more than one exists, runtime must fail closed and quarantine/manual-review; runtime must not pick one heuristically.
- Add explicit billing-spec rule: transferred-out predecessor rows never participate in live access, billing, renewal, webhook, settlement, duplicate-check, lifecycle, or email logic.
- Add explicit billing-spec rule: live personal queries must scope to personal rows in SQL (`organization_id IS NULL`) and exclude predecessor rows in SQL via `transferred_to_subscription_id IS NULL`; broad fetch plus in-memory filtering is not allowed.
- Add explicit billing-spec rule: webhook and settlement routing must follow transfer lineage, with hard quarantine on ambiguity.
- Add explicit billing-spec rule: transferred-out predecessor rows may preserve historical `payment_source` after live Stripe ownership moves away; live provider-ownership invariants apply to current rows only.

### Canonical resolvers

Introduce shared resolvers and require all live personal logic to use them.

- `resolveCurrentPersonalSubscription(userId, opts?)`
  - query personal rows only, in SQL
  - require `transferred_to_subscription_id IS NULL`
  - if `instanceId` supplied, require exact match on that instance
  - result rules:
    - `0` rows: return `null`
    - `1` row: return it
    - `>1` rows: quarantine, fail closed, no heuristic fallback
  - use for self-serve billing status, access gate, cancel/switch/reactivate, duplicate guards, and checkout success polling
- `resolvePersonalBillingAnchorInstance(userId, opts?)`
  - first resolve owned active personal instance
  - then resolve current personal subscription row
  - anchor rules:
    - active instance exists and no current row: quarantine/fail closed
    - active instance exists and current row exists on same instance: use active instance
    - active instance exists and current row points elsewhere: quarantine/fail closed
    - no active instance and current row exists: use `currentRow.instance_id` as destroyed billing anchor
    - neither exists: return `null`
  - do not independently search destroyed rows outside current-row resolution
- `resolveCurrentPersonalSubscriptionByStripe(stripeSubscriptionId, userId, metadataInstanceId?)`
  - resolve by `stripe_subscription_id` first
  - hard rules:
    - if same Stripe ID appears on more than one row, quarantine
    - if resolved row has `transferred_to_subscription_id`, follow lineage forward predecessor -> successor until current row
    - no reverse traversal is required in runtime model
    - if lineage target row missing, quarantine
    - if lineage crosses personal/org boundary or user ownership boundary, quarantine
    - if chain loops or exceeds bounded hop limit, quarantine
    - if metadata `instanceId` resolves to predecessor row after transfer, follow lineage forward
  - only final current row may be mutated

### Transfer behavior

Replace `adoptOrphanedSubscription` and row-move bootstrap with successor transfer.

- Personal reprovision bootstrap:
  - resolve exact current personal row
  - if no current row exists and user has no personal history, create first trial row as today
  - if current row exists on destroyed personal instance and still grants access, create successor row for new instance
  - if current row exists but does not grant access, deny free reprovision and require paid path
  - if multiple current rows exist, quarantine/fail closed
- Successor transfer transaction:
  1. lock source subscription row and target instance row
  2. verify source is current personal row on destroyed instance and target has no subscription row
  3. snapshot source row
  4. insert successor row on new instance using snapped live entitlement:
     - copy plan, payment source, access origin, trial/period/commit timestamps, dunning/suspension state, pending conversion, scheduling, and live Stripe IDs if present
  5. update predecessor row to historical terminal state:
     - `status = 'canceled'`
     - set `transferred_to_subscription_id = successor.id`
     - clear live/future coordination fields: `stripe_subscription_id`, `stripe_schedule_id`, `credit_renewal_at`, `cancel_at_period_end`, `pending_conversion`, `scheduled_plan`, `scheduled_by`, `auto_resume_requested_at`, `auto_resume_retry_after`, `auto_resume_attempt_count`, `auto_top_up_triggered_for_period`, `destruction_deadline`
     - preserve historical `payment_source`, plan, access origin, trial/period/commit timestamps, dunning timestamps, suspension timestamps
  6. write change-log entries:
     - predecessor: existing `reassigned` action with reason `subscription_transfer_out`
     - successor: existing `created` action with reason `subscription_transfer_in`
- Do not use `status = 'canceled'` alone to infer transfer. Transfer detection must key on lineage.

### Live-query and live-sweep rules

Every live personal query must scope to personal rows in SQL (`organization_id IS NULL`) and exclude predecessor rows in SQL with `transferred_to_subscription_id IS NULL`.

Apply this rule to:

- access state and access gate
- self-serve billing status and subscription center
- checkout duplicate guards
- credit enrollment and Kilo Pass hosting enrollment
- Stripe `subscription.created` / `subscription.updated` / schedule handlers
- Stripe `invoice.paid` settlement
- lifecycle sweeps, dunning, warning emails, destruction scheduling, and auto-resume
- any instance-scoped mutation reading current personal billing state

Admin/support paths are separate:

- Admin KiloClaw state shows full lineage, including predecessor rows and destroyed-instance linkage.
- Self-serve views show only current row.

### Paid-flow cleanup

Remove new detached personal-row creation from personal paid flows.

- Stripe checkout must always include `instanceId` metadata from billing-anchor resolver.
- Credit enrollment must always target billing-anchor instance from resolver.
- Kilo Pass hosting auto-activation must use billing-anchor resolver, not active-instance-only validation.
- Retire detached personal row persistence/reconciliation after migration is complete; unresolved legacy detached rows remain remediation-only.

## Migration And Rollout

Use staged rollout.

1. Deploy schema and lineage-aware readers first.
   - add `transferred_to_subscription_id`
   - add exact current-row resolvers
   - convert live personal queries to SQL-level personal scoping plus `transferred_to_subscription_id IS NULL`
   - add admin lineage visibility, including predecessor `instance_id` and `transferred_to_subscription_id`
2. Run remediation report and backfill.
   - `already reassigned rows`
     - detect via change-log entries where `before_state.instance_id != after_state.instance_id`
     - reconstruct predecessor from change-log snapshot first
     - if no exact change-log snapshot is available, require explicit admin/manual remediation only
     - never reconstruct predecessor from current-row guesswork
     - if snapshot is conflicting or maps to more than one current successor, mark unresolved blocker
   - `detached personal rows`
     - attach only when exactly one valid personal target exists and no conflicting current/provider owner exists
     - otherwise mark unresolved blocker
   - `current-row integrity`
     - detect users with more than one personal row where `transferred_to_subscription_id IS NULL`
     - detect duplicate Stripe IDs
     - detect missing lineage targets
     - detect lineage crossing org/personal or user boundaries
     - all are unresolved blockers
3. Rollout gate.
   - do not enable writer cutover until unresolved reassigned-row blocker count is zero
   - do not enable writer cutover until all other unresolved personal-lineage blockers are zero as well, including detached rows, duplicate current rows, duplicate Stripe IDs, and missing lineage targets
4. Enable writer cutover.
   - switch personal provisioning/bootstrap to successor transfer
   - remove new detached-row writes from checkout/enrollment paths
5. Remove legacy code.
   - delete row-reassignment/orphan-adoption logic after remediation is complete
   - keep telemetry on lineage-followed webhooks, quarantine counts, and transfer failures

## Test Plan

- Exact current-row resolver:
  - returns `null` for zero rows
  - returns row for exactly one current personal row
  - quarantines/fails closed for multiple current personal rows in one user personal context
  - explicit `instanceId` path rejects non-current/predecessor rows
- Billing-anchor resolver:
  - active instance + matching current row succeeds
  - no active instance + current destroyed-anchor row succeeds
  - active/current mismatch quarantines
  - active instance with no current row quarantines
- Reprovision transfer:
  - unexpired trial on destroyed instance transfers into successor row with same trial end
  - active paid personal row transfers into successor row with same entitlement and moved Stripe ownership
  - repeated reprovision forms lineage chain and current resolver returns only terminal current row
- Webhook routing:
  - `subscription.created` resolves predecessor Stripe ownership to current successor
  - `invoice.paid` resolves predecessor metadata instance to current successor
  - duplicate Stripe ID across rows quarantines
  - missing lineage target quarantines
  - cross-boundary lineage quarantines
  - lineage cycle quarantines
  - hop-limit overflow quarantines
- Live exclusions:
  - lifecycle sweeps, dunning, warning emails, destruction scheduling, access gate, duplicate checkout checks, credit enrollment, and settlement all exclude predecessor rows by SQL predicate in personal scope
- Paid flows:
  - Stripe checkout, credit enrollment, and Kilo Pass hosting activation create no new personal rows with `instance_id IS NULL`
  - checkout success and Kilo Pass awarding flows still complete when billing anchor is destroyed instance before reprovision
- Migration:
  - reassigned-row predecessor backfill succeeds from exact change-log snapshot
  - ambiguous reassigned row remains unresolved blocker
  - detached-row attachment only succeeds for exact one-target case
  - writer cutover gate fails while any unresolved blocker count is non-zero

## Assumptions

- Personal context still allows only one active instance during this feature. This plan enforces at most one current personal row per user personal context at runtime; future multi-instance support requires a different per-instance current-row resolver model.
- Historical transferred rows are internal/admin-visible only in v1.
- Existing subscription change-log snapshots are available for most reassignment cases; missing snapshots are blockers, not guesswork.
