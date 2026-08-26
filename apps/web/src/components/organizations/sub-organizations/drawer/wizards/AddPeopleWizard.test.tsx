/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import type { SubOrganizationPeopleData } from '../types';
import { AddPeopleWizard } from './AddPeopleWizard';

/**
 * Full-flow coverage for the add-people wizard: select -> target -> preview
 * -> results, wired together with the *real* `eligibility.ts` and
 * `rowExecutor.ts` (only the network-touching mutation hooks and identity
 * context are mocked). Each of those pieces already has its own unit tests;
 * this is the one place that proves they still agree once actually wired
 * together inside a wizard, which none of those per-piece tests can catch on
 * their own.
 *
 * This wizard adds existing directory people to child orgs via
 * `organizations.members.setChildMemberships` — never `organizations.
 * members.invite`, which unconditionally rejects invites into a child org
 * (see `organization-members-router.test.ts`'s "should reject inviting
 * members into a child organization"). Every scenario below asserts
 * `inviteMutateAsync` was never called, so a regression back to calling
 * `invite` here — the exact bug this wizard previously shipped with — fails
 * the test even if the mocked `setChildMemberships` call otherwise looks
 * right.
 */

const setChildMembershipsMutateAsync = jest.fn();
const inviteMutateAsync = jest.fn();

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({
    data: {
      members: [{ email: 'viewer@example.com', status: 'active', role: 'owner' }],
    },
  }),
  useInviteMember: () => ({ mutateAsync: inviteMutateAsync }),
  useSetChildMemberships: () => ({ mutateAsync: setChildMembershipsMutateAsync }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

type PersonOverrides = Partial<SubOrganizationPeopleData['people'][number]>;

function buildPerson(overrides: PersonOverrides = {}): SubOrganizationPeopleData['people'][number] {
  return {
    identityKey: 'person@example.com',
    kiloUserId: 'user-person',
    name: 'Person',
    email: 'person@example.com',
    parentMembership: { role: 'member', status: 'accepted', canManageMemberships: true },
    memberships: [],
    invitations: [],
    statuses: ['accepted'],
    ...overrides,
  };
}

function buildPeople(): SubOrganizationPeopleData['people'] {
  return [
    buildPerson({
      identityKey: 'alice@example.com',
      kiloUserId: 'user-alice',
      name: 'Alice Admin',
      email: 'alice@example.com',
    }),
    buildPerson({
      identityKey: 'bob@example.com',
      kiloUserId: 'user-bob',
      name: 'Bob Member',
      email: 'bob@example.com',
      memberships: [
        {
          organizationId: 'child-1',
          organizationName: 'Child One',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
    }),
  ];
}

function buildChildren(): SubOrganizationPeopleData['children'] {
  return [
    {
      id: 'child-1',
      name: 'Child One',
      memberCount: 1,
      pendingInvitationCount: 0,
      seatCount: { used: 1, total: 5 },
      roleBreakdown: { owner: 0, admin: 0, billing_manager: 0, member: 1 },
      owners: [],
    },
    {
      id: 'child-2',
      name: 'Child Two',
      memberCount: 0,
      pendingInvitationCount: 0,
      seatCount: { used: 0, total: 5 },
      roleBreakdown: { owner: 0, admin: 0, billing_manager: 0, member: 0 },
      owners: [],
    },
  ];
}

function renderWizard({
  onClose,
  people,
  seededIdentityKeys,
}: {
  onClose: () => void;
  people?: SubOrganizationPeopleData['people'];
  seededIdentityKeys?: string[];
}) {
  const resolvedPeople = people ?? buildPeople();
  return render(
    <RoleTestingProvider>
      <AddPeopleWizard
        parentOrganizationId="parent-1"
        people={resolvedPeople}
        children={buildChildren()}
        seededIdentityKeys={seededIdentityKeys ?? resolvedPeople.map(person => person.identityKey)}
        onClose={onClose}
      />
    </RoleTestingProvider>
  );
}

describe('AddPeopleWizard full-flow', () => {
  beforeEach(() => {
    setChildMembershipsMutateAsync.mockReset();
    setChildMembershipsMutateAsync.mockResolvedValue(undefined);
    inviteMutateAsync.mockReset();
  });

  it('walks select -> target -> preview -> results, calling setChildMemberships once per eligible person', async () => {
    const onClose = jest.fn();
    renderWizard({ onClose });

    // Step 1: both people arrive pre-selected via seededIdentityKeys.
    screen.getByText('Step 1 of 4: Select people');
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Step 2: pick both available targets — the multi-select checkbox list.
    screen.getByText('Step 2 of 4: Pick target sub-organizations');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Step 3: Bob is already a member of Child One, so his per-org row shows
    // "Already a member" there, but he's still addable overall (to Child
    // Two) — both people count toward the "Add 2 people" total.
    screen.getByText('Step 3 of 4: Preview and confirm');
    screen.getByText('Already a member');
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }));

    // Step 4: one `setChildMemberships` call per person — never `invite`.
    await waitFor(() => screen.getByText('Done: 2 succeeded, 0 failed, 0 skipped.'));
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledTimes(2);
    expect(setChildMembershipsMutateAsync).toHaveBeenNthCalledWith(1, {
      organizationId: 'parent-1',
      memberId: 'user-alice',
      childOrganizationIds: ['child-1', 'child-2'],
    });
    expect(setChildMembershipsMutateAsync).toHaveBeenNthCalledWith(2, {
      organizationId: 'parent-1',
      memberId: 'user-bob',
      // Bob's pre-existing Child One membership is included in the union
      // even though only Child Two was newly selected for him — omitting
      // it would have `setChildMemberships` reconcile it away.
      childOrganizationIds: ['child-1', 'child-2'],
    });
    expect(inviteMutateAsync).not.toHaveBeenCalled();

    screen.getByText('alice@example.com → Child One, Child Two');
    screen.getByText('bob@example.com → Child Two');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed setChildMemberships call and lets the user retry only that person', async () => {
    setChildMembershipsMutateAsync.mockRejectedValueOnce(new Error('seat limit reached'));
    renderWizard({ onClose: jest.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }));

    // Alice's call fails; Bob's still runs.
    await waitFor(() => screen.getByText('Done: 1 succeeded, 1 failed, 0 skipped.'));
    screen.getByText(/Failed: seat limit reached/);

    setChildMembershipsMutateAsync.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed (1)' }));

    await waitFor(() => screen.getByText('Done: 2 succeeded, 0 failed, 0 skipped.'));
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledTimes(3);
    expect(inviteMutateAsync).not.toHaveBeenCalled();
  });

  it('adds a person to only the target orgs they are not already in, across multiple selected orgs', async () => {
    renderWizard({ onClose: jest.fn(), seededIdentityKeys: ['bob@example.com'] });

    screen.getByText('Step 1 of 4: Select people');
    fireEvent.click(screen.getByRole('button', { name: 'Next (1 selected)' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }));

    await waitFor(() => screen.getByText('Done: 1 succeeded, 0 failed, 0 skipped.'));
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledTimes(1);
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledWith({
      organizationId: 'parent-1',
      memberId: 'user-bob',
      childOrganizationIds: ['child-1', 'child-2'],
    });
    expect(inviteMutateAsync).not.toHaveBeenCalled();
  });

  it('excludes a person with no accepted parent membership from being added to any target org', async () => {
    const people = [
      ...buildPeople(),
      buildPerson({
        identityKey: 'carol@example.com',
        kiloUserId: 'user-carol',
        name: 'Carol Outsider',
        email: 'carol@example.com',
        // Only a child-org member, never accepted into the parent org —
        // `setChildMemberships` requires an existing accepted parent
        // membership (`NOT_FOUND` otherwise), so this person can never be
        // added through this wizard no matter which target orgs are picked.
        parentMembership: null,
        memberships: [
          {
            organizationId: 'child-2',
            organizationName: 'Child Two',
            role: 'member',
            status: 'accepted',
            canManageMemberships: true,
          },
        ],
      }),
    ];
    renderWizard({ onClose: jest.fn(), people });

    fireEvent.click(screen.getByRole('button', { name: 'Next (3 selected)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Carol is flagged as excluded, distinct from the per-org "Already a
    // member" labels Alice/Bob may show.
    screen.getByText('Must be a member of the parent organization first');
    // Only Alice and Bob count toward the addable total.
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 people' }));

    await waitFor(() => screen.getByText('Done: 2 succeeded, 0 failed, 1 skipped.'));
    screen.getByText('Skipped: Must be a member of the parent organization first');
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledTimes(2);
    expect(setChildMembershipsMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'user-carol' })
    );
    expect(inviteMutateAsync).not.toHaveBeenCalled();
  });

  it('skips a person who is already a member of every selected target org, without calling setChildMemberships for them', async () => {
    const people = [
      buildPerson({
        identityKey: 'dana@example.com',
        kiloUserId: 'user-dana',
        name: 'Dana Everywhere',
        email: 'dana@example.com',
        memberships: [
          {
            organizationId: 'child-1',
            organizationName: 'Child One',
            role: 'member',
            status: 'accepted',
            canManageMemberships: true,
          },
          {
            organizationId: 'child-2',
            organizationName: 'Child Two',
            role: 'member',
            status: 'accepted',
            canManageMemberships: true,
          },
        ],
      }),
      buildPeople()[0],
    ];
    renderWizard({ onClose: jest.fn(), people });

    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }));

    await waitFor(() => screen.getByText('Done: 1 succeeded, 0 failed, 1 skipped.'));
    screen.getByText('Skipped: Already a member of every selected sub-organization');
    expect(setChildMembershipsMutateAsync).toHaveBeenCalledTimes(1);
    expect(setChildMembershipsMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'user-dana' })
    );
    expect(inviteMutateAsync).not.toHaveBeenCalled();
  });
});
