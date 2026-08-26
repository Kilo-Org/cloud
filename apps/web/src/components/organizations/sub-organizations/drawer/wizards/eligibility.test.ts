import {
  computeAddEligibility,
  personHasPresenceInOrganization,
  resolveRemoveTarget,
  type Person,
} from './eligibility';

function buildPerson(overrides: Partial<Person> = {}): Person {
  return {
    identityKey: 'person@example.com',
    kiloUserId: 'user-1',
    name: 'Person One',
    email: 'person@example.com',
    parentMembership: null,
    memberships: [],
    invitations: [],
    statuses: ['accepted'],
    ...overrides,
  };
}

describe('computeAddEligibility', () => {
  it('is eligible when the person has no presence in the target organization', () => {
    const person = buildPerson();
    expect(computeAddEligibility(person, 'target-org')).toEqual({ eligible: true });
  });

  it('is ineligible with reason "already-member" when already a member of the target', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'target-org',
          organizationName: 'Target',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(computeAddEligibility(person, 'target-org')).toEqual({
      eligible: false,
      reason: 'already-member',
    });
  });

  it('is ineligible with reason "already-invited" when already invited to the target', () => {
    const person = buildPerson({
      invitations: [
        {
          inviteId: 'invite-1',
          organizationId: 'target-org',
          organizationName: 'Target',
          isParent: false,
          role: 'member',
          status: 'pending',
          canManageMemberships: true,
        },
      ],
    });
    expect(computeAddEligibility(person, 'target-org')).toEqual({
      eligible: false,
      reason: 'already-invited',
    });
  });

  it('does not treat presence in a different organization as ineligible', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'other-org',
          organizationName: 'Other',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(computeAddEligibility(person, 'target-org')).toEqual({ eligible: true });
  });
});

describe('personHasPresenceInOrganization', () => {
  it('is true for an accepted membership in the target organization', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'target-org',
          organizationName: 'Target',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(personHasPresenceInOrganization(person, 'target-org')).toBe(true);
  });

  it('is true for a pending invitation in the target organization', () => {
    const person = buildPerson({
      invitations: [
        {
          inviteId: 'invite-1',
          organizationId: 'target-org',
          organizationName: 'Target',
          isParent: false,
          role: 'member',
          status: 'pending',
          canManageMemberships: true,
        },
      ],
    });
    expect(personHasPresenceInOrganization(person, 'target-org')).toBe(true);
  });

  it('is false when the person has no membership or invitation in the target organization', () => {
    const person = buildPerson();
    expect(personHasPresenceInOrganization(person, 'target-org')).toBe(false);
  });
});

describe('resolveRemoveTarget', () => {
  it('resolves to a membership target when the person has an accepted membership', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'target-org',
          organizationName: 'Target',
          role: 'admin',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(resolveRemoveTarget(person, 'target-org')).toEqual({
      kind: 'membership',
      role: 'admin',
    });
  });

  it('resolves to an invitation target (with inviteId) when the person only has a pending invitation', () => {
    const person = buildPerson({
      invitations: [
        {
          inviteId: 'invite-42',
          organizationId: 'target-org',
          organizationName: 'Target',
          isParent: false,
          role: 'billing_manager',
          status: 'pending',
          canManageMemberships: true,
        },
      ],
    });
    expect(resolveRemoveTarget(person, 'target-org')).toEqual({
      kind: 'invitation',
      role: 'billing_manager',
      inviteId: 'invite-42',
    });
  });

  it('resolves to null when the person has neither', () => {
    const person = buildPerson();
    expect(resolveRemoveTarget(person, 'target-org')).toBeNull();
  });

  it('prefers the membership over an invitation if somehow both are present', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'target-org',
          organizationName: 'Target',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
      invitations: [
        {
          inviteId: 'invite-1',
          organizationId: 'target-org',
          organizationName: 'Target',
          isParent: false,
          role: 'member',
          status: 'pending',
          canManageMemberships: true,
        },
      ],
    });
    expect(resolveRemoveTarget(person, 'target-org')).toEqual({
      kind: 'membership',
      role: 'member',
    });
  });
});
