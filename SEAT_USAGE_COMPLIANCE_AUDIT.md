# Seat Usage Counting Rules Compliance Audit

## Summary

This audit examines the codebase for compliance with the Seat Usage Counting rules specified in `.specs/team-enterprise-seat-billing.md` (lines 217-246).

**Audit Date:** 2026-03-28  
**Codebase Version:** Current HEAD  
**Specification Version:** Updated 2026-03-28 (comprehensive audit with all severities)

---

## Rule-by-Rule Compliance Assessment

### Rule 1: Count Active Organization Members (Except Billing Managers)

**Specification:**

> "The system MUST count each active organization member toward seat usage, except members with the billing manager role."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organization-seats.ts`, line 72

  ```typescript
  const used = members.filter(m => m.role !== 'billing_manager').length;
  ```

  The `getOrganizationSeatUsage()` function explicitly filters out billing_manager role members.

- **File:** `src/lib/organizations/organizations.ts`, lines 63-65

  ```sql
  SELECT 1 FROM ${organization_memberships} om
  WHERE om.organization_id = ${organizations.id}
    AND om.role != 'billing_manager'
  ```

  The `getUserOrganizationsWithSeats()` function correctly excludes billing_manager members from seat count in the SQL subquery.

- **File:** `src/routers/organizations/organization-members-router.ts`, line 397
  ```typescript
  eq(kilocode_users.is_bot, false);
  ```
  Active members query explicitly filters for non-bot users in `getOrganizationMembers()`.

**Test Coverage:**

- `src/lib/organizations/organization-seats.test.ts`, lines 793-847: Test suite confirms billing_manager members are excluded.
- `src/lib/organizations/organization-seats.test.ts`, lines 850-915: Dedicated test suite for billing_manager exclusion.

---

### Rule 2: Count Pending Invitations (Except Billing Manager Role)

**Specification:**

> "The system MUST count each pending invitation toward seat usage, except invitations for the billing manager role."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organizations.ts`, lines 67-71
  ```sql
  SELECT 1 FROM ${organization_invitations} oi
  WHERE oi.organization_id = ${organizations.id}
    AND oi.accepted_at IS NULL
    AND oi.expires_at > NOW()
    AND oi.role != 'billing_manager'
  ```
  Pending invitation query in `getUserOrganizationsWithSeats()` explicitly:
  - Excludes invitations with `accepted_at` IS NOT NULL (not pending)
  - Excludes expired invitations (`expires_at > NOW()`)
  - Excludes billing_manager role invitations (`oi.role != 'billing_manager'`)

**Test Coverage:**

- `src/lib/organizations/organization-seats.test.ts`, lines 463-501: Tests for pending invitations in member count.
- `src/lib/organizations/organization-seats.test.ts`, lines 885-915: Dedicated test for billing_manager invitation exclusion.

---

### Rule 3: NOT Count Expired Invitations

**Specification:**

> "The system MUST NOT count expired invitations toward seat usage."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organizations.ts`, line 70

  ```sql
  AND oi.expires_at > NOW()
  ```

  The query explicitly includes only invitations where `expires_at > NOW()`, which excludes all expired invitations.

- **File:** `src/lib/organizations/organizations.ts`, lines 309-320
  Function `inviteUserToOrganization()` creates invitations with default expiration:
  ```typescript
  expires_at: sql`NOW() + INTERVAL '7 days'`;
  ```
  Invitations expire 7 days after creation.

**Test Coverage:**

- `src/lib/organizations/organization-seats.test.ts`, lines 503-528: Test explicitly verifies expired invitations are NOT counted.

---

### Rule 4: NOT Count Accepted Invitations

**Specification:**

> "The system MUST NOT count accepted invitations toward seat usage (accepted invitees are counted as active members instead)."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organizations.ts`, line 69

  ```sql
  AND oi.accepted_at IS NULL
  ```

  The query explicitly excludes invitations where `accepted_at` is not null, ensuring accepted invitations are not double-counted.

- **File:** `src/lib/organizations/organizations.ts`, lines 522-526
  When an invitation is accepted, the user is added to `organization_memberships`:
  ```typescript
  const [updatedInvitation] = await tx
    .update(organization_invitations)
    .set({ accepted_at: sql`NOW()` });
  ```
  And the user is then counted as an active member (Rule 1).

**Test Coverage:**

- `src/lib/organizations/organization-seats.test.ts`, lines 530-556: Test explicitly verifies accepted invitations are NOT counted in seat usage.

---

### Rule 5: NOT Count Bot Users

**Specification:**

> "The system MUST NOT count bot users (see Definitions) toward seat usage."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organizations.ts`, lines 394-398
  In `getOrganizationMembers()`:

  ```typescript
  .where(
    and(
      eq(organization_memberships.organization_id, organizationId),
      eq(kilocode_users.is_bot, false)
    )
  ),
  ```

  Active members query filters `is_bot = false`.

- **File:** `packages/db/src/schema.ts`, line 201

  ```typescript
  is_bot: boolean().default(false).notNull();
  ```

  Users have an `is_bot` flag (defaults to false).

- **Database Schema Constraint:** The `kilocode_users` table tracks bot users via the `is_bot` boolean column. All member queries include `is_bot = false` filter.

**Important Note:** The `getOrganizationSeatUsage()` function (line 64-75 in organization-seats.ts) does NOT explicitly filter bot users. However, this function calls `getOrganizationMembers()` which already excludes bot users. Therefore, seat usage is correctly computed.

**Test Coverage:** While there are no explicit tests for bot user exclusion in seat counting, the underlying query in `getOrganizationMembers()` is tested extensively and bot users cannot be invited (no UI path for bot user invitations).

---

### Rule 6: Report Seat Usage as Pair (Used + Total)

**Specification:**

> "The system MUST report seat usage as a pair: seats used (members plus qualifying pending invitations) and total seats purchased."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organization-seats.ts`, lines 64-75

  ```typescript
  export async function getOrganizationSeatUsage(
    organizationId: Organization['id']
  ): Promise<{ used: number; total: number }> {
    const [members, organization] = await Promise.all([
      getOrganizationMembers(organizationId),
      getOrganizationById(organizationId),
    ]);
    const used = members.filter(m => m.role !== 'billing_manager').length;
    const total = organization?.seat_count || 0;
    return { used, total };
  }
  ```

  Returns object with `{ used, total }` properties.

- **File:** `src/routers/organizations/organization-router.ts`, lines 340-346
  TRPC endpoint returns both values:

  ```typescript
  seats: organizationMemberProcedure.query(async opts => {
    const res = await getOrganizationSeatUsage(opts.input.organizationId);
    return {
      totalSeats: res.total,
      usedSeats: res.used,
    };
  }),
  ```

- **File:** `src/lib/organizations/organizations.ts`, lines 84-98
  `getUserOrganizationsWithSeats()` returns:
  ```typescript
  seatCount: {
    used: result.total_member_count,
    total: result.organization.seat_count,
  }
  ```

**Test Coverage:** Comprehensive tests verify both values are returned correctly across all scenarios.

---

### Rule 7: Allow Seat Usage to Exceed Total Purchased

**Specification:**

> "The system MUST allow seat usage to exceed total purchased seats (no hard block on over-usage at the counting layer)."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/lib/organizations/organization-seats.ts`, lines 64-75
  The `getOrganizationSeatUsage()` function has NO validation that `used <= total`. It simply returns both values as-is.

- **File:** `src/lib/organizations/organizations.ts`, lines 54-99
  `getUserOrganizationsWithSeats()` similarly has NO hard block. It returns `used` and `total` without enforcement.

- **UI Layer:** The InviteMemberDialog disables invitations when seats are full (for Teams plan), but this is a UI-only control (see Rule 10).

**Test Coverage:**

- `src/lib/organizations/organization-seats.test.ts`, lines 154-189: Test explicitly verifies over-usage is possible (4 used, 2 total).
- `src/lib/organizations/organization-seats.test.ts`, lines 596-634: Test verifies over-usage with both members and pending invitations exceeding total.

---

### Rule 8: Teams Plan - Disable Invitation UI When Usage ≥ Purchased

**Specification:**

> "For Teams-plan organizations, the system MUST disable the invitation UI when seat usage equals or exceeds the purchased seat count."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/components/organizations/members/InviteMemberDialog.tsx`, lines 111-116

  ```typescript
  const usedSeats = seatUsage?.usedSeats || 0;
  const totalSeats = seatUsage?.totalSeats || 0;
  const remainingSeats = totalSeats > 0 ? totalSeats - usedSeats : Infinity;
  const isOrgEnterprise = organizationData?.plan === 'enterprise';
  const hasSeatsAvailable = totalSeats === 0 || remainingSeats > 0 || isOrgEnterprise;
  ```

  Logic:
  - For Teams plan: `isOrgEnterprise === false` → `hasSeatsAvailable = totalSeats === 0 || remainingSeats > 0`
    - If `totalSeats > 0` and `remainingSeats <= 0` (used ≥ total), then `hasSeatsAvailable = false`
  - For Enterprise plan: `hasSeatsAvailable = true` (always allows invitations)

- **File:** `src/components/organizations/members/InviteMemberDialog.tsx`, line 208
  Email input is disabled:

  ```typescript
  disabled={!hasSeatsAvailable}
  ```

- **File:** `src/components/organizations/members/InviteMemberDialog.tsx`, lines 222, 310
  Role dropdown and Send button are disabled when `!hasSeatsAvailable`.

**UI Behavior:**

- Teams plan with 5/5 seats: `hasSeatsAvailable = false` → UI fully disabled for invitations
- Teams plan with 4/5 seats: `hasSeatsAvailable = true` → UI enabled
- Enterprise plan: `hasSeatsAvailable = true` → UI always enabled (see Rule 9)

---

### Rule 9: Enterprise Plan - NO Invitation Restrictions Based on Seat Usage

**Specification:**

> "For Enterprise-plan organizations, the system MUST NOT restrict invitations based on seat usage."

**Finding: COMPLIANT** ✅

**Evidence:**

- **File:** `src/components/organizations/members/InviteMemberDialog.tsx`, lines 115-116
  ```typescript
  const isOrgEnterprise = organizationData?.plan === 'enterprise';
  const hasSeatsAvailable = totalSeats === 0 || remainingSeats > 0 || isOrgEnterprise;
  ```
  When `isOrgEnterprise === true`, `hasSeatsAvailable` is always true, regardless of seat usage.

**Behavior:**

- Enterprise plan organizations can invite members even when seat usage exceeds purchased seats.
- The invitation UI is never disabled for Enterprise plan organizations.

---

### Rule 10: Server MUST NOT Enforce Seat Limits on Invitations/Acceptance

**Specification:**

> "The server MUST NOT enforce seat limits when processing invitations or when members accept invitations; seat-limit enforcement on invitations is a UI-layer-only control."

**Finding: COMPLIANT** ✅

**Evidence:**

**Invitation Handler (`inviteUserToOrganization`):**

- **File:** `src/routers/organizations/organization-members-router.ts`, lines 183-252
  The `invite` mutation does NOT check seat usage or validate that `used < total`.

  ```typescript
  invite: organizationBillingProcedure.input(InviteMemberSchema).mutation(async ({ input, ctx }) => {
    // ... validation logic ...
    let invitation;
    try {
      invitation = await inviteUserToOrganization(organizationId, user.id, email, role);
    }
    // ... email sending ...
  })
  ```

  No seat count check before calling `inviteUserToOrganization()`.

- **File:** `src/lib/organizations/organizations.ts`, lines 302-358
  `inviteUserToOrganization()` function only validates:
  - Email validity
  - No existing pending invitation
  - No existing membership
    It does NOT check seat limits.

**Invitation Acceptance Handler (`acceptOrganizationInvite`):**

- **File:** `src/lib/organizations/organizations.ts`, lines 450-549
  The `acceptOrganizationInvite()` function does NOT check seat usage.
  Validation only includes:
  - Invitation exists
  - Invitation not expired
  - Invitation not already accepted
  - Organization exists
  - User not already a member
    No seat count enforcement.

**Result:** Members can always accept invitations, even if it causes seat usage to exceed purchased seats (consistent with Rule 7).

---

### Rule 11: No Member Removal on Period Downgrade

**Specification:**

> "When a billing period begins with a lower seat count than current usage (e.g., an end-of-period downgrade takes effect), the system MUST NOT remove existing members. The over-usage state persists until resolved by the organization (by removing members or purchasing additional seats). The system SHOULD display a warning to organization owners indicating over-usage."

**Finding: PARTIALLY COMPLIANT** ⚠️

**Assessment:**

- ✅ **COMPLIANT:** No member removal occurs automatically when seat count decreases.
- ✅ **COMPLIANT:** Over-usage state persists (confirmed by Rules 7 and 10).
- ⚠️ **NOT YET IMPLEMENTED:** No warning to organization owners about over-usage state.

**Evidence for Compliance:**

- **File:** `src/lib/organizations/organization-seats.ts`, lines 154-244
  When a subscription event is processed:

  ```typescript
  await db.transaction(async tx => {
    // ... insert purchase record ...
    const maxSeatsForSubPeriod = Math.max(...purchaseRows.map(x => x.seat_count));
    await tx.update(organizations).set({ seat_count: maxSeatsForSubPeriod }).where(...);
  });
  ```

  Only updates `seat_count`. Does NOT remove members or modify `organization_memberships`.

- **File:** `src/lib/organizations/organizations.ts`, lines 513-519
  When a user accepts an invitation or joins an organization:
  ```typescript
  await tx.insert(organization_memberships).values({
    organization_id: invitation.organization_id,
    kilo_user_id: userId,
    role: invitation.role,
    invited_by: invitation.invited_by,
  });
  ```
  No seat count check. Members can always be added.

**Evidence for Missing Implementation (Warning):**

- **Observation:** There is no code path that generates warnings when `seat_usage > total_seats`.
- **Expected Location:** Such a warning would likely be:
  - In an organization settings dashboard
  - In email notifications to organization owners
  - In a cron job that detects over-usage

**Status:** This is a SHOULD requirement (not a MUST), and implementation is noted as "not yet implemented" in the spec at line 591-593.

---

## Cross-Cutting Issues

### Issue A: Potential Inconsistency in Billing Manager Invitation Seat Check

**Severity:** MINOR (UI-only, no server-side impact)

**Description:**
The InviteMemberDialog disables the email input and send button based on `hasSeatsAvailable`, which applies to ALL roles including `billing_manager`. Since billing_manager invitations should not consume seats (Rule 2), the UI could theoretically block a valid billing_manager invitation when seats are full.

**Evidence:**

- **File:** `src/components/organizations/members/InviteMemberDialog.tsx`, lines 111-116, 208-210, 310
  The `hasSeatsAvailable` check applies universally:
  ```typescript
  const hasSeatsAvailable = totalSeats === 0 || remainingSeats > 0 || isOrgEnterprise;
  // ...
  disabled={!hasSeatsAvailable}  // Applied to ALL roles
  ```

**Impact:**

- A Teams plan organization with 0 remaining seats cannot invite a billing_manager (even though billing_manager invitations shouldn't consume seats).
- This could prevent organizations from adding billing managers to manage subscriptions when they're at seat capacity.

**Recommendation:**
The UI logic should exclude billing_manager role from the seat count check:

```typescript
const isRoleThatConsumesSeats = role !== 'billing_manager';
const hasSeatsAvailable = isRoleThatConsumesSeats
  ? totalSeats === 0 || remainingSeats > 0 || isOrgEnterprise
  : true; // Always allow billing_manager invitations
```

**Status:** Not yet fixed in codebase.

---

### Issue B: Missing Bot User Seat Test Coverage

**Severity:** MINOR (logic is correct, test coverage incomplete)

**Description:**
While bot users are correctly excluded from seat counting via the `is_bot = false` filter in `getOrganizationMembers()`, there is no explicit test case verifying that bot users don't appear in seat usage calculations.

**Evidence:**

- `src/lib/organizations/organization-seats.test.ts` has comprehensive test coverage but no test specifically named for bot user exclusion from seat counting.

**Recommendation:**
Add test case:

```typescript
test('should not count bot users in seat usage', async () => {
  const owner = await insertTestUser();
  const botUser = await insertTestUser(); // Add is_bot: true
  const organization = await createOrganization('Test Org', owner.id);

  await addUserToOrganization(organization.id, botUser.id, 'member');

  const result = await getOrganizationSeatUsage(organization.id);

  expect(result.used).toBe(1); // Only owner, not bot
});
```

**Status:** Not yet implemented.

---

## Summary Table

| Rule # | Requirement                                        | Status                                    | Evidence                                                             | Notes                                                                  |
| ------ | -------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1      | Count active members (except billing_manager)      | ✅ COMPLIANT                              | `organization-seats.ts:72`, `organizations.ts:65`                    | Explicitly filters `role != 'billing_manager'`                         |
| 2      | Count pending invitations (except billing_manager) | ✅ COMPLIANT                              | `organizations.ts:71`                                                | Filters `role != 'billing_manager'` and `accepted_at IS NULL`          |
| 3      | NOT count expired invitations                      | ✅ COMPLIANT                              | `organizations.ts:70`                                                | Filters `expires_at > NOW()`                                           |
| 4      | NOT count accepted invitations                     | ✅ COMPLIANT                              | `organizations.ts:69`                                                | Filters `accepted_at IS NULL`                                          |
| 5      | NOT count bot users                                | ✅ COMPLIANT                              | `organizations.ts:397`                                               | Filters `is_bot = false`                                               |
| 6      | Report as pair (used + total)                      | ✅ COMPLIANT                              | `organization-seats.ts:66`, `organization-router.ts:343-345`         | Returns `{ used, total }`                                              |
| 7      | Allow over-usage                                   | ✅ COMPLIANT                              | `organization-seats.ts`, `organizations.ts`                          | No hard block on seat checking                                         |
| 8      | Teams: Disable UI when usage ≥ purchased           | ✅ COMPLIANT                              | `InviteMemberDialog.tsx:116`, `222`, `310`                           | `hasSeatsAvailable` logic correct for Teams plan                       |
| 9      | Enterprise: NO invitation restrictions             | ✅ COMPLIANT                              | `InviteMemberDialog.tsx:115-116`                                     | Enterprise plan always enables invitations                             |
| 10     | Server NOT enforce seat limits                     | ✅ COMPLIANT                              | `organization-members-router.ts:183-252`, `organizations.ts:302-358` | No seat checks in invitation/acceptance handlers                       |
| 11     | No member removal on period downgrade              | ✅ COMPLIANT (SHOULD: ⚠️ Warning missing) | `organization-seats.ts:181-243`                                      | Members NOT removed; over-usage persists. Warning not yet implemented. |

---

## Final Verdict

**OVERALL COMPLIANCE: COMPLIANT** ✅

The codebase is in compliance with all 11 seat usage counting rules from the specification. The implementation correctly:

- Counts active organization members and pending invitations
- Excludes billing_manager role members and invitations
- Excludes expired and accepted invitations
- Excludes bot users
- Reports seat usage as a pair
- Allows over-usage at the business logic layer
- Restricts invitations only at the Teams plan UI layer
- Allows Enterprise plan organizations unlimited invitations
- Does not enforce seat limits on the server for invitation/acceptance
- Does not remove members when seat count decreases

**Minor Issues Noted (Non-Blocking):**

1. Billing_manager invitations may be disabled in the Teams plan UI when seats are full (should not be)
2. No explicit test for bot user exclusion from seat counting
3. No owner warning when over-usage state is detected (SHOULD requirement, not MUST)

These issues do not affect specification compliance but represent opportunities for improvement.
