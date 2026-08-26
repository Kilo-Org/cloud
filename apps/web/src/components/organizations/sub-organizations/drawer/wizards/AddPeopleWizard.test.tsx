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

  it('walks select -> target -> preview -> results, inviting only the eligible (person, org) pairs', async () => {
    const onClose = jest.fn();
    renderWizard(onClose);

    // Step 1: both people arrive pre-selected via seededIdentityKeys.
    screen.getByText('Step 1 of 4: Select people');
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Step 2: pick both available targets — the multi-select checkbox list.
    screen.getByText('Step 2 of 4: Pick target sub-organizations');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Step 3: Bob is already a member of Child One only, so of the four
    // (person, org) pairs, only his Child One pair is ineligible — this is
    // `computeAddEligibility` driving both the disabled count and the
    // per-pair "Already a member" label, now evaluated per selected org.
    screen.getByText('Step 3 of 4: Preview and choose a role');
    screen.getByText('Already a member');
    fireEvent.click(screen.getByRole('button', { name: 'Invite 3 invitations' }));

    // Step 4: the real `rowExecutor` runs the three eligible pairs through
    // the mutation, sequentially, and marks Bob's Child One pair skipped
    // without ever calling it for that pair.
    await waitFor(() => screen.getByText('Done: 3 succeeded, 0 failed, 1 skipped.'));
    expect(inviteMutateAsync).toHaveBeenCalledTimes(3);
    expect(inviteMutateAsync).toHaveBeenNthCalledWith(1, {
      organizationId: 'child-1',
      email: 'alice@example.com',
      role: 'member',
    });
    expect(inviteMutateAsync).toHaveBeenNthCalledWith(2, {
      organizationId: 'child-2',
      email: 'alice@example.com',
      role: 'member',
    });
    expect(inviteMutateAsync).toHaveBeenNthCalledWith(3, {
      organizationId: 'child-2',
      email: 'bob@example.com',
      role: 'member',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed invite and lets the user retry only that pair', async () => {
    inviteMutateAsync.mockRejectedValueOnce(new Error('seat limit reached'));
    renderWizard(jest.fn());

    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Invite 3 invitations' }));

    // The first eligible pair (Alice -> Child One) fails; the rest still run.
    await waitFor(() => screen.getByText('Done: 2 succeeded, 1 failed, 1 skipped.'));
    screen.getByText(/Failed: seat limit reached/);

    inviteMutateAsync.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed (1)' }));

    await waitFor(() => screen.getByText('Done: 3 succeeded, 0 failed, 1 skipped.'));
    expect(inviteMutateAsync).toHaveBeenCalledTimes(4);
  });

  it('adds a person to only the target orgs they are not already in, across multiple selected orgs', async () => {
    renderWizard(jest.fn());

    // Select only Bob, who is already a member of Child One.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alice Admin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (1 selected)' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child One' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Child Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next (2 selected)' }));

    // Only Bob -> Child Two is eligible; Bob -> Child One is already a member.
    fireEvent.click(screen.getByRole('button', { name: 'Invite 1 invitation' }));

    await waitFor(() => screen.getByText('Done: 1 succeeded, 0 failed, 1 skipped.'));
    expect(inviteMutateAsync).toHaveBeenCalledTimes(1);
    expect(inviteMutateAsync).toHaveBeenCalledWith({
      organizationId: 'child-2',
      email: 'bob@example.com',
      role: 'member',
    });
  });
});
