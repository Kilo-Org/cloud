<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Add admin bulk action to stop renewal of all active and past-due KiloClaw subscriptions for EOL

## Problem

KiloClaw reaches end of life in December 2026, and every subscription needs to stop renewing. Right now an admin can only stop renewal one subscription at a time, from the per-user admin tab (admin.users.cancelKiloClawSubscription, mode 'period_end', which accepts status 'active' only). That path releases any pending Stripe schedule, sets cancel_at_period_end on Stripe, then updates the local row and writes the change log and admin audit entries. A plain SQL update of the flag would not be enough: Stripe-backed rows would keep renewing on the provider side.

## Evidence

- apps/web/src/routers/admin-router.ts:1488-1760 has cancelKiloClawSubscription. Its period_end branch requires status 'active' both before the Stripe call and again during reconciliation (the 'local row was no longer active' check). If a Stripe subscription exists, it releases the schedule and calls stripe subscriptions.update(cancel_at_period_end: true). It then reconciles in a transaction: it sets cancel_at_period_end=true, clears the schedule and scheduled-plan fields, writes a change log with reason 'admin_cancel_at_period_end', and writes an admin audit row 'kiloclaw.subscription.admin_cancel'.
- admin-router.ts:196-300 defines KiloClawCancelAuditMetadata and the file-local lock, audit-state and desired-state helpers.
- Today a period_end call that fails before reconciliation writes no audit row.
- .specs/kiloclaw-billing.md 'Cancellation and Reactivation' rules 1-6 say Stripe-funded rows need the flag set in both Stripe and the DB, and pure-credit rows need the local flag only. Access continues until the period ends.
- services/kiloclaw-billing/src/lifecycle.ts:2400-2410: the credit renewal sweep selects pure-credit rows with status active or past_due. Credit Renewal rule 5 says a row with cancel_at_period_end set is moved to canceled without a deduction, so past_due pure-credit rows with the flag stop retrying payment at their next boundary. lifecycle.ts:4551 has a separate past-due cleanup that suspends rows more than 14 days overdue.
- services/kiloclaw-billing/src/provision-bootstrap-shared.ts:444-452: organization-managed rows are inserted as plan 'standard', status 'active', payment_source 'credits', with no Stripe subscription and no credit_renewal_at or current_period_end. They never renew, so cancel_at_period_end alone never moves them to canceled.
- .specs/kiloclaw-billing.md:519-525: a trial grants access only while trial_ends_at is in the future, and expiry does not move the user to another plan. Trials are 7 days for personal and 14 days for org (alignment-script tests). Trialing rows therefore end on their own.
- packages/db/src/schema-types.ts:825 defines the KiloClawAdminAuditAction enum. The column is plain text, so no migration is needed.
- apps/web/src/app/api/trpc/[trpc]/route.ts sets maxDuration = 800s. The operator says there are about 300 subscriptions.

## Desired outcome

On the KiloClaw admin page, an admin sees how many subscriptions are eligible and confirms a single 'Stop renewal for all subscriptions' action. In one call, every current active or past-due KiloClaw subscription, personal and organization-managed, is set to cancel at its period end in both Stripe (where applicable) and the local DB. Access continues until each period ends. The audit log gets one summary row plus one row per subscription for every outcome. The admin sees updated, skipped and failed counts. Running it again only processes rows that are still eligible.

## Scope

- In admin-router.ts, move the existing period_end branch and its reconcile code into a file-local function with an `allowedStatuses` parameter. The existing per-user mutation passes ['active'] and behaves exactly as today. The bulk mutation passes ['active','past_due'].
- Eligibility: status IN ('active','past_due'), cancel_at_period_end=false, and transferred_to_subscription_id IS NULL. Personal and organization-managed rows are both included.
- Add an admin query, previewBulkCancelKiloClawSubscriptions, that returns eligible counts by status (active/past_due), ownership (personal/org) and funding (Stripe-backed/pure credit), plus the count of rows with no renewal period.
- Add an admin mutation, bulkCancelKiloClawSubscriptions. It requires a confirmation literal, processes all eligible rows in one call with small concurrency, isolates failures per row, and returns {total, updated, skipped, failed: [...]}.
- Audit: one summary 'kiloclaw.subscription.bulk_cancel_at_period_end' row per run, plus a per-subscription 'kiloclaw.subscription.admin_cancel' row for every processed subscription (updated, skipped and failed), linked by bulkRunId.
- Add a UI control on KiloclawInstancesPage: the preview breakdown, typed confirmation, and a result dialog.
- Add router tests and a short note in .specs/kiloclaw-billing.md.

## Exclusions

- Trialing subscriptions. Trials end on their own within 7 days (personal) or 14 days (org) and never auto-convert to paid, so there is nothing to stop.
- Immediate cancellation, refunds, and any suspension or destruction of instances in the default plan. The existing period-end, past-due cleanup and expiry sweeps stay as they are. Handling for org rows with no renewal period is pending an operator answer.
- Blocking enrollment or reactivation, and any persistent EOL flag.
- Client-driven batching or limit inputs.
- Extracting the logic into a new shared lib module.
- User emails and schema migrations.

## Approach

- 1. In admin-router.ts, lift the period_end branch and its reconcile transaction into a file-local `cancelKiloClawSubscriptionAtPeriodEnd({ userId, subscriptionId, actor, allowedStatuses, bulkRunId? })`. Both the status check before the Stripe call and the reconcile check (currently `localSubscription.status !== 'active'`) use allowedStatuses. The existing mutation passes ['active'], so its errors and messages stay the same. The function returns 'updated' | 'already_desired' | 'local_row_changed_after_stripe' and throws as today.
- 2. Next to it, add `previewBulkCancelKiloClawSubscriptions` (query) and `bulkCancelKiloClawSubscriptions` (mutation, input { confirm: z.literal('STOP RENEWALS') }). The eligibility query left-joins kiloclaw_instances, which is only needed for the preview's ownership breakdown. The mutation generates a bulkRunId and runs the function over all eligible rows with a concurrency of about 5, passing allowedStatuses ['active','past_due']. It maps the outcomes to updated, skipped and failed.
- 3. Past-due behavior: for Stripe-backed past_due rows, cancel_at_period_end goes to Stripe exactly as for active rows. Stripe's existing dunning may still collect the open invoice, but there is no new renewal after that. Pure-credit past_due rows get the local flag, and the credit renewal sweep then moves them to canceled at the next boundary instead of retrying. The 14-day past-due cleanup is unchanged.
- 4. Organization-managed rows go through the same period_end path. Default handling, pending the operator's answer: if the row has no current_period_end or credit_renewal_at, the flag is still set and the row is counted in the result and audit metadata as 'no_renewal_period', so the admin can see that it will not cancel by itself. If the operator chooses immediate cancellation for these rows, the bulk loop calls the existing immediate branch only for them.
- 5. Audit: rows that fail before reconciliation get their own 'kiloclaw.subscription.admin_cancel' row ({ bulkRunId, subscriptionId, outcome: 'failed', error }). Updated and skipped rows get their audit row from the function, with bulkRunId attached. After the loop, one 'kiloclaw.subscription.bulk_cancel_at_period_end' summary row records the counts and failed IDs. Add that action to KiloClawAdminAuditAction (text only, no migration).
- 6. UI: add a StopAllRenewalsButton on KiloclawInstancesPage, not gated to development. It shows the preview breakdown, requires the typed phrase, makes one mutation call, and shows a result dialog in the DevNukeAllButton style.
- 7. Tests: a mixed fleet (active Stripe with a schedule, active pure-credit, past_due Stripe, past_due pure-credit, org-managed active, trialing, canceled, already-canceling, transferred) gets only the active and past_due current rows updated. One injected Stripe failure is reported, audited, and does not stop the others. A second run is a no-op. The existing single-cancel tests, including the rejection of non-active rows, stay unchanged.

## Affected areas

- apps/web/src/routers/admin-router.ts
- apps/web/src/app/admin/components/KiloclawInstances/KiloclawInstancesPage.tsx (or a sibling component)
- packages/db/src/schema-types.ts (KiloClawAdminAuditAction)
- .specs/kiloclaw-billing.md
- apps/web/src/routers/admin-kiloclaw-user-router.test.ts (or a new sibling test)

## Acceptance criteria

### ac-13: The bulk mutation sets cancel_at_period_end=true on every row with status 'active' or 'past_due', cancel_at_period_end false and transferred_to_subscription_id null, for both personal and organization-managed instances. Trialing, canceled, already-canceling and transferred rows are left unchanged. A router test with a mixed fixture fleet shows this.

**Verification:** Code review

### ac-2: For each eligible row that has a stripe_subscription_id, the action releases any pending schedule (from the local stripe_schedule_id or the live Stripe subscription's schedule) before calling stripe.subscriptions.update(id, { cancel_at_period_end: true }), and clears stripe_schedule_id, scheduled_plan and scheduled_by locally. Pure-credit rows (no Stripe subscription ID) make no Stripe calls. Tests assert both with the Stripe mocks.

**Verification:** Code review

### ac-14: Access is not ended by the bulk action. Processed rows keep their existing status ('active' or 'past_due') and their current_period_end, credit_renewal_at and past_due_since unchanged.

**Verification:** Code review

### ac-15: Past-due rows are handled. A Stripe-backed past_due row gets cancel_at_period_end=true in Stripe and locally, and a pure-credit past_due row gets the local flag. The reconcile step accepts past_due for bulk calls rather than reporting local_row_changed_after_stripe. Tests cover both kinds of past_due row.

**Verification:** Code review

### ac-4: A Stripe or reconcile failure on one subscription does not stop the others. The mutation result lists each failure with its subscriptionId, userId and a non-sensitive error message, and successful rows are still committed. A test injects one Stripe failure to check this.

**Verification:** Code review

### ac-5: The action is idempotent. Running the mutation a second time after a fully successful run updates no rows and makes no Stripe update calls.

**Verification:** Code review

### ac-11: Each bulk run writes one 'kiloclaw.subscription.bulk_cancel_at_period_end' summary audit row with the actor, bulkRunId, counts and failed subscription IDs. It also writes one 'kiloclaw.subscription.admin_cancel' audit row per processed subscription for every outcome (updated, skipped and failed, including failures before reconciliation such as Stripe errors), each carrying the same bulkRunId and its outcome. Updated rows also get a subscription change-log entry. No secrets or Stripe credentials appear in the logs. Tests assert the per-row audit row for the injected failure.

**Verification:** Code review

### ac-16: The existing admin.users.cancelKiloClawSubscription behavior in both modes is unchanged. In particular, period_end still rejects non-active rows (including past_due) with the same BAD_REQUEST message, still returns CONFLICT on a local row change after Stripe, and produces the same audit and change-log output. The existing tests in admin-kiloclaw-user-router.test.ts pass without changes to their expectations.

**Verification:** Code review

### ac-17: Organization-managed rows with no current_period_end or credit_renewal_at are reported separately ('no_renewal_period') in the preview, the mutation result and the per-row audit metadata, and their handling follows the operator's decision on the open org-row question.

**Verification:** Code review

### ac-8: The bulk procedures are adminProcedure only, and the mutation rejects any input that lacks the exact confirmation literal.

**Verification:** Source review

### ac-12: In a production build, the KiloClaw admin page shows a stop-renewals control (not limited to development). It displays the eligible count, requires typed confirmation, processes all eligible subscriptions in a single request, and shows a result summary with updated, skipped and failed counts and the failure list.

**Verification:** Manual: Against a Stripe test-mode environment, open /admin/kiloclaw as an admin, check the preview count against the seeded data, run the action, confirm the result dialog, check that the affected Stripe test subscriptions show cancel_at_period_end=true, and check that the admin audit log has a summary row plus one row per subscription.

### ac-10: .specs/kiloclaw-billing.md documents the admin bulk non-renewal operation: eligibility, dual provider/local updates, access continuing to period end, and audit.

**Verification:** Source review

## Risks

- Running the action in production affects real billing across the fleet. The mitigations are typed confirmation, the preview breakdown, per-row audit entries, and reversibility through the existing reactivation flows.
- Organization-managed bootstrap rows have no renewal period, so the cancel flag alone never cancels them. This is surfaced as 'no_renewal_period' and the handling is pending the operator's answer.
- For Stripe-backed past_due rows, Stripe dunning may still collect the outstanding invoice before the period ends. That payment is for the current period, not a renewal.
- Stripe can succeed while the local reconcile fails. These cases are reported as failures with audit rows for manual review.
- A single request processes all rows. At about 300 rows this is well under 800s, and re-running after a cut-off request is safe.
- Hybrid rows must still go through Stripe. Eligibility for the Stripe call is based on stripe_subscription_id, not payment_source.
- As with the single cancel, this clears a pending scheduled_plan, including a Commit-to-Standard continuation.
- Users can still reactivate afterwards, so this is not a permanent lock.

## Assumptions

- About 300 subscriptions, essentially single-use.
- Trialing rows need no action because they expire on their own without converting to paid.
- No user notification email is needed.
- Configured verification commands could not be established from the pinned checkout, so criteria use code/source review and one manual check.

## Decisions

### d-1: Which subscriptions are in scope for the bulk action?

**Answer:** Every current (not transferred, not already canceling) subscription with status 'active' or 'past_due', both personal and organization-managed, across all funding types. Trialing rows are excluded because they expire on their own without auto-converting.

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

### d-7: How should organization-managed rows with no renewal period be handled?

**Answer:** Provisional default: set the flag and report the row as 'no_renewal_period'. This is pending the operator's answer to the open question, which may change it to immediate cancellation or exclusion.

**Blocking:** no
