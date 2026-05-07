# Organization KiloClaw Billing — Unified Implementation Plan

## Status

Plan only. Supersedes and merges:

- `.plans/org-kiloclaw-billing-backend.md`
- `.plans/org-kiloclaw-billing-ui.md`
- `.plans/org-kiloclaw-billing-admin.md`

Business rules remain governed by:

- `.specs/kiloclaw-billing.md`
- `.specs/kiloclaw-datamodel.md`
- `.specs/team-enterprise-seat-billing.md`

## Goals

Implement organization KiloClaw billing end-to-end:

- Org KiloClaw is pure-credit, month-to-month, per-instance, org-funded.
- Org KiloClaw remains subordinate to parent org seat/trial entitlement.
- Enterprise-only opt-out blocks org KiloClaw only while the org is Enterprise.
- Any org member may provision/manage their own org KiloClaw instance when allowed.
- Owners and billing managers may view/manage org KiloClaw billing details.
- Non-billing-admin associated users see only operational access state/contact-admin prompts.
- Existing org KiloClaw instances receive one 30-day billing-launch trial at launch.
- Renewal, past-due, suspension, destruction, notifications, auto top-up, access gates, admin support, audit, and GDPR behavior satisfy the specs.

## Non-goals

- No direct Stripe hosting subscription for org KiloClaw.
- No org seat-subscription add-on line items for org KiloClaw.
- No org KiloClaw commit plan or plan-switching UI/API.
- No customer-facing cancel-without-destroy or reactivation in MVP.
- No DB uniqueness constraint for one active org KC instance per user/org; enforce in UI/router/service logic.

## Resolved contract decisions

### Launch date and pre-launch behavior

`KILOCLAW_ORG_BILLING_LAUNCH_DATE` is the enforcement switch.

Before launch date is set/reached:

- Existing org KiloClaw behavior remains non-charging and non-blocking on org KC credits.
- New org KC provisioning may create bootstrap rows, but these rows are treated as pre-launch/unbilled org KC state.
- Org KC billing UI may render read-only/pre-launch copy, but MUST NOT imply active paid org KC billing.
- Renewal charging, org credit insufficiency blocking, launch trials, and billing-launch notification flows stay inert.

At/after launch:

- Active org-owned KC instances are reconciled into canonical org KC subscription rows.
- Existing active org instances receive one 30-day launch trial ending `launchDate + 30 days`.
- Launch backfill never creates a second subscription row for an instance.
- Launch backfill updates an existing pre-launch row when present; creates only when missing.
- Destroyed org instances are ignored by launch backfill unless a row is needed only for historical remediation.

### Trial eligibility

A user receives at most one free org KC trial per organization.

Eligibility for a new 7-day org KC trial is false when any historical org KC instance/subscription record exists for the `(associatedUserId, organizationId)` pair, including:

- active rows,
- destroyed rows,
- canceled rows,
- 7-day trial rows,
- 30-day launch-backfill rows.

The 30-day launch trial is migration-granted access and blocks future reusable 7-day org KC trials. Destroy/recreate after launch backfill requires sufficient org credits immediately.

### Parent entitlement precedence

Parent organization entitlement is the highest-level org KC gate because org KC is subordinate to org seat/trial entitlement.

Shared helpers MUST expose explicit state instead of relying on ad hoc UI ordering:

- `deriveParentEntitlementState(org, latestSeatPurchase, now)`
- `deriveOrgKiloclawProvisionState(input)`
- `deriveOrgKiloclawAccessState(input)`
- `deriveOrgKiloclawDisplayState(input)`

Provision-state priority:

1. `blocked_parent_entitlement`
2. `blocked_opt_out`
3. `blocked_existing_instance`
4. `blocked_insufficient_credits`
5. `allowed`

Access-state priority:

1. instance missing/destroyed/quarantined => denied
2. parent entitlement blocks => denied
3. Enterprise opt-out enforced => denied
4. local subscription grants access => allowed
5. otherwise denied

Display-state MUST return both:

- `blocker: null | blocked_parent_entitlement | blocked_opt_out | quarantined`
- `lifecycle: not_provisioned | active | trialing | past_due_grace | past_due_suspended | canceling_at_period_end | canceled | destroyed`

UI badges may derive a single label from `(blocker, lifecycle)`, but APIs MUST return the richer shape so admin, member, and provisioning surfaces do not contradict each other.

Parent entitlement outcomes:

- `allowed`: require-seats disabled, active subscription purchase, or organization trial not hard-expired.
- `org_trial_hard_expired`: blocks org KC access/provisioning, does not immediately cancel org KC rows.
- `org_subscription_ended`: blocks access/provisioning and immediately cancels all live org KC subscriptions.
- `no_org_subscription`: blocks only when the org has no valid trial/entitlement path under existing seat-billing rules.

### Enterprise opt-out

- Stored in organization settings as `kiloclaw_opt_out?: boolean`.
- Configurable only for Enterprise orgs by owners/billing managers.
- Persisted while Teams but hidden/non-configurable and not enforced while Teams.
- Enforced again if the org returns to Enterprise.
- When enforced: block provisioning, block access, prevent future org KC renewals.
- Opt-out does not by itself cancel subscriptions.
- Renewal while opt-out is enforced: skip charging, leave `credit_renewal_at` due, set a non-terminal paused/blocked display state through the blocker, and re-evaluate immediately after opt-out is disabled. Do not catch up multiple missed periods in one sweep.

### Role visibility

Customer API payloads are role-discriminated.

Admin role (`owner`, `billing_manager`; site admin projected consistently with existing org middleware) MAY receive:

- subscription ID,
- instance ID,
- plan/payment source,
- status,
- current period dates,
- credit renewal date,
- trial start/end,
- launch-backfill flag,
- renewal cost,
- org credit balance,
- auto top-up status,
- associated user basics,
- parent entitlement summary,
- opt-out state.

Member role MUST NOT receive:

- subscription IDs,
- credit balance,
- invoices,
- price/cost/shortfall,
- billing period dates,
- renewal dates,
- exact trial end dates,
- provider IDs.

Member role MAY receive:

- operational access state,
- whether action is needed from a billing admin,
- generic trialing/available/blocked/past-due/canceling labels,
- contact-admin copy.

Internal `/admin` surfaces may show billing details to Kilo staff, subject to internal admin authorization and audit rules.

### Credit and ledger rules

Org KC paid rows are pure credit rows:

- `payment_source = 'credits'`
- provider subscription ID is null
- plan is internally `standard`
- no Stripe hosting subscription
- no seat-subscription add-on line item

Cost is `9_000_000` microdollars per month until a later pricing rule changes it.

Org credit balance is computed as:

```text
total_microdollars_acquired - microdollars_used
```

Deductions:

- insert `credit_transactions` with `organization_id`, associated `kilo_user_id`, negative amount, deterministic period/category key, and category-uniqueness protection,
- increment `organizations.microdollars_used`,
- keep deprecated `organizations.microdollars_balance` synchronized while the column exists,
- do not decrement `total_microdollars_acquired`,
- write subscription change log in the same transaction when subscription state mutates.

### Lifecycle semantics

Creation:

- Requires sufficient org credits for the first paid period even when a 7-day org KC trial is granted.
- Exception: launch backfill does not require or deduct credits at creation.
- If trial eligible, create trialing row with trial end `max(now + 7 days, orgTrialEndAt when org trial extends longer)`.
- If not trial eligible, deduct first month and create active row.

Renewal:

- Select due pure-credit org rows, including trialing/active/past-due rows.
- Hybrid/Stripe paths do not apply to org KC.
- Advance exactly one period per successful sweep run; no multi-period catch-up in one pass.
- At trial end, successful deduction transitions `trialing -> active`.
- Insufficient credits triggers org auto top-up once per period when available.
- If auto top-up cannot/does not resolve, set/preserve `past_due_since`, send role-aware notifications, then existing past-due lifecycle applies.

Past due:

- Non-suspended past-due continues to grant access during the 14-day grace period.
- After 14 days, stop instance, set `suspended_at`, set destruction deadline 7 days out, send notifications.
- On recovery, deduct due period, transition active, attempt auto-resume, clear suspension fields only after successful start/no-instance case.

User destroy:

- Tear down infrastructure immediately.
- Mark instance destroyed.
- Set subscription `cancel_at_period_end = true`.
- No refund/proration.
- Period-boundary cancellation sweep includes destroyed canceling rows and sets status `canceled` without charging.
- Destroyed canceling rows MUST NOT be skipped before the cancel branch runs.

Parent entitlement ended:

- Immediately cancel all live org KC rows for the org.
- Clear no-renew fields so rows do not renew.
- Preserve instance records; do not destroy instances unless the spec changes.
- Record durable cancellation reason (`parent_entitlement_ended`) or equivalent indexed status reason, not only a change-log note.

Parent trial hard-expired:

- Block access/provisioning.
- Do not immediately cancel org KC rows.
- Do not let org KC state recover or extend parent entitlement.

Opt-out enforced:

- Block access/provisioning.
- Do not deduct renewals while enforced.
- Do not cancel solely due to opt-out.
- On disable, next renewal sweep processes at most one due period.

### Data model, audit, and change log

Before org KC subscription mutations ship, implement `kiloclaw_subscription_change_log` per `.specs/kiloclaw-datamodel.md`:

- append-only,
- one entry per business mutation,
- DB-server timestamp,
- actor type/id (`user` or `system`),
- consistent action labels,
- before/after state detail,
- optional safe context/reason,
- no tokens/secrets/card data,
- GDPR anonymization support.

Every subscription mutation in this plan MUST write a change-log entry:

- bootstrap creation,
- launch backfill create/update,
- trial -> active,
- active renewal,
- past-due transition,
- suspension/destruction scheduling,
- auto-resume recovery,
- user destroy/cancel-at-period-end,
- period-end cancellation,
- parent-ended cancellation,
- admin override,
- quarantine/remediation mutation.

Action labels must be documented before use.

### Bootstrap and orphan handling

Target creation order follows `.specs/kiloclaw-datamodel.md`:

1. infrastructure exists,
2. `kiloclaw_instance` row exists,
3. billing bootstrap creates corresponding subscription row in the same provisioning request.

If bootstrap fails after instance creation:

- provisioning service retries or runs fallback bootstrap before returning,
- request MUST NOT complete successfully with an unpaired instance,
- if all bootstrap paths fail, mark the instance explicitly quarantined and return failure,
- onboarding completion/ding waits for both instance and subscription persistence.

Existing-active-instance checks during bootstrap MUST exclude the target instance that was just created.

## Unified user/admin surfaces

### Customer-facing org surfaces

- `/organizations/[id]/claw/subscription`: role-aware subscription/status page.
- `/organizations/[id]/claw/*`: ambient banner + lock dialog mounted in org claw layout.
- `/organizations/[id]/claw/new`: preflight-gated provisioning wizard.
- `/organizations/[id]/settings`: settings shell with tabs.
- `/organizations/[id]/settings?tab=kiloclaw`: Enterprise-only opt-out control.
- Existing destroy flow: org-aware copy, launch-trial forfeiture copy, cancel-at-period-end side effect.

### Customer-facing owner/billing-manager follow-ups

- `/organizations/[id]/subscriptions`: org KC group next to seats group.
- `/organizations/[id]/subscriptions/kiloclaw/[instanceId]`: org KC detail/history page.
- Org dashboard alert tile for org-wide KC past-due/suspended/parent-canceled counts.
- Associated-user dashboard banner for the viewer's own org KC state.
- Associated-user chip in claw settings header.

### Internal `/admin` surfaces

- `/admin/kiloclaw`: org-aware filters/search/stats/readiness.
- `/admin/kiloclaw/[id]`: billing support card, operational reason, links, raw IDs, change logs.
- `/admin/users/[id]?tab=kiloclaw`: separate personal/org rows; personal-only actions disabled on org rows unless explicit org-safe override exists.
- `/admin/organizations/[id]`: org KC support section with aggregate counts and instance/subscription list.
- Admin readiness/health card for launch date, launch backfill, orphan/quarantine rows, due renewals, past-due/suspended counts.
- Saved incident filters for org past-due, suspended, launch trials ending, canceling, parent-blocked, opt-out-blocked, orphan/quarantined.

## API/procedure contracts

### Customer org procedures

`organizations.kiloclaw.getBillingStatus({ organizationId })`

- Server derives role.
- Returns redacted member payload or admin detail payload.
- Includes `blocker`, `lifecycle`, and `access` objects.
- Member payload contains no prohibited billing fields.
- Loads destroyed/canceling rows when needed to explain lifecycle.

`organizations.kiloclaw.getProvisionPreflight({ organizationId })`

- Server derives role.
- Uses `deriveOrgKiloclawProvisionState`.
- Admin blocked-insufficient-credit payload includes balance/cost/shortfall.
- Member blocked-insufficient-credit payload contains no balance/cost/shortfall.
- Allowed admin payload includes first paid cost and estimated trial end if relevant.
- Allowed member payload includes only `trialEligible` and generic copy inputs.

`organizations.kiloclaw.provision(...)`

- Runs preflight inside the existing org provision lock.
- Recomputes server-side; does not trust client preflight.
- Throws structured `PRECONDITION_FAILED` on blockers.
- Calls worker/billing bootstrap; success requires paired instance + subscription.

`organizations.kiloclaw.destroy(...)`

- Calls shared org KC destroy helper.
- Infrastructure teardown and subscription cancel-at-period-end are one logical operation with compensation/rollback on failure.
- Writes change log.

`organizationSettings.setKiloClawOptOut({ organizationId, optOut })`

- Owner/billing-manager only.
- Enterprise-only mutation.
- JSONB merge preserving other settings.
- Writes org settings audit log.
- Teams preserves value but cannot configure/enforce.

### Backend worker/service APIs

`services/kiloclaw-billing`:

- launch backfill/reconciliation sweep,
- authoritative org bootstrap,
- org credit renewal,
- org lifecycle sweeps,
- parent-ended cancellation reconciliation,
- org auto top-up side-effect call,
- change-log writes.

`services/kiloclaw`:

- direct proxy/user-route/access-code gates for org instances,
- blocks bookmarked/direct access when parent/opt-out/subscription state denies access,
- preserves personal behavior.

### Internal admin procedures

`admin.kiloclawInstances.list/get` additions:

- scope filters,
- org search,
- operational filters,
- trial-kind filters,
- org/associated-user metadata,
- billing support payload,
- readiness/health aggregates.

`admin.kiloclawInstances.getSubscriptionChangeLogs({ instanceId | subscriptionId })`

- Paginated/support-safe change log access.

`organizations.admin.getOrgKiloclawHealthSummary({ organizationId })`

- Admin org page aggregate counts.

Customer owner/billing-manager procedures for follow-up surfaces:

- `listSubscriptions`
- `getSubscriptionDetail`
- `getBillingHistory`
- `getOrgKiloclawHealthSummary`

## Vertical slice implementation sequence

Each slice should be independently reviewable and tested. Slices 0–8 are launch-critical and must deploy before ops sets `KILOCLAW_ORG_BILLING_LAUNCH_DATE`. Slices 9–11 may follow if support accepts launch without those convenience surfaces; internal launch readiness in Slice 2 is still launch-critical.

### Slice 0 — Foundation: schema, config, contracts, change log

**Backend**

- Add `kiloclaw_subscriptions.is_launch_backfill boolean NOT NULL DEFAULT false`.
- Add org subscription cancellation/status reason field if needed for parent-ended/admin counts.
- Add `OrganizationSettingsSchema.kiloclaw_opt_out?: boolean`.
- Add `kiloclaw_subscription_change_log` schema and documented action labels.
- Add shared mutation/change-log helper.
- Add launch-date config parsing in Next.js and `services/kiloclaw-billing`.
- Add shared helpers for cost, org credit balance, parent entitlement, opt-out enforcement, provision/access/display state.

**UI**

- Add shared TypeScript types for role-redacted status/preflight contracts.
- No customer-visible behavior change.

**Admin**

- No visible behavior change.

**Tests**

- Schema/type tests where applicable.
- Fixture tests for parent entitlement, opt-out enforcement, launch switch, provision/access/display state, role redaction.
- Change-log helper tests, including transaction rollback behavior.

**Exit criteria**

- Contracts compile and are fixture-tested.
- No subscription mutation path added after this may bypass the change-log helper.

### Slice 1 — Launch reconciliation and readiness

**Backend**

- Implement launch backfill/reconciliation sweep/script.
- Update existing pre-launch org KC rows in place; create only missing rows.
- Never create duplicate subscription rows for one instance.
- Set launch rows: `standard`, `trialing`, `credits`, provider ID null, trial/current period/credit renewal ending `launchDate + 30 days`, `is_launch_backfill = true`, no deduction.
- Treat launch rows as historical org KC records for future 7-day trial eligibility.
- Ignore destroyed instances except remediation reporting.

**UI**

- Optional pre-launch subscription page copy behind read-only status contract.

**Admin**

- Add `/admin/kiloclaw` readiness card:
  - launch date configured/unset,
  - active org instances without subscription rows,
  - existing rows needing launch reconciliation,
  - launch trial row count/common end date,
  - orphan/quarantined rows,
  - due-renewal/past-due/suspended counts.

**Tests**

- Idempotency.
- Existing-row update vs missing-row create.
- No duplicate subscription per instance.
- No credit deduction.
- Destroyed ignored.
- Launch row blocks future 7-day trial.
- Readiness aggregate links/filter counts.

**Exit criteria**

- Ops can dry-run/review launch impact before setting launch date.

### Slice 2 — Provision preflight and authoritative bootstrap

**Backend**

- Implement `getProvisionPreflight`.
- Gate `provision` mutation with server-side preflight inside provision lock.
- Update billing-worker bootstrap to recompute and enforce:
  - parent entitlement,
  - Enterprise opt-out,
  - existing active instance excluding target instance,
  - trial eligibility,
  - org credit sufficiency.
- Implement transactional bootstrap:
  - trialing row if eligible,
  - active paid row + first-period org credit deduction if not eligible,
  - change log,
  - idempotent duplicate handling,
  - fallback/quarantine on bootstrap failure.

**UI**

- Refactor `/organizations/[id]/claw/new` to preflight dispatcher.
- Add blocks for parent entitlement, opt-out, existing instance, insufficient credits.
- Admin copy can show cost/balance/shortfall.
- Member copy must not show cost/balance/shortfall.
- Allowed wizard copy handles org-trial-extended trial end for admins; members receive generic role-safe copy.

**Admin**

- `/admin/kiloclaw` readiness card links to orphan/quarantine rows.
- Admin instance list can show `quarantined`/bootstrap-failed state when present.

**Tests**

- Preflight branch matrix by role.
- Member redaction assertions.
- Bootstrap trial, paid, insufficient credits, parent block, opt-out block, duplicate, target-instance exclusion, quarantine failure.
- Onboarding success waits for instance + subscription.

**Exit criteria**

- New provisioning cannot create a live unpaired org instance and cannot bypass billing rules.

### Slice 3 — Role-aware billing status and customer read surface

**Backend**

- Implement `getBillingStatus` with `blocker`, `lifecycle`, `access`.
- Include admin-only subscription/org credit/parent/opt-out details.
- Include member-safe operational state only.
- Load current viewer's org KC row, including destroyed/canceling rows when needed.
- Soft-deleted associated users return anonymized values.

**UI**

- Add `/organizations/[id]/claw/subscription`.
- Add owner/billing-manager admin card.
- Add member state card.
- Add shared status badges/shell components reused by ambient surfaces.
- Sidebar adds org KC Subscription link.

**Admin**

- Extend `/admin/kiloclaw` list with org/customer row metadata enough to cross-link customer subscription page.

**Tests**

- Status matrix for blocker/lifecycle/access combinations.
- Member payload contains no IDs, costs, balances, period dates, renewal dates, exact trial ends, provider IDs.
- Admin payload includes expected details.
- Page rendering matrix.

**Exit criteria**

- Users and billing admins can understand current org KC state without mutation side effects.

### Slice 4 — Access gates and ambient locks

**Backend**

- Add org KC access middleware to Next.js org KC routes operating on existing instances.
- Add direct worker gate in `services/kiloclaw` for:
  - `/i/:instanceId/*`,
  - active-instance cookie routing,
  - user-facing APIs accepting `instanceId`,
  - access-code/open-instance flows.
- Allow status/preflight/service-degraded/latest-version queries where needed.
- Past-due grace grants access; suspended past-due blocks.
- Parent block and opt-out block promptly.

**UI**

- Mount `OrgBillingWrapper` in org claw layout.
- Add org billing banner and access-locked dialog.
- Lock fires for parent block, opt-out, and suspended past-due.
- Banners show role-safe admin/member CTAs.

**Admin**

- `/admin/kiloclaw/[id]` billing support card can show access-denial reason.

**Tests**

- tRPC gates reject blocked states and allow grace-period past-due.
- Worker proxy/access-code/direct routes reject blocked org instances.
- Personal routes unchanged.
- Banner/lock state tests by role.

**Exit criteria**

- UI locks are not the only enforcement; direct worker access is blocked.

### Slice 5 — Renewal, lifecycle, auto top-up, notifications

**Backend**

- Implement org pure-credit renewal path.
- Include `trialing`, `active`, `past_due`; exclude hybrid/Stripe.
- Process cancel-at-period-end before deduction, including destroyed rows.
- Enforce one-period-per-sweep advancement.
- Implement org auto top-up fire-and-skip with durable one-attempt-per-period marker.
- Implement insufficient-credit past-due transition.
- Implement 14-day suspension, 7-day destruction deadline, destruction warning, destruction, and interrupted auto-resume for org rows.
- Add role-aware notification recipient/idempotency model:
  - owners/billing managers receive top-up/admin CTA,
  - associated non-admin receives contact-admin copy,
  - each recipient/lifecycle event is idempotent.
- Add Next internal side effect `trigger_organization_auto_top_up` calling existing org auto top-up logic.

**UI**

- Billing status and banners render past-due grace/suspended/admin-action states from status API.
- Admin users get top-up CTAs; members get contact-admin copy.

**Admin**

- `/admin/kiloclaw` filters/stats include due soon, past due, suspended, destruction deadline.
- Detail support card shows auto-top-up marker/status when available.

**Tests**

- Trial conversion to paid active.
- Active renewal.
- Past-due recovery.
- Suspended recovery + auto-resume.
- Insufficient credits.
- Auto top-up fire-and-skip.
- Auto top-up already-attempted => past due.
- Cancel-at-period-end no charge.
- Opt-out skip.
- One-period-per-sweep overdue row.
- Notifications by recipient/role/idempotency.

**Exit criteria**

- Org KC can renew, fail, suspend, recover, and notify according to spec.

### Slice 6 — Destroy cancellation end-to-end

**Backend**

- Implement shared org destroy helper.
- Destroy infra immediately; mark instance destroyed.
- Set subscription `cancel_at_period_end = true`.
- No refund/proration.
- Write change log.
- Compensate/rollback subscription flag if worker destroy fails and instance destruction is rolled back.
- Period-boundary cancellation sweep transitions destroyed canceling rows to `canceled` without charging.

**UI**

- Update destroy confirmation copy.
- Include launch-backfill forfeiture copy when applicable.
- No cancel-without-destroy or reactivate controls.

**Admin**

- `admin.kiloclawInstances.destroy` calls same helper or proves equivalent side effects.
- Disable unsafe personal-only cancel/trial-reset actions for org rows.
- `/admin/users/[id]?tab=kiloclaw` separates personal/org rows and active-instance links.

**Tests**

- Customer destroy and admin destroy parity.
- Destroy marks instance destroyed + subscription canceling.
- Worker failure leaves subscription unchanged or compensates.
- Period-boundary cancellation sees destroyed canceling row and does not deduct.
- Launch-backfill destroy copy.

**Exit criteria**

- Destroy is the only customer termination path and matches spec.

### Slice 7 — Enterprise opt-out settings end-to-end

**Backend**

- Implement `setKiloClawOptOut`.
- Add active-instance count query.
- Enforce Enterprise-only configuration.
- Persist Teams value without enforcement.
- Audit org settings change.
- Ensure provision/access/renewal/status helpers consume opt-out enforcement consistently.

**UI**

- Restructure org settings page into tabs.
- Redirect `/providers-and-models` to `/settings?tab=providers-and-models`.
- Add `kiloclaw` tab.
- Teams copy: org KC is available; the opt-out control is Enterprise-only.
- Enterprise toggle:
  - enabling requires confirmation with active-instance count and consequences,
  - disabling is one click.

**Admin**

- Show opt-out state on admin detail/list/org support surfaces.
- Add admin opt-out mutation only if support explicitly needs it; otherwise read-only.

**Tests**

- Enterprise gate.
- Role gate.
- Teams hidden/non-enforced semantics.
- Persisted setting re-enforced after Enterprise transition.
- Audit entry.
- Active-instance count excludes destroyed.
- UI tab/copy tests.

**Exit criteria**

- Enterprise admins can disable org KC, and all gates respect it.

### Slice 8 — Parent-entitlement-end cancellation and reconciliation

**Backend**

- Add event-driven cancellation from seat subscription lifecycle when parent entitlement becomes ended/non-recoverable.
- Add sweep reconciliation as safety net.
- Cancel all live org KC rows for org immediately.
- Record cancellation reason `parent_entitlement_ended`.
- Do not mutate parent subscription.
- Do not destroy instances unless spec changes.
- Hard-expired org trial blocks access but does not cancel.

**UI**

- Billing status/subscription page renders parent-blocked reason and admin CTA to org subscription page.
- Member copy says contact owner/billing manager.

**Admin**

- List/detail/org pages expose parent-ended cancellation reason and counts.

**Tests**

- Ended parent cancels live org KC rows immediately.
- Hard-expired org trial blocks but does not cancel.
- Recoverable parent states do not cancel.
- Parent-canceled rows do not renew.
- Admin counts derive from durable reason.

**Exit criteria**

- Parent entitlement cannot be extended/recovered by org KC state, and ended parent stops all org KC renewal/access.

### Slice 9 — Internal admin launch/support readiness

**Backend**

- Expand `admin.kiloclawInstances.list/get` with org billing fields, filters, aggregates, and support payloads.
- Add change-log query by instance/subscription.
- Add cheap admin dashboard aggregate procedures.

**UI/Admin**

- `/admin/kiloclaw`:
  - scope filter personal/org,
  - org ID/name search,
  - subscription status filter,
  - operational/blocker/lifecycle filters,
  - trial-kind filter,
  - split stats personal vs org,
  - org billing health counts.
- `/admin/kiloclaw/[id]`:
  - billing support card,
  - reason callouts,
  - links to user/org/customer pages/change logs,
  - collapsed raw IDs.
- `/admin/users/[id]?tab=kiloclaw`:
  - separate personal/org sections,
  - no personal-only actions on org rows.
- `/admin/organizations/[id]`:
  - org KC support card/table,
  - credit balance,
  - renewal-cost aggregate,
  - blocked/past-due/suspended/canceling counts.

**Tests**

- Admin filter/search/count tests.
- Support card state tests.
- Mutation guard tests.
- Change-log rendering/query tests.

**Exit criteria**

- Support can triage org KC billing at launch without ad hoc DB queries.

### Slice 10 — Customer owner/billing-manager subscription overview follow-up

**Backend**

- Add owner/billing-manager procedures:
  - `listSubscriptions`,
  - `getSubscriptionDetail`,
  - `getBillingHistory`,
  - `getOrgKiloclawHealthSummary`.
- Define org KC credit transaction category convention before history query ships.
- Cursor paginate lists/history.

**UI**

- Add org KC group on `/organizations/[id]/subscriptions`.
- Add org KC detail page under `/subscriptions/kiloclaw/[instanceId]`.
- Add org dashboard alert tile for past-due/suspended/parent-canceled counts.

**Admin**

- Reuse procedure shapes where useful; no new internal requirements.

**Tests**

- Admin-gate enforcement for customer owner/billing-manager procedures.
- Pagination.
- Terminal filter.
- Aggregate counts.
- Detail/history rendering.

**Exit criteria**

- Org billing admins have customer-facing fleet overview and history.

### Slice 11 — Associated-user polish follow-up

**Backend**

- Extend org `getStatus` with `associatedUser` basics.
- Personal `getStatus` returns `associatedUser: null`.
- Use soft-deleted/anonymized user values.

**UI**

- Add associated-user dashboard banner for current user's own org KC state.
- Add associated-user chip in claw settings header.
- Keep `/profile` personal-only; no org trial copy there.

**Admin**

- No new admin requirement.

**Tests**

- Banner variant derivation by role/state/trial threshold.
- Chip render/null/self tests.
- Soft-deleted user PII safety.
- Personal status null associated user.

**Exit criteria**

- Associated ownership is visible without changing billing behavior.

## Launch checklist

Before ops sets `KILOCLAW_ORG_BILLING_LAUNCH_DATE`:

1. Slices 0–8 deployed.
2. Admin readiness card shows no unremediated active org instances without canonical subscriptions, except explicit quarantines.
3. Launch backfill dry-run/reconciliation count reviewed.
4. Worker direct access gate deployed.
5. Billing worker renewal/lifecycle deployed.
6. Parent-ended cancellation event + sweep deployed.
7. Opt-out settings deployed and enforced only for Enterprise.
8. Role-redaction tests prove member payloads contain no prohibited billing fields.
9. Change-log coverage exists for every org KC subscription mutation.
10. GDPR audit complete for associated-user/admin PII exposure and change logs.
11. Alerting/log dashboards cover bootstrap failures, launch backfill failures, renewal failures, auto top-up failures, parent cancellation, access denials, orphan/quarantine counts.
12. Targeted tests and `scripts/typecheck-all.sh --changes-only` pass; run full `pnpm typecheck` only if needed per repo guidance.
13. `pnpm format` run before commit/merge.

## Verification targets

Run Postgres first when needed:

```sh
docker compose -f dev/docker-compose.yml ps postgres
pnpm test:db
```

Targeted checks:

```sh
pnpm test -- apps/web/src/lib/kiloclaw/org-billing/*.test.ts
pnpm test -- apps/web/src/routers/organizations/organization-kiloclaw-router.test.ts
pnpm test -- apps/web/src/routers/organizations/organization-settings-router.test.ts
pnpm test -- apps/web/src/routers/admin-kiloclaw-instances-router.test.ts
pnpm test -- apps/web/src/routers/admin-router.test.ts
pnpm --filter kiloclaw-billing test
pnpm --filter kiloclaw test
scripts/typecheck-all.sh --changes-only
pnpm format
```

## Open confirmations before Slice 0

Resolve before coding starts:

1. Exact parent-entitlement helper inputs/outputs from existing seat-billing code.
2. Durable field name and enum values for org KC cancellation/status reason.
3. Quarantine marker location on `kiloclaw_instance` or related operational table.
4. Final org auto top-up API payload for `trigger_organization_auto_top_up`.
5. Whether support needs an internal admin opt-out override in MVP or read-only is sufficient.
