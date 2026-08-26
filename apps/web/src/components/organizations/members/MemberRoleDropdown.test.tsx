/** @jest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';

import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import type { OrganizationMemberResponse } from '@/lib/organizations/organization-types';
import { MemberRoleDropdown } from './MemberRoleDropdown';

/**
 * This dropdown is rendered both on the plain single-org Members page and
 * inside the member-management drawer (`OrganizationAdminMembers`, via the
 * `manage-members` drawer entry) — see `DrawerStack.tsx`'s z-index vs. this
 * primitive's default `z-50`. jsdom can't verify visual stacking order, so
 * the z-index-override coverage below only checks that the override class
 * is present on the rendered element, guarding against a future refactor
 * that silently drops it and reintroduces the invisible-dropdown bug.
 */

const updateMemberRoleMutate = jest.fn();

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({
    data: {
      members: [{ email: 'viewer@example.com', status: 'active', role: 'owner' }],
    },
  }),
  useUpdateMemberRole: () => ({ mutate: updateMemberRoleMutate, isPending: false }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

function buildMember(
  overrides: Partial<OrganizationMemberResponse> = {}
): OrganizationMemberResponse {
  return {
    id: 'member-1',
    name: 'Member One',
    email: 'member-one@example.com',
    role: 'member',
    status: 'active',
    inviteDate: null,
    dailyUsageLimitUsd: null,
    currentDailyUsageUsd: null,
    ...overrides,
  } as OrganizationMemberResponse;
}

function renderDropdown(member: OrganizationMemberResponse = buildMember()) {
  return render(
    <RoleTestingProvider>
      <OrganizationAdminContextProvider organizationId="org-1">
        <MemberRoleDropdown organizationId="org-1" member={member} />
      </OrganizationAdminContextProvider>
    </RoleTestingProvider>
  );
}

beforeEach(() => {
  updateMemberRoleMutate.mockReset();
});

/**
 * `fireEvent.click` alone doesn't open Radix's `DropdownMenu` in jsdom —
 * its trigger opens via a pointerdown-driven `Popper`/focus flow that
 * doesn't fire from a plain synthetic click. Focusing the trigger and then
 * pressing Enter (the standard WAI-ARIA menu-button open key) reliably
 * opens it here instead.
 */
function openDropdown(triggerName: RegExp) {
  const trigger = screen.getByRole('button', { name: triggerName });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

describe('MemberRoleDropdown', () => {
  it('renders the DropdownMenuContent with the drawer-stack z-index override', () => {
    renderDropdown();

    openDropdown(/Member/);
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('z-[70]');
  });

  it('updates the role when a new role is chosen', () => {
    renderDropdown();

    openDropdown(/Member/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Admin' }));

    expect(updateMemberRoleMutate).toHaveBeenCalledTimes(1);
    expect(updateMemberRoleMutate).toHaveBeenCalledWith(
      { organizationId: 'org-1', memberId: 'member-1', role: 'admin' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });
});
