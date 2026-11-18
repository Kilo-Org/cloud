<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Default new child organizations to their parent organization's plan tier

## Problem

Issue #9293 reports that a new sub-org is always created on the Teams tier, even when its parent is Enterprise. createChildOrganization() in apps/web/src/lib/organizations/organization-hierarchy.ts inserts the child organizations row without a plan. The column therefore falls back to the schema default 'teams' (packages/db/src/schema.ts). Both child-creation entry points use this helper without passing a plan: self-service organizations.createChild (organization-router.ts) and admin organizations create when parentOrganizationId is set (organization-admin-router.ts). Children of Enterprise parents end up on Teams, so Enterprise-only behavior and tier display don't match the parent.

## Evidence

- apps/web/src/lib/organizations/organization-hierarchy.ts:102-133 — createChildOrganization inserts name, require_seats, free_trial_end_at, parent_organization_id and settings, but no plan.
- apps/web/src/routers/organizations/organization-router.ts:445-452 — createChild calls createChildOrganization(name, organizationId, userId).
- apps/web/src/routers/organizations/organization-admin-router.ts:306-312 — the admin create calls createChildOrganization(name, parentOrganizationId) when a parent is given.
- packages/db/src/schema.ts — organizations.plan is a not-null column that defaults to 'teams' (per triage observation).
- .specs/team-enterprise-seat-billing.md 'Organization Plans' rules 1-9 — Teams is the data-layer default when the creation flow provides no plan. No rule covers child-org tier inheritance (a search for 'parent' in the spec found no matches).
- apps/web/src/routers/organizations/organization-creation.test.ts — the existing integration tests for createChild and createChildOrganization (real DB, Stripe customer creation mocked) are the natural place for regression tests.

## Desired outcome

A newly created child organization starts on the same plan as its parent at creation time: Enterprise under an Enterprise parent, Teams under a Teams parent. This holds for both the self-service and admin child-creation paths, and the billing spec documents the rule.

## Scope

- Read the parent organization's plan inside the createChildOrganization transaction, before the insert, and set the child's plan to that value.
- Both entry points (organizations.createChild and admin create with parentOrganizationId) get the fix through the shared helper.
- Add a rule to .specs/team-enterprise-seat-billing.md under Organization Plans: a new child organization MUST be created with its parent's current plan. Make clear this is a one-time default at creation.
- Add regression tests in organization-creation.test.ts for Enterprise-parent and Teams-parent children through the self-service createChild path and through the createChildOrganization helper used by the admin path.

## Exclusions

- Keeping child plans in sync after creation: a later change to the parent's plan does not cascade to existing children.
- Changing the tier of an existing organization attached through admin setParent.
- Restricting admin plan editing (PlanDialog/updatePlan) for child orgs. A child's plan stays independently editable.
- Backfilling existing children that were created as Teams under Enterprise parents.
- Schema or migration changes. The 'teams' column default stays.

## Approach

- In createChildOrganization, inside the existing transaction after the advisory lock and the creation-limit check, select plan from organizations where id = parentOrganizationId and deleted_at is null. If no row is found, throw TRPCError NOT_FOUND 'Parent organization not found' (the same message validateParentOrganizationChange uses), so a missing parent fails before the insert.
- Add plan: parentOrganization.plan to the insert values. Leave the other values (require_seats false, free_trial_end_at null, childOrganizationSettings) unchanged.
- Keep the function signature unchanged so both callers inherit the behavior without edits.
- Update the spec with the new inheritance rule. Reword rule 2 if needed so the Teams data-layer default reads as applying only when neither the creation flow nor a parent supplies a plan.
- Add tests: create an Enterprise parent (createOrganization with 'enterprise' or update plan directly), call caller.organizations.createChild and createChildOrganization, and assert child.plan === 'enterprise'. Repeat with a Teams parent and assert 'teams'.

## Affected areas

- apps/web/src/lib/organizations/organization-hierarchy.ts
- apps/web/src/routers/organizations/organization-creation.test.ts
- .specs/team-enterprise-seat-billing.md

## Acceptance criteria

### ac-1: createChildOrganization sets the inserted child's plan to the parent organization's plan, read inside the same transaction before the insert. Under an Enterprise parent the child is persisted as 'enterprise'; under a Teams parent it is persisted as 'teams'.

**Verification:** Source review

### ac-2: Both organizations.createChild (self-service) and admin organizations create with parentOrganizationId go through the updated helper, so both produce children whose plan matches the parent. Neither caller passes or overrides a different plan.

**Verification:** Source review

### ac-3: organization-creation.test.ts has regression tests that (a) create a child of an Enterprise parent through caller.organizations.createChild and assert the persisted child plan is 'enterprise', (b) do the same through createChildOrganization directly (the admin path's helper), and (c) assert a child of a Teams parent is 'teams'.

**Verification:** Code review

### ac-4: Inheritance happens only at creation. No code path propagates later parent plan changes to children, setParent's update fields are unchanged, and the existing child-creation behavior (require_seats false, no free trial, child settings, creation limit, Stripe customer creation) is preserved.

**Verification:** Source review

### ac-5: .specs/team-enterprise-seat-billing.md Organization Plans states that a new child organization MUST be created with its parent's current plan as a creation-time default, and rule 2's Teams default stays consistent with that rule.

**Verification:** Source review

## Risks

- Enterprise children immediately get Enterprise-only behavior (deny lists, groups). This is intended, but it changes behavior for newly created children.
- Children billed through or alongside the parent could show an Enterprise plan without their own subscription. Children already skip seats and trials, so the effect is mainly on entitlements and display.
- Reading the parent row adds one query inside the transaction, which already holds a global advisory lock. The cost is negligible.

## Assumptions

- Inheritance is a one-time default at creation, not ongoing synchronization. The issue asks for children to match the parent 'by default'.
- The request covers only newly created sub-orgs. The issue text is about creating a sub-org, so setParent attach is excluded.
- A child org's plan stays independently editable by admins after creation.
- Child orgs have no subscription of their own that would immediately overwrite the plan through subscription metadata.

## Decisions

### d-1: Is tier inheritance a creation-time default or an ongoing sync?

**Answer:** Creation-time default only. This matches the issue's 'by default' wording and keeps the fix small. Ongoing sync can be a follow-up.

**Blocking:** no

### d-2: Should admin setParent also align an attached org's tier?

**Answer:** No. It is out of scope because the issue concerns new sub-orgs. Attaching an existing org keeps its plan, as it does today.

**Blocking:** no
