<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Add admin bulk action to set all active personal KiloClaw subscriptions to cancel at period end for EOL

## Problem

KiloClaw reaches end of life in December 2026, and the monthly subscriptions need to stop renewing. Right now an admin can only stop renewal one subscription at a time, from the per-user admin tab (admin.users.cancelKiloClawSubscription, mode 'period_end'). That path releases any pending Stripe schedule, sets cancel_at_period_end on Stripe, then updates the local row and writes the change log and admin audit entries. A plain SQL update of the flag would not be enough: Stripe-backed rows would keep renewing on the provider side.

## Evidence

- apps/web/src/routers/admin-router.ts:1488-1760 has cancelKiloClawSubscription. Its period_end branch requires status 'active' and a cancel_at_period_end that is not already set. If a Stripe subscription exists, it releases the schedule (tolerating schedules that are already inactive) and calls stripe subscriptions.update(cancel_at_period_end: true). It then reconciles in a transaction: it sets cancel_at_period_end=true and clears the stripe_schedule_id, scheduled_plan and scheduled_by fields, writes a change log with reason 'admin_cancel_at_period_end', and writes an admin audit row 'kiloclaw.subscription.admin_cancel'.
- admin-router.ts:196-300 defines KiloClawCancelAuditMetadata and the file-local lockMutableKiloClawSubscription, localKiloClawSubscriptionStateForAudit and isKiloClawCancelDesiredState helpers, so the bulk path can sit in the same file without changing module boundaries.
- Today a period_end call that fails before reconciliation (validation error, Stripe error) writes no audit row. Only the reconcile transaction writes 'kiloclaw.subscription.admin_cancel'.
- .specs/kiloclaw-billing.md 'Cancellation and Reactivation' (rules 1-6) says access continues until the period ends. Stripe-funded rows must have the flag set on both Stripe and the DB, and a pending schedule must be released first. Pure-credit rows need the local flag only.
- packages/db/src/schema.ts:9230 defines kiloclaw_subscriptions with status, cancel_at_period_end, stripe_subscription_id, transferred_to_subscription_id and instance_id. Org ownership comes from kiloclaw_instances.organization_id, which credit-billing.ts filters with isNull().
- packages/db/src/schema-types.ts:825 defines the KiloClawAdminAuditAction zod enum. The audit table action column is plain text with no DB check constraint, so adding an action value needs no migration.
- apps/web/src/app/api/trpc/[trpc]/route.ts sets maxDuration = 800s. The operator says there are about 300 subscriptions, which fits comfortably in a single call at modest concurrency.
- KiloclawInstancesPage.tsx:311-405 has DevNukeAllButton, which uses an AlertDialog confirm and a result dialog that lists per-user errors. The new button can reuse this UI pattern.

## Desired outcome

On the KiloClaw admin page, an admin sees how many subscriptions are eligible and confirms a single 'Stop renewal for all subscriptions' action. In one call, each eligible subscription is set to cancel at its period end in both Stripe (where applicable) and the local DB, and access continues until each period ends. The audit log gets one summary row for the bulk run plus one row per subscription, covering both successes and failures and tagged with the bulk run ID. The admin then sees updated, skipped and failed counts with a failure list. Running it again only processes rows that are still eligible.

## Scope

- In admin-router.ts, move the existing period_end branch and its reconcile code into a file-local async function. Both the existing per-user mutation and the new bulk mutation call it. No new module and no change to immediate mode.
- Add an eligibility query (inline or file-local) for: status='active', cancel_at_period_end=false, transferred_to_subscription_id IS NULL, and personal ownership (the joined instance has a null organization_id, or there is no instance).
- Add an admin query, previewBulkCancelKiloClawSubscriptions, that returns the eligible count, split by Stripe-backed vs pure credit.
- Add an admin mutation, bulkCancelKiloClawSubscriptions. It requires a confirmation literal, processes every eligible row in one call with small fixed concurrency, isolates failures per row, and returns {total, updated, skipped, failed: [{subscriptionId, userId, error}]}.
- Write audit rows: one summary 'kiloclaw.subscription.bulk_cancel_at_period_end' row per run, plus a per-subscription 'kiloclaw.subscription.admin_cancel' row for every processed subscription, including failures. Each per-row entry carries bulkRunId and its outcome.
- Add a UI control on the KiloclawInstancesPage: preview count, typed confirmation, and a result dialog with the failure list.
- Add router tests for the bulk path, plus a short note in .specs/kiloclaw-billing.md.

## Exclusions

- Trialing, past_due and organization-managed subscriptions.
- Immediate cancellation, refunds, and any suspension or destruction of instances. The existing period-end sweeps stay as they are.
- Blocking enrollment or reactivation, and any persistent EOL flag.
- Client-driven batching, cursor or limit inputs. Not needed at about 300 rows within the 800s function budget.
- Extracting the logic into a new shared lib module.
- User emails and schema migrations.

## Approach

- 1. In admin-router.ts, lift the period_end branch and its reconcile transaction into a file-local `cancelKiloClawSubscriptionAtPeriodEnd({ userId, subscriptionId, actor, bulkRunId? })`. It returns 'updated' | 'already_desired' | 'local_row_changed_after_stripe' and throws the same TRPCErrors as today. The existing mutation's period_end case calls it and keeps the same responses. Metadata gains an optional bulkRunId.
- 2. Next to it, add `previewBulkCancelKiloClawSubscriptions` (query) and `bulkCancelKiloClawSubscriptions` (mutation, input { confirm: z.literal('STOP RENEWALS') }) on the admin users router. The mutation generates a bulkRunId, selects all eligible rows, and runs the helper with a concurrency of about 5. For each row it maps 'updated' to updated, 'already_desired' to skipped, and a thrown error or 'local_row_changed_after_stripe' to failed.
- 3. When a row fails before reconciliation (for example a Stripe error), the bulk loop writes a 'kiloclaw.subscription.admin_cancel' audit row for that subscription's user, with metadata { bulkRunId, subscriptionId, outcome: 'failed', error } and a non-sensitive message. Successful and skipped rows already get their per-row audit from the helper, with bulkRunId attached. After the loop, it writes one 'kiloclaw.subscription.bulk_cancel_at_period_end' summary row (target_user_id = actor id, matching createFleetUpgrade) containing bulkRunId, the counts and the failed subscription IDs.
- 4. Add 'kiloclaw.subscription.bulk_cancel_at_period_end' to KiloClawAdminAuditAction in packages/db/src/schema-types.ts. This is text-only, so no migration is needed.
- 5. UI: add a StopAllRenewalsButton on KiloclawInstancesPage, not gated to development. It shows the preview count, requires typing the confirmation phrase, makes a single mutation call, and shows a result dialog in the DevNukeAllButton style that lists failures.
- 6. Tests: a mixed fleet (stripe-backed with a schedule, pure-credit, already-canceling, trialing, past_due, org-owned, transferred) gets only the eligible rows updated. One injected Stripe failure is reported, gets its own audit row, and does not stop the others. A second run is a no-op. The existing single-cancel tests stay unchanged.

## Affected areas

- apps/web/src/routers/admin-router.ts
- apps/web/src/app/admin/components/KiloclawInstances/KiloclawInstancesPage.tsx (or a sibling component)
- packages/db/src/schema-types.ts (KiloClawAdminAuditAction)
- .specs/kiloclaw-billing.md
- apps/web/src/routers/admin-kiloclaw-user-router.test.ts (or a new sibling test)

## Acceptance criteria

### ac-1: The bulk mutation sets cancel_at_period_end=true only on rows where status='active', cancel_at_period_end was false, transferred_to_subscription_id is null, and the owning instance is personal (no organization_id). Trialing, past_due, canceled, already-canceling, transferred and org-owned rows are left unchanged. A router test with a mixed fixture fleet shows this.

**Verification:** Code review

### ac-2: For each eligible row that has a stripe_subscription_id, the action releases any pending schedule (from the local stripe_schedule_id or the live Stripe subscription's schedule) before calling stripe.subscriptions.update(id, { cancel_at_period_end: true }), and clears stripe_schedule_id, scheduled_plan and scheduled_by locally. Pure-credit rows (no Stripe subscription ID) make no Stripe calls. Tests assert both with the Stripe mocks.

**Verification:** Code review

### ac-3: Access is not ended. Bulk-processed rows keep status 'active' and keep their current_period_end and credit_renewal_at unchanged.

**Verification:** Code review

### ac-4: A Stripe or reconcile failure on one subscription does not stop the others. The mutation result lists each failure with its subscriptionId, userId and a non-sensitive error message, and successful rows are still committed. A test injects one Stripe failure to check this.

**Verification:** Code review

### ac-5: The action is idempotent. Running the mutation a second time after a fully successful run updates no rows and makes no Stripe update calls.

**Verification:** Code review

### ac-11: Each bulk run writes one 'kiloclaw.subscription.bulk_cancel_at_period_end' summary audit row with the actor, bulkRunId, counts and failed subscription IDs. It also writes one 'kiloclaw.subscription.admin_cancel' audit row per processed subscription for every outcome (updated, skipped and failed, including failures before reconciliation such as Stripe errors), each carrying the same bulkRunId and its outcome. Updated rows also get a subscription change-log entry. No secrets or Stripe credentials appear in the logs. Tests assert the per-row audit row for the injected failure.

**Verification:** Code review

### ac-7: The existing admin.users.cancelKiloClawSubscription behavior in both modes is unchanged: same validation errors, CONFLICT on a local row change after Stripe, and the same audit and change-log output. The existing tests in admin-kiloclaw-user-router.test.ts cover this without changes to their expectations.

**Verification:** Code review

### ac-8: The bulk procedures are adminProcedure only, and the mutation rejects any input that lacks the exact confirmation literal.

**Verification:** Source review

### ac-12: In a production build, the KiloClaw admin page shows a stop-renewals control (not limited to development). It displays the eligible count, requires typed confirmation, processes all eligible subscriptions in a single request, and shows a result summary with updated, skipped and failed counts and the failure list.

**Verification:** Manual: Against a Stripe test-mode environment, open /admin/kiloclaw as an admin, check the preview count against the seeded data, run the action, confirm the result dialog, check that the affected Stripe test subscriptions show cancel_at_period_end=true, and check that the admin audit log has a summary row plus one row per subscription.

### ac-10: .specs/kiloclaw-billing.md documents the admin bulk non-renewal operation: eligibility, dual provider/local updates, access continuing to period end, and audit.

**Verification:** Source review

## Risks

- Running the action in production affects real billing across the fleet. The mitigations are typed confirmation, the preview count, per-row audit entries, and reversibility through the existing reactivation flows.
- Stripe can succeed while the local reconcile fails (local_row_changed_after_stripe). These cases are reported as failures with audit rows for manual review.
- A single request processes all rows. At about 300 rows with concurrency 5 this takes well under the 800s maxDuration. If the request is cut off, re-running is safe because the action is idempotent.
- Hybrid rows (payment_source 'credits' with a Stripe subscription ID) must still go through Stripe. Eligibility is based on stripe_subscription_id, not payment_source.
- As with the single cancel, this clears a pending scheduled_plan, including a Commit-to-Standard continuation.
- Users can still reactivate afterwards, so this is not a permanent lock.

## Assumptions

- The fleet is about 300 eligible subscriptions and the action is essentially single-use, per the operator.
- Personal ownership is determined by kiloclaw_instances.organization_id IS NULL. Rows with no instance are treated as personal.
- No user notification email is needed.
- Configured verification commands could not be established from the pinned checkout, so criteria use code/source review and one manual check.

## Decisions

### d-1: Which subscriptions are in scope for the bulk action?

**Answer:** Provisional default; the scope question is still open with the operator: personal, status='active', not already canceling, not transferred. This includes Stripe-funded, hybrid, pure-credit and Commit rows. Trialing, past_due and org-managed rows are excluded.

**Blocking:** no

### d-2: Should the bulk action be a one-shot idempotent operation or a persistent EOL switch?

**Answer:** One-shot, idempotent and re-runnable. It adds no persistent flag and does not block enrollment or reactivation.

**Blocking:** no

### d-3: Should the bulk action change compute or instance lifecycle?

**Answer:** No. It only stops renewal, and the existing period-end sweeps handle suspension and destruction.

**Blocking:** no

### d-4: How should the bulk path relate to the existing single-subscription cancel logic?

**Answer:** Keep it minimal. Lift the period_end body into a file-local function inside admin-router.ts that both mutations call. Do not create a shared lib module or duplicate the Stripe/reconcile code.

**Blocking:** no

### d-5: Should the bulk mutation be batched or paginated?

**Answer:** No. It processes all eligible rows in one call with small concurrency, taking no limit or cursor input (about 300 rows, single-use).

**Blocking:** no

### d-6: What should be written to the audit log?

**Answer:** One summary row per bulk run, plus one per-subscription row for every outcome, including failures, linked by bulkRunId.

**Blocking:** no
