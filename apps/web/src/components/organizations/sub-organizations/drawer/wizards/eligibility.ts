import type { SubOrganizationPeopleData } from '../types';

export type Person = SubOrganizationPeopleData['people'][number];

export type AddEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'not-parent-member' | 'already-member' | 'already-invited' };

/**
 * Whether `person` may be added into `targetOrganizationId`. Adding an
 * existing directory person to a child org goes through `setChildMemberships`
 * (see `desiredChildOrganizationIds`), which requires the target to already
 * be an accepted PARENT org member — a person with no `kiloUserId` (never
 * signed up) or no accepted `parentMembership` fails that precondition for
 * every target org, not just some, so it's checked before any per-org state.
 * A person who passes that but already has a membership or a pending
 * invitation in `targetOrganizationId` is never silently overwritten — the
 * add wizard shows them as a disabled, labeled row instead of re-adding (and
 * possibly duplicating) them.
 */
export function computeAddEligibility(
  person: Person,
  targetOrganizationId: string
): AddEligibility {
  if (person.kiloUserId == null || person.parentMembership == null) {
    return { eligible: false, reason: 'not-parent-member' };
  }
  if (person.memberships.some(membership => membership.organizationId === targetOrganizationId)) {
    return { eligible: false, reason: 'already-member' };
  }
  if (person.invitations.some(invitation => invitation.organizationId === targetOrganizationId)) {
    return { eligible: false, reason: 'already-invited' };
  }
  return { eligible: true };
}

const ADD_ELIGIBILITY_LABELS: Record<
  Exclude<AddEligibility, { eligible: true }>['reason'],
  string
> = {
  'not-parent-member': 'Must be a member of the parent organization first',
  'already-member': 'Already a member',
  'already-invited': 'Already invited',
};

/**
 * Human-readable reason `person` can't be added, or `null` if they're
 * eligible. Shared by the add wizard's preview step (disabled row label)
 * and results step (`skip` reason) so those two can't drift into showing
 * different text for the same ineligible row.
 */
export function addEligibilityLabel(person: Person, targetOrganizationId: string): string | null {
  const eligibility = computeAddEligibility(person, targetOrganizationId);
  return eligibility.eligible ? null : ADD_ELIGIBILITY_LABELS[eligibility.reason];
}

/**
 * Whether `person` passes the `setChildMemberships` precondition at all —
 * a whole-person check, independent of which target orgs are selected. A
 * person who fails this can't be added to ANY child org through this
 * action, since no other mutation exists to add them another way.
 */
export function personCanBeAddedToChildOrganizations(person: Person): boolean {
  return person.kiloUserId != null && person.parentMembership != null;
}

/**
 * Of `targetOrganizationIds`, the ones `person` can actually be added to —
 * i.e. `computeAddEligibility` returns eligible. Drives both the add
 * wizard's per-person "will be added to" count and the row it executes.
 */
export function eligibleAddTargetOrganizationIds(
  person: Person,
  targetOrganizationIds: string[]
): string[] {
  return targetOrganizationIds.filter(
    organizationId => computeAddEligibility(person, organizationId).eligible
  );
}

/**
 * The full child-org membership set `person` should have after this add
 * run. `organizations.members.setChildMemberships` is a diff/"set"
 * operation per person, not additive — it reconciles away any existing
 * `member`-role child membership omitted from `childOrganizationIds` — so
 * every call must include `person`'s pre-existing child memberships (which
 * this router's own query already excludes the parent org row from)
 * alongside the newly eligible target orgs, or those existing memberships
 * would be silently removed.
 */
export function desiredChildOrganizationIds(
  person: Person,
  newTargetOrganizationIds: string[]
): string[] {
  const ids = new Set(person.memberships.map(membership => membership.organizationId));
  for (const organizationId of newTargetOrganizationIds) {
    ids.add(organizationId);
  }
  return Array.from(ids);
}

/**
 * Whether `person` has any presence (accepted membership or pending
 * invitation) in `targetOrganizationId`. The remove wizard's select-people
 * step is filtered to this, since there is nothing to remove otherwise.
 */
export function personHasPresenceInOrganization(
  person: Person,
  targetOrganizationId: string
): boolean {
  return (
    person.memberships.some(membership => membership.organizationId === targetOrganizationId) ||
    person.invitations.some(invitation => invitation.organizationId === targetOrganizationId)
  );
}

export type RemoveTarget =
  | { kind: 'membership'; role: Person['memberships'][number]['role'] }
  | { kind: 'invitation'; role: Person['invitations'][number]['role']; inviteId: string };

/**
 * Which of `person`'s two possible presences in `targetOrganizationId` the
 * remove wizard should act on, and which mutation that implies — `remove`
 * for an accepted membership, `deleteInvite` for a pending invitation. A
 * person can only be in one of these states per organization (membership
 * implies an accepted invite has already been consumed), so this never
 * needs to act on both.
 */
export function resolveRemoveTarget(
  person: Person,
  targetOrganizationId: string
): RemoveTarget | null {
  const membership = person.memberships.find(
    entry => entry.organizationId === targetOrganizationId
  );
  if (membership) {
    return { kind: 'membership', role: membership.role };
  }
  const invitation = person.invitations.find(
    entry => entry.organizationId === targetOrganizationId
  );
  if (invitation) {
    return { kind: 'invitation', role: invitation.role, inviteId: invitation.inviteId };
  }
  return null;
}
