<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Add admin bulk action to set all active personal KiloClaw subscriptions to cancel at period end for EOL

## Problem

KiloClaw reaches end of life in December 2026, and the monthly subscriptions need to stop renewing. Right now an admin can only stop renewal one subscription at a time, from the per-user admin tab (admin.users.cancelKiloClawSubscription, mode 'period_end'). That path releases any pending Stripe schedule, sets cancel_at_period_end on Stripe, then updates the local row and writes the change log and admin audit entries. A plain SQL update of the flag would not be enough: Stripe-backed rows would keep renewing on the provider side.

## Evidence

- apps/web/src/routers/admin-router.ts:1488-1760 has cancelKiloClawSubscription. Its period_end branch requires status 'active' and a cancel_at_period_end that is not already set. If a Stripe subscription exists, it releases the schedule (tolerating schedules that are already inactive) and calls stripe subscriptions.update(cancel_at_period_end: true). It then reconciles in a transaction: it sets cancel_at_period_end=true and clears the stripe_schedule_id, scheduled_plan and scheduled_by fields, writes a change log with reason 'admin_cancel_at_period_end', and writes an admin audit row 'kiloclaw.subscription.admin_cancel'.
- admin-router.ts:247-300 has the lockMutableKiloClawSubscription, localKiloClawSubscriptionStateForAudit and isKiloClawCancelDesiredState helpers. These are private to the router file today.
- .specs/kiloclaw-billing.md 'Cancellation and Reactivation' (rules 1-6) says access continues until the period ends. Stripe-funded rows must have the flag set on both Stripe and the DB, and a pending schedule must be released first. Pure-credit rows need the local flag only.
- packages/db/src/schema.ts:9230 defines kiloclaw_subscriptions with status, cancel_at_period_end, stripe_subscription_id, stripe_schedule_id, transferred_to_subscription_id, instance_id and payment_source. Org ownership comes from kiloclaw_instances.organization_id, which credit-billing.ts filters with isNull().
- packages/db/src/schema-types.ts:825 defines the KiloClawAdminAuditAction zod enum. The audit table action column is plain text with no DB check constraint, so adding an action value needs no migration.
- apps/web/src/app/admin/components/KiloclawInstances/KiloclawInstancesPage.tsx:311-405 has DevNukeAllButton, which uses an AlertDialog confirm and a result dialog that lists per-user errors. The bulk action can reuse this UI pattern.
- admin-kiloclaw-instances-router.ts has preview/create pairs (previewFleetUpgrade and createFleetUpgrade) with audit logging. The bulk action can follow the same pattern.

## Desired outcome

On the KiloClaw admin page, an admin can preview how many subscriptions are eligible, split by funding type, and then confirm a single 'Stop renewal for all subscriptions' action. Each eligible subscription is set to cancel at its period end in both Stripe (where applicable) and the local DB. Access continues until each period ends. Every change is recorded in the change log and the admin audit log. The admin then sees per-subscription success, skip and failure counts. The action is idempotent, so running it again only processes rows that are still eligible or that failed earlier.

## Scope

- Move the existing period_end cancellation logic (schedule release, Stripe update, locked reconcile, change log, admin audit) into a shared server helper. The existing per-user mutation keeps its current behavior and error contract.
- Add an eligibility query for: status='active', cancel_at_period_end=false, transferred_to_subscription_id IS NULL, and personal ownership (the joined instance has a null organization_id, or there is no instance). This covers Stripe-funded, hybrid and pure-credit rows, including Commit plans.
- Add an admin query, previewBulkCancelAtPeriodEnd, that returns eligible counts by payment type (stripe-backed vs pure credit) and counts of excluded rows by reason.
- Add an admin mutation, bulkCancelAtPeriodEnd. It requires an explicit confirmation input, processes eligible rows in bounded batches with limited concurrency, isolates failures per row, and returns {processed, updated, alreadyDesired, failed: [{subscriptionId, userId, error}]}. It accepts an optional limit or cursor so a large fleet can be handled in several calls within the function timeout.
- Add a summary admin audit action, 'kiloclaw.subscription.bulk_cancel_at_period_end', alongside the existing per-row 'kiloclaw.subscription.admin_cancel' entries.
- Add a UI control on the KiloclawInstancesPage. It shows the preview counts and requires typed confirmation in a destructive AlertDialog, then shows a result dialog with a failure list and a way to re-run.
- Update .specs/kiloclaw-billing.md to describe the admin EOL bulk non-renewal operation.
- Add router tests that cover the bulk path.

## Exclusions

- Trialing, past_due and organization-managed subscriptions, unless the open operator question widens the scope.
- Immediate cancellation, refunds, proration, and any suspension or destruction of instances. The existing lifecycle sweeps handle period-end transitions unchanged.
- Blocking new enrollment or reactivation, and any persistent EOL feature flag.
- User-facing email notifications about the cancellation.
- Schema migrations. None are expected.

## Approach

- 1. In apps/web/src/lib/kiloclaw (for example, admin-subscription-cancel.ts), extract `cancelKiloClawSubscriptionAtPeriodEnd({ userId, subscriptionId, actor })`. It takes the period_end branch plus the reconciliation transaction from admin-router.ts and moves the lock, audit-state and desired-state helpers with it. It returns a discriminated result ('updated' | 'already_desired' | 'local_row_changed_after_stripe') and throws typed errors for validation failures and Stripe failures. Refactor admin.users.cancelKiloClawSubscription so period_end mode delegates to this helper, keeping its existing TRPCError codes and messages. Immediate mode stays as it is.
- 2. Add `listBulkCancelEligibleSubscriptions` / `countBulkCancelEligibility`. The query left-joins kiloclaw_instances, filters for active, not canceling, not transferred and personal rows, and orders by id so cursor paging is stable.
- 3. In admin-kiloclaw-instances-router.ts, add `previewBulkCancelAtPeriodEnd` (query) and `bulkCancelAtPeriodEnd` (mutation). The mutation input is z.object({ confirm: z.literal('STOP RENEWALS'), afterId?: uuid, limit: 1..500 default 200 }). It loops over the eligible rows with a concurrency of about 5, catching errors per row; Stripe rate limits are well above this. It writes one summary audit row (target_user_id = actor id, the same convention createFleetUpgrade uses) with the counts and the failed IDs, and returns the results plus a nextAfterId when more rows remain.
- 4. Add 'kiloclaw.subscription.bulk_cancel_at_period_end' to KiloClawAdminAuditAction in packages/db/src/schema-types.ts. This is text-only, so no migration is needed. Follow packages/db/AGENTS.md.
- 5. UI: add a StopAllRenewalsButton component to the KiloclawInstances admin page, available in all environments rather than only in development. It fetches the preview when opened and requires typing the confirmation phrase. The client keeps calling the mutation while nextAfterId is returned, shows progress, then shows the result dialog with the failure list. Follow the kilo-design-cloud guidance and the existing AlertDialog patterns.
- 6. Add a short 'Admin EOL Bulk Non-Renewal' subsection to the billing spec. It should state the eligibility rules, the dual Stripe/DB updates, that access continues, and the audit requirements.
- 7. Tests in admin-kiloclaw-user-router.test.ts or a new admin-kiloclaw-bulk-cancel.test.ts, using the existing Stripe mocks: a mixed fleet (stripe-backed with a schedule, pure-credit, already-canceling, trialing, past_due, org-owned, transferred) gets only the eligible rows updated. A Stripe failure on one row does not stop the others. A second run is a no-op. The existing single-cancel tests must keep passing.

## Affected areas

- apps/web/src/routers/admin-router.ts
- apps/web/src/lib/kiloclaw/ (new shared period-end cancel helper and eligibility query)
- apps/web/src/routers/admin-kiloclaw-instances-router.ts
- apps/web/src/app/admin/components/KiloclawInstances/ (new button and dialogs)
- packages/db/src/schema-types.ts (KiloClawAdminAuditAction)
- .specs/kiloclaw-billing.md
- apps/web/src/routers/*.test.ts

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

### ac-6: Each updated row gets a kiloclaw subscription change-log entry (action 'canceled', admin actor) and a per-row 'kiloclaw.subscription.admin_cancel' audit row. Each bulk invocation also writes one 'kiloclaw.subscription.bulk_cancel_at_period_end' audit row containing the actor and the counts. No secrets or Stripe credentials appear in the logs.

**Verification:** Code review

### ac-7: The existing admin.users.cancelKiloClawSubscription behavior in both modes is unchanged: same validation errors, CONFLICT on a local row change after Stripe, and the same audit and change-log output. The existing tests in admin-kiloclaw-user-router.test.ts cover this without changes to their expectations.

**Verification:** Code review

### ac-8: The bulk procedures are adminProcedure only, and the mutation rejects any input that lacks the exact confirmation literal.

**Verification:** Source review

### ac-9: In a production build, the KiloClaw admin page shows a stop-renewals control (not limited to development). It displays the preview counts, requires typed confirmation, pages through batches until done, and shows a result summary with any failures.

**Verification:** Manual: Against a Stripe test-mode environment, open /admin/kiloclaw as an admin, check the preview counts against the seeded data, run the action, and confirm the result dialog appears and the affected Stripe test subscriptions show cancel_at_period_end=true.

### ac-10: .specs/kiloclaw-billing.md documents the admin bulk non-renewal operation: eligibility, dual provider/local updates, access continuing to period end, and audit.

**Verification:** Source review

## Risks

- Running the action in production affects real billing across the fleet. The mitigations are typed confirmation, the preview counts, per-row audit entries, and reversibility: the cancel flag can be cleared through the existing reactivation flows.
- Stripe can succeed while the local reconcile fails (local_row_changed_after_stripe). These cases are reported as failures needing review, and the existing audit metadata is preserved.
- Function timeout or Stripe rate limits on a large fleet. This is handled with bounded batches, cursor paging driven by the client, and limited concurrency.
- Hybrid rows (payment_source 'credits' with a Stripe subscription ID) must still go through Stripe. Eligibility is based on stripe_subscription_id, not payment_source.
- Commit final terms already do not renew. Setting the flag on them is harmless but could interact with a pending Standard continuation (scheduled_plan). Clearing scheduled_plan matches the existing single-cancel semantics and should be called out in review.
- Users can still reactivate after the bulk action, so the action is not a permanent EOL lock. Blocking reactivation is out of scope.

## Assumptions

- The bulk action can reuse the existing single-row period_end semantics, including clearing a scheduled plan or Commit continuation.
- Personal ownership is determined by kiloclaw_instances.organization_id IS NULL. Rows with no instance are treated as personal.
- No user notification email is needed as part of this change.
- Configured verification commands could not be established from the pinned checkout (.kfab has no command config), so criteria use code/source review and one manual check.

## Decisions

### d-1: Which subscriptions are in scope for the bulk action?

**Answer:** Provisional default until the operator answers: personal, status='active', not already canceling, not transferred. This includes Stripe-funded, hybrid, pure-credit and Commit rows. Trialing, past_due and org-managed rows are excluded.

**Blocking:** no

### d-2: Should the bulk action be a one-shot idempotent operation or a persistent EOL switch?

**Answer:** One-shot, idempotent and re-runnable. It adds no persistent flag and does not block enrollment or reactivation.

**Blocking:** no

### d-3: Should the bulk action change compute or instance lifecycle?

**Answer:** No. It only stops renewal, and the existing period-end sweeps handle suspension and destruction.

**Blocking:** no

### d-4: How should the bulk path relate to the existing single-subscription cancel logic?

**Answer:** Extract a shared helper that both paths use, rather than duplicating the Stripe and reconcile logic.

**Blocking:** no
