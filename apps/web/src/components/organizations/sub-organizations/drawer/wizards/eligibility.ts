import type { SubOrganizationPeopleData } from '../types';

export type Person = SubOrganizationPeopleData['people'][number];

export type AddEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'already-member' | 'already-invited' };

/**
 * Whether `person` may be invited into `targetOrganizationId`. A person who
 * already has a membership or a pending invitation there is never silently
 * overwritten — the add wizard shows them as a disabled, labeled row
 * instead of re-issuing (and possibly duplicating) an invite.
 */
export function computeAddEligibility(
  person: Person,
  targetOrganizationId: string
): AddEligibility {
  if (person.memberships.some(membership => membership.organizationId === targetOrganizationId)) {
    return { eligible: false, reason: 'already-member' };
  }
  if (person.invitations.some(invitation => invitation.organizationId === targetOrganizationId)) {
    return { eligible: false, reason: 'already-invited' };
  }
  return { eligible: true };
}

/**
 * Human-readable reason `person` can't be added, or `null` if they're
 * eligible. Shared by the add wizard's preview step (disabled row label)
 * and results step (`skip` reason) so those two can't drift into showing
 * different text for the same ineligible row.
 */
export function addEligibilityLabel(person: Person, targetOrganizationId: string): string | null {
  const eligibility = computeAddEligibility(person, targetOrganizationId);
  if (eligibility.eligible) return null;
  return eligibility.reason === 'already-member' ? 'Already a member' : 'Already invited';
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
