/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import type { SubOrganizationPeopleData } from '../types';
import { InvitePersonWizard, PARENT_ORGANIZATION_LABEL } from './InvitePersonWizard';

// jsdom doesn't implement `scrollIntoView`, which Radix's Select uses to
// keep the highlighted item visible when its options list opens.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = jest.fn();
}

/**
 * Full-flow coverage for the invite-a-new-person wizard: choose an
 * organization -> enter email/role -> submit, wired together with the
 * *real* per-org role context (`OrganizationAdminContextProvider`) so the
 * org-picker's enable/disable behavior is proven against the real
 * `getAvailableInviteRoles` business rule, not a stand-in. Only the
 * network-touching mutation hook, org-membership fetch, and identity
 * context are mocked, matching `AddPeopleWizard.test.tsx`'s convention for
 * this feature area.
 */

const inviteMutate = jest.fn();

// The viewer is an owner in the parent org, an admin in child-1, and a
// plain member in child-2 — a plain member can't invite anyone
// (`getAvailableInviteRoles`), so child-2 is the one candidate org this
// suite expects to render disabled.
const ROLE_BY_ORG: Record<string, string> = {
  'parent-1': 'owner',
  'child-1': 'admin',
  'child-2': 'member',
};

// Per-org override for `useOrganizationWithMembers`, so a test can simulate
// that org's membership fetch still being in flight (real react-query
// behavior: `data` is `undefined` until the fetch resolves) instead of
// always returning already-resolved data the way the default below does.
let orgFetchOverride: Record<string, { data: unknown; isLoading: boolean }> = {};

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: (organizationId: string) =>
    orgFetchOverride[organizationId] ?? {
      data: {
        members: [
          {
            email: 'viewer@example.com',
            status: 'active',
            role: ROLE_BY_ORG[organizationId] ?? 'member',
          },
        ],
      },
      isLoading: false,
    },
  useInviteMember: () => ({ mutate: inviteMutate, isPending: false }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

function buildChildren(): SubOrganizationPeopleData['children'] {
  return [
    {
      id: 'child-1',
      name: 'Child One',
      memberCount: 1,
      pendingInvitationCount: 0,
      seatCount: { used: 1, total: 5 },
      roleBreakdown: { owner: 0, admin: 1, billing_manager: 0, member: 0 },
      owners: [],
    },
    {
      id: 'child-2',
      name: 'Child Two',
      memberCount: 1,
      pendingInvitationCount: 0,
      seatCount: { used: 1, total: 5 },
      roleBreakdown: { owner: 0, admin: 0, billing_manager: 0, member: 1 },
      owners: [],
    },
  ];
}

function renderWizard(onClose: () => void = jest.fn()) {
  return render(
    <RoleTestingProvider>
      <InvitePersonWizard
        parentOrganizationId="parent-1"
        children={buildChildren()}
        onClose={onClose}
      />
    </RoleTestingProvider>
  );
}

describe('InvitePersonWizard org picker', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    orgFetchOverride = {};
  });

  it('enables organizations the viewer can invite into and disables the one they cannot', () => {
    renderWizard();

    const parentRadio = screen.getByRole('radio', {
      name: PARENT_ORGANIZATION_LABEL,
    }) as HTMLButtonElement;
    const childOneRadio = screen.getByRole('radio', { name: 'Child One' }) as HTMLButtonElement;
    const childTwoRadio = screen.getByRole('radio', { name: 'Child Two' }) as HTMLButtonElement;

    expect(parentRadio.disabled).toBe(false);
    expect(childOneRadio.disabled).toBe(false);
    expect(childTwoRadio.disabled).toBe(true);
    screen.getByText("You can't invite here");
  });

  it('does not let the viewer proceed past the target step for a disabled organization', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: 'Child Two' }));
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a loading state instead of a false "cannot invite" result while access is still resolving', () => {
    // Simulates every candidate org's `useOrganizationWithMembers` fetch
    // still being in flight (as it genuinely is for a brief window right
    // after the wizard mounts, for any org not already cached) rather than
    // the always-already-resolved data the other tests in this file use.
    orgFetchOverride = {
      'parent-1': { data: undefined, isLoading: true },
      'child-1': { data: undefined, isLoading: true },
      'child-2': { data: undefined, isLoading: true },
    };
    renderWizard();

    expect(screen.getAllByText('Checking access…')).toHaveLength(3);
    expect(screen.queryByText("You can't invite here")).toBeNull();
    for (const name of ['Child One', 'Child Two', PARENT_ORGANIZATION_LABEL]) {
      expect((screen.getByRole('radio', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('InvitePersonWizard role options', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    orgFetchOverride = {};
  });

  it("renders only the roles available for the selected organization's viewer role", async () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    screen.getByText('Step 2 of 2: Invite by email');
    fireEvent.click(screen.getByRole('combobox'));

    await screen.findByRole('listbox');
    screen.getByRole('option', { name: 'Admin' });
    screen.getByRole('option', { name: 'Member' });
    screen.getByRole('option', { name: 'Billing Manager' });
    // Child One's viewer is an admin, who cannot invite an owner.
    expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
  });
});

describe('InvitePersonWizard submit', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    orgFetchOverride = {};
  });

  it('invites into the chosen organization with the entered email and default role', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(inviteMutate).toHaveBeenCalledTimes(1);
    expect(inviteMutate).toHaveBeenCalledWith(
      { organizationId: 'child-1', email: 'new.person@example.com', role: 'member' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('can invite directly into the parent organization', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(inviteMutate).toHaveBeenCalledWith(
      { organizationId: 'parent-1', email: 'new.person@example.com', role: 'member' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('disables submit for an invalid email and does not call the mutation', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'not-an-email' } });

    expect(
      (screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(inviteMutate).not.toHaveBeenCalled();
  });

  it('closes the wizard on a successful invite, which drives the directory query invalidation on drawer close', async () => {
    const onClose = jest.fn();
    renderWizard(onClose);

    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const [, { onSuccess }] = inviteMutate.mock.calls[0];
    onSuccess();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
