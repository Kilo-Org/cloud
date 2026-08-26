/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import type { SubOrganizationPeopleData } from '../types';
import { AddPeopleWizard } from './AddPeopleWizard';

/**
 * Full-flow coverage for the add-people wizard: select -> target -> preview
 * -> results, wired together with the *real* `eligibility.ts` and
 * `rowExecutor.ts` (only the network-touching mutation hook and identity
 * context are mocked). Each of those pieces already has its own unit tests;
 * this is the one place that proves they still agree once actually wired
 * together inside a wizard, which none of those per-piece tests can catch on
 * their own.
 */

const inviteMutateAsync = jest.fn();

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({
    data: {
      members: [{ email: 'viewer@example.com', status: 'active', role: 'owner' }],
    },
  }),
  useInviteMember: () => ({ mutateAsync: inviteMutateAsync }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

function buildPeople(): SubOrganizationPeopleData['people'] {
  return [
    {
      identityKey: 'alice@example.com',
      kiloUserId: 'user-alice',
      name: 'Alice Admin',
      email: 'alice@example.com',
      parentMembership: null,
      memberships: [],
      invitations: [],
      statuses: ['accepted'],
    },
    {
      identityKey: 'bob@example.com',
      kiloUserId: 'user-bob',
      name: 'Bob Member',
      email: 'bob@example.com',
      parentMembership: null,
      memberships: [
        {
          organizationId: 'child-1',
          organizationName: 'Child One',
          role: 'member',
          status: 'accepted',
          canManageMemberships: true,
        },
      ],
      invitations: [],
      statuses: ['accepted'],
    },
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
  ];
}

function renderWizard(onClose: () => void) {
  return render(
    <RoleTestingProvider>
      <AddPeopleWizard
        parentOrganizationId="parent-1"
        people={buildPeople()}
        children={buildChildren()}
        seededIdentityKeys={['alice@example.com', 'bob@example.com']}
        onClose={onClose}
      />
    </RoleTestingProvider>
  );
}

describe('AddPeopleWizard full-flow', () => {
  beforeEach(() => {
    inviteMutateAsync.mockReset();
    inviteMutateAsync.mockResolvedValue(undefined);
  });

  it('walks select -> target -> preview -> results, inviting only the eligible person', async () => {
    const onClose = jest.fn();
    renderWizard(onClose);

    // Step 1: both people arrive pre-selected via seededIdentityKeys.
    screen.getByText('Step 1 of 4: Select people');
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Step 2: pick the only available target.
    screen.getByText('Step 2 of 4: Pick target sub-organization');
    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Step 3: Bob is already a member of the target, so only Alice is
    // eligible — this is `computeAddEligibility` driving both the disabled
    // count and the per-row "Already a member" label.
    screen.getByText('Step 3 of 4: Preview and choose a role');
    screen.getByText('Already a member');
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    // Step 4: the real `rowExecutor` runs Alice through the mutation and
    // marks Bob skipped without ever calling it for him.
    await waitFor(() => screen.getByText('Done: 1 succeeded, 0 failed, 1 skipped.'));
    expect(inviteMutateAsync).toHaveBeenCalledTimes(1);
    expect(inviteMutateAsync).toHaveBeenCalledWith({
      organizationId: 'child-1',
      email: 'alice@example.com',
      role: 'member',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed invite and lets the user retry only that row', async () => {
    inviteMutateAsync.mockRejectedValueOnce(new Error('seat limit reached'));
    renderWizard(jest.fn());

    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await waitFor(() => screen.getByText('Done: 0 succeeded, 1 failed, 1 skipped.'));
    screen.getByText(/Failed: seat limit reached/);

    inviteMutateAsync.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed (1)' }));

    await waitFor(() => screen.getByText('Done: 1 succeeded, 0 failed, 1 skipped.'));
    expect(inviteMutateAsync).toHaveBeenCalledTimes(2);
  });
});
