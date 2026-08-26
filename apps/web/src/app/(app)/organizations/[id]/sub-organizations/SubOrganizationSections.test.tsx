/** @jest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import type { inferRouterOutputs } from '@trpc/server';

import type { RootRouter } from '@/routers/root-router';
import { PeopleSection } from './SubOrganizationSections';

type People = inferRouterOutputs<RootRouter>['organizations']['subOrganizations']['people'];

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/organizations/parent-1/sub-organizations/people',
  useSearchParams: () => new URLSearchParams(),
}));

// The drawer stack's own behavior (context scoping, close invalidation) is
// covered by MemberManagementDrawerStack.test.tsx. Here we only need to
// assert PeopleSection wires each click through to `drawer.open(...)` with
// the right child org id/name, so a lightweight mock of the stack module —
// a passthrough provider plus a spyable `open` — is enough.
const openDrawerMock = jest.fn();
jest.mock(
  '@/components/organizations/sub-organizations/drawer/MemberManagementDrawerStack',
  () => ({
    MemberManagementDrawerStackProvider: ({ children }: { children: React.ReactNode }) => children,
    useMemberManagementDrawerStack: () => ({
      stack: [],
      push: jest.fn(),
      replace: jest.fn(),
      pop: jest.fn(),
      open: openDrawerMock,
      closeAll: jest.fn(),
    }),
  })
);

function buildData(): People {
  return {
    children: [
      {
        id: 'child-1',
        name: 'Child One',
        memberCount: 1,
        pendingInvitationCount: 0,
        seatCount: { used: 1, total: 5 },
        roleBreakdown: { owner: 1, admin: 0, billing_manager: 0, member: 0 },
        owners: [],
      },
      {
        id: 'child-2',
        name: 'Child Two',
        memberCount: 1,
        pendingInvitationCount: 1,
        seatCount: { used: 1, total: 5 },
        roleBreakdown: { owner: 1, admin: 0, billing_manager: 0, member: 0 },
        owners: [],
      },
    ],
    people: [
      {
        identityKey: 'identity-1',
        kiloUserId: 'user-1',
        name: 'Ann Admin',
        email: 'ann@example.com',
        parentMembership: null,
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
            canManageMemberships: false,
          },
        ],
        invitations: [],
        statuses: ['accepted'],
      },
    ],
    pageInfo: { page: 1, pageSize: 25, total: 1, pageCount: 1 },
  };
}

describe('PeopleSection membership badges', () => {
  beforeEach(() => {
    openDrawerMock.mockClear();
  });

  it('renders a manageable membership as a clickable trigger and a non-manageable one as a plain badge', () => {
    render(<PeopleSection organizationId="parent-1" data={buildData()} />);

    // getByRole throws if no matching element exists, so finding it is
    // itself the assertion that this membership renders as a real button.
    screen.getByRole('button', { name: 'Child One: member' });

    const plainBadge = screen.getByText('Child Two: member');
    expect(plainBadge.closest('button')).toBeNull();
  });

  it('opens the drawer scoped to the correct child org id when a clickable badge is clicked', () => {
    render(<PeopleSection organizationId="parent-1" data={buildData()} />);

    expect(openDrawerMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Child One: member' }));

    expect(openDrawerMock).toHaveBeenCalledWith({
      type: 'manage-members',
      childOrganizationId: 'child-1',
      childOrganizationName: 'Child One',
    });
  });

  it('does not open the drawer when a non-manageable badge is clicked', () => {
    render(<PeopleSection organizationId="parent-1" data={buildData()} />);

    fireEvent.click(screen.getByText('Child Two: member'));

    expect(openDrawerMock).not.toHaveBeenCalled();
  });
});

describe('PeopleSection bulk-action toolbar', () => {
  beforeEach(() => {
    openDrawerMock.mockClear();
  });

  it('disables the add/remove buttons when no rows are selected', () => {
    render(<PeopleSection organizationId="parent-1" data={buildData()} />);

    expect(
      (screen.getByRole('button', { name: 'Add to sub-organization…' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Remove from sub-organization…' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it('enables the add/remove buttons once a row is selected, and opens the right wizard entry', () => {
    render(<PeopleSection organizationId="parent-1" data={buildData()} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Ann Admin' }));

    const addButton = screen.getByRole('button', {
      name: 'Add to sub-organization…',
    }) as HTMLButtonElement;
    const removeButton = screen.getByRole('button', {
      name: 'Remove from sub-organization…',
    }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    expect(removeButton.disabled).toBe(false);

    fireEvent.click(addButton);
    expect(openDrawerMock).toHaveBeenCalledWith({
      type: 'add-people',
      seededIdentityKeys: ['identity-1'],
    });

    fireEvent.click(removeButton);
    expect(openDrawerMock).toHaveBeenCalledWith({
      type: 'remove-people',
      seededIdentityKeys: ['identity-1'],
    });
  });
});
