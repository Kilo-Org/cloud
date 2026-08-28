import {
  addEligibilityLabel,
  computeAddEligibility,
  desiredChildOrganizationIds,
  eligibleAddTargetOrganizationIds,
  personCanBeAddedToChildOrganizations,
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
    // Accepted parent membership by default, since that's the common case
    // this file's other tests exercise; the `not-parent-member` describe
    // block below overrides this to `null`/no `kiloUserId` explicitly.
    parentMembership: { role: 'member', status: 'accepted', canManageMemberships: true },
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

  it('is ineligible with reason "not-parent-member" when the person has no accepted parent membership', () => {
    const person = buildPerson({ parentMembership: null });
    expect(computeAddEligibility(person, 'target-org')).toEqual({
      eligible: false,
      reason: 'not-parent-member',
    });
  });

  it('is ineligible with reason "not-parent-member" when the person has no kiloUserId', () => {
    const person = buildPerson({ kiloUserId: null });
    expect(computeAddEligibility(person, 'target-org')).toEqual({
      eligible: false,
      reason: 'not-parent-member',
    });
  });

  it('reports "not-parent-member" ahead of an "already-member" per-org state — it is a whole-person disqualifier', () => {
    const person = buildPerson({
      parentMembership: null,
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
      reason: 'not-parent-member',
    });
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

  it('evaluates independently per (person, target org) pair when a person is a member of one selected org but not another — the multi-target add wizard scenario', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'org-a',
          organizationName: 'Org A',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    // Ineligible for the org they're already a member of...
    expect(computeAddEligibility(person, 'org-a')).toEqual({
      eligible: false,
      reason: 'already-member',
    });
    // ...but still eligible for a second selected org, from the exact same
    // person object — nothing about eligibility is global to the person.
    expect(computeAddEligibility(person, 'org-b')).toEqual({ eligible: true });
  });
});

describe('addEligibilityLabel', () => {
  it('labels a "not-parent-member" person distinctly from a per-org "already-member" one', () => {
    const person = buildPerson({ parentMembership: null });
    expect(addEligibilityLabel(person, 'target-org')).toBe(
      'Must be a member of the parent organization first'
    );
  });

  it('returns null for an eligible person', () => {
    expect(addEligibilityLabel(buildPerson(), 'target-org')).toBeNull();
  });
});

describe('personCanBeAddedToChildOrganizations', () => {
  it('is true for an accepted parent member with a kiloUserId', () => {
    expect(personCanBeAddedToChildOrganizations(buildPerson())).toBe(true);
  });

  it('is false without an accepted parentMembership', () => {
    expect(personCanBeAddedToChildOrganizations(buildPerson({ parentMembership: null }))).toBe(
      false
    );
  });

  it('is false without a kiloUserId', () => {
    expect(personCanBeAddedToChildOrganizations(buildPerson({ kiloUserId: null }))).toBe(false);
  });
});

describe('eligibleAddTargetOrganizationIds', () => {
  it('returns none of the target orgs for a person who fails the parent-member precondition', () => {
    const person = buildPerson({ parentMembership: null });
    expect(eligibleAddTargetOrganizationIds(person, ['org-a', 'org-b'])).toEqual([]);
  });

  it('filters out target orgs the person is already a member of or invited to', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'org-a',
          organizationName: 'Org A',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
      invitations: [
        {
          inviteId: 'invite-1',
          organizationId: 'org-b',
          organizationName: 'Org B',
          isParent: false,
          role: 'member',
          status: 'pending',
          canManageMemberships: true,
        },
      ],
    });
    expect(eligibleAddTargetOrganizationIds(person, ['org-a', 'org-b', 'org-c'])).toEqual([
      'org-c',
    ]);
  });

  it('returns an empty array when the person is already in every selected target org', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'org-a',
          organizationName: 'Org A',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(eligibleAddTargetOrganizationIds(person, ['org-a'])).toEqual([]);
  });
});

describe('desiredChildOrganizationIds', () => {
  it('unions pre-existing child memberships with the newly selected target orgs', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'org-a',
          organizationName: 'Org A',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    // `setChildMemberships` is a "set" operation, not additive — omitting
    // `org-a` here would have it reconciled away even though it wasn't
    // part of this add run.
    expect(desiredChildOrganizationIds(person, ['org-b'])).toEqual(['org-a', 'org-b']);
  });

  it('does not duplicate an org that is both a pre-existing membership and a newly selected target', () => {
    const person = buildPerson({
      memberships: [
        {
          organizationId: 'org-a',
          organizationName: 'Org A',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    });
    expect(desiredChildOrganizationIds(person, ['org-a'])).toEqual(['org-a']);
  });

  it('returns only the newly selected orgs when the person has no pre-existing child memberships', () => {
    expect(desiredChildOrganizationIds(buildPerson(), ['org-a', 'org-b'])).toEqual([
      'org-a',
      'org-b',
    ]);
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
