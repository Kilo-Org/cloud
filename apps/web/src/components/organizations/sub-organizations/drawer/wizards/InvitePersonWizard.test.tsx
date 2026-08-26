/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoleTestingProvider } from '@/contexts/RoleTestingContext';
import { InvitePersonWizard } from './InvitePersonWizard';

// jsdom doesn't implement `scrollIntoView`, which Radix's Select uses to
// keep the highlighted item visible when its options list opens.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = jest.fn();
}

/**
 * Full-flow coverage for the invite-a-new-person wizard. There's no
 * organization picker: every invite targets `parentOrganizationId`
 * unconditionally, since `inviteUserToOrganization`
 * (`apps/web/src/lib/organizations/organizations.ts`) unconditionally
 * rejects any organization with a `parent_organization_id` set — a direct
 * child org can never be a valid invite target, for any viewer. Only the
 * network-touching mutation hook, org-membership fetch, and identity
 * context are mocked, matching `AddPeopleWizard.test.tsx`'s convention for
 * this feature area.
 */

const inviteMutate = jest.fn();

// The viewer's role in the parent org. Reset to this default before every
// test; individual tests override it to exercise different per-viewer
// outcomes.
let viewerRole = 'owner';

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({
    data: {
      members: [{ email: 'viewer@example.com', status: 'active', role: viewerRole }],
    },
  }),
  useInviteMember: () => ({ mutate: inviteMutate, isPending: false }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { email: 'viewer@example.com' }, isAdmin: false },
    status: 'authenticated',
  }),
}));

function renderWizard({ onClose = jest.fn() }: { onClose?: () => void } = {}) {
  return render(
    <RoleTestingProvider>
      <InvitePersonWizard parentOrganizationId="parent-1" onClose={onClose} />
    </RoleTestingProvider>
  );
}

beforeEach(() => {
  inviteMutate.mockReset();
  viewerRole = 'owner';
});

describe('InvitePersonWizard', () => {
  it('shows an informational note that new people join the parent organization, pointing at the sub-organization assignment entry', () => {
    renderWizard();

    // Matches the drawer entry's own header text exactly (see
    // `renderMemberManagementDrawerContent.tsx`'s "Add people to
    // sub-organizations" header), so this note and that entry point never
    // drift into two different names for the same feature.
    screen.getByText(/New people join the parent organization/);
    screen.getByText(/Add people to sub-organizations/);
  });

  it("renders only the roles available for the viewer's role in the parent organization", async () => {
    viewerRole = 'admin';
    renderWizard();

    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    screen.getByRole('option', { name: 'Admin' });
    screen.getByRole('option', { name: 'Member' });
    screen.getByRole('option', { name: 'Billing Manager' });
    // An admin viewer cannot invite an owner.
    expect(screen.queryByRole('option', { name: 'Owner' })).toBeNull();
  });

  it('includes the owner role for an owner viewer', async () => {
    renderWizard();

    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    screen.getByRole('option', { name: 'Owner' });
  });

  it('disables the form and shows a permission message for a viewer who cannot invite', () => {
    viewerRole = 'member';
    renderWizard();

    screen.getByText("You don't have permission to invite members into this organization.");
    expect((screen.getByLabelText('Email address') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(inviteMutate).not.toHaveBeenCalled();
  });

  // jsdom can't verify visual stacking order, so this only checks that the
  // override class this bug fix depends on is present on the rendered
  // element, guarding against a future refactor silently dropping it and
  // reintroducing the invisible-dropdown bug (see `DrawerStack.tsx`'s
  // z-index vs. this primitive's default `z-50`).
  it('renders the role SelectContent with the drawer-stack z-index override', async () => {
    renderWizard();

    fireEvent.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(listbox.className).toContain('z-[70]');
  });

  it('invites into the parent organization with the entered email and default role', () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(inviteMutate).toHaveBeenCalledTimes(1);
    expect(inviteMutate).toHaveBeenCalledWith(
      { organizationId: 'parent-1', email: 'new.person@example.com', role: 'member' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
  });

  it('always targets the parent organization, regardless of the viewer role scenario', () => {
    viewerRole = 'admin';
    renderWizard();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(inviteMutate).toHaveBeenCalledTimes(1);
    expect(inviteMutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ organizationId: 'parent-1' })
    );
  });

  it('disables submit for an invalid email and does not call the mutation', () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'not-an-email' } });

    expect(
      (screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(inviteMutate).not.toHaveBeenCalled();
  });

  it('closes the wizard on a successful invite, which drives the directory query invalidation on drawer close', async () => {
    const onClose = jest.fn();
    renderWizard({ onClose });

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'new.person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const [, { onSuccess }] = inviteMutate.mock.calls[0];
    onSuccess();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
