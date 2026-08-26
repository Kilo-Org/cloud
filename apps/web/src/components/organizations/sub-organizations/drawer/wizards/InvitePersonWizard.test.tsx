/** @jest-environment jsdom */
import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoleTestingProvider, useRoleTesting } from '@/contexts/RoleTestingContext';
import type { SubOrganizationPeopleData } from '../types';
import {
  CHILD_ORG_DIRECT_INVITE_BLOCKED_MESSAGE,
  InvitePersonWizard,
  PARENT_ORGANIZATION_LABEL,
  isDirectInviteTarget,
} from './InvitePersonWizard';

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

// The viewer's role in each org, keyed by org id. Reset to these defaults
// before every test; individual tests override entries to exercise
// different per-viewer outcomes for the parent org specifically. Child
// orgs' entries are largely inert now — a child org's target option is
// disabled unconditionally (see `InvitePersonWizard`'s
// `CHILD_ORG_DIRECT_INVITE_BLOCKED_MESSAGE`), regardless of the viewer's
// role in that child, which is exactly the behavior this suite proves.
const DEFAULT_ROLE_BY_ORG: Record<string, string> = {
  'parent-1': 'owner',
  'child-1': 'admin',
  'child-2': 'member',
};
let roleByOrg: Record<string, string> = { ...DEFAULT_ROLE_BY_ORG };

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
            role: roleByOrg[organizationId] ?? 'member',
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

/**
 * Forces `useIsKiloAdmin()` to `true` for everything rendered below it, by
 * driving `RoleTestingProvider`'s real "assumed role" mechanism rather than
 * a bespoke context mock — `OrganizationAdminContextProvider` treats an
 * assumed role of `'KILO ADMIN'` exactly like a real Kilo admin session,
 * independent of the mocked `next-auth/react` session above. Used to prove
 * that a child org's target option is disabled even for the single most
 * privileged viewer this app has, since the constraint is about the
 * organization, not the viewer.
 */
function AssumeKiloAdmin() {
  const { setAssumedRole } = useRoleTesting();
  useEffect(() => setAssumedRole('KILO ADMIN'), [setAssumedRole]);
  return null;
}

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

function renderWizard({
  onClose = jest.fn(),
  assumeKiloAdmin = false,
}: { onClose?: () => void; assumeKiloAdmin?: boolean } = {}) {
  return render(
    <RoleTestingProvider>
      {assumeKiloAdmin && <AssumeKiloAdmin />}
      <InvitePersonWizard
        parentOrganizationId="parent-1"
        children={buildChildren()}
        onClose={onClose}
      />
    </RoleTestingProvider>
  );
}

describe('isDirectInviteTarget', () => {
  it('accepts only the parent organization id', () => {
    expect(isDirectInviteTarget('parent-1', 'parent-1')).toBe(true);
  });

  it('rejects any other organization id, i.e. any child organization', () => {
    expect(isDirectInviteTarget('child-1', 'parent-1')).toBe(false);
    expect(isDirectInviteTarget('child-2', 'parent-1')).toBe(false);
  });
});

describe('InvitePersonWizard org picker', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    roleByOrg = { ...DEFAULT_ROLE_BY_ORG };
    orgFetchOverride = {};
  });

  it('keeps every child organization permanently disabled with a categorical explanation, regardless of the viewer\u2019s role in that child', () => {
    renderWizard();

    // child-1's viewer is an admin (who could otherwise invite), child-2's
    // viewer is a plain member (who could not) — both are disabled here,
    // proving this isn't gated on the viewer's per-org role at all.
    const childOneRadio = screen.getByRole('radio', { name: 'Child One' }) as HTMLButtonElement;
    const childTwoRadio = screen.getByRole('radio', { name: 'Child Two' }) as HTMLButtonElement;
    expect(childOneRadio.disabled).toBe(true);
    expect(childTwoRadio.disabled).toBe(true);

    // The categorical message appears once per child, and is distinct from
    // the per-viewer-role labels used for the parent.
    expect(screen.getAllByText(CHILD_ORG_DIRECT_INVITE_BLOCKED_MESSAGE)).toHaveLength(2);
    expect(screen.queryByText("You can't invite here")).toBeNull();
  });

  it('keeps child organizations disabled even for a Kilo admin, since this is not a permission issue', () => {
    renderWizard({ assumeKiloAdmin: true });

    const childOneRadio = screen.getByRole('radio', { name: 'Child One' }) as HTMLButtonElement;
    const childTwoRadio = screen.getByRole('radio', { name: 'Child Two' }) as HTMLButtonElement;
    expect(childOneRadio.disabled).toBe(true);
    expect(childTwoRadio.disabled).toBe(true);
    expect(screen.getAllByText(CHILD_ORG_DIRECT_INVITE_BLOCKED_MESSAGE)).toHaveLength(2);

    // The parent, by contrast, is enabled for a Kilo admin — proving the
    // child-disabling isn't some blanket disable that also caught the
    // parent by accident.
    const parentRadio = screen.getByRole('radio', {
      name: PARENT_ORGANIZATION_LABEL,
    }) as HTMLButtonElement;
    expect(parentRadio.disabled).toBe(false);
  });

  it('still gates the parent organization by the viewer\u2019s real per-org role, as before', () => {
    roleByOrg['parent-1'] = 'member';
    renderWizard();

    const parentRadio = screen.getByRole('radio', {
      name: PARENT_ORGANIZATION_LABEL,
    }) as HTMLButtonElement;
    expect(parentRadio.disabled).toBe(true);
    screen.getByText("You can't invite here");
  });

  it('enables the parent organization for a viewer who can invite into it', () => {
    renderWizard();

    const parentRadio = screen.getByRole('radio', {
      name: PARENT_ORGANIZATION_LABEL,
    }) as HTMLButtonElement;
    expect(parentRadio.disabled).toBe(false);
  });

  it('does not let the viewer proceed past the target step without picking an enabled organization', () => {
    renderWizard();

    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a loading state instead of a false "cannot invite" result while the parent\u2019s access is still resolving, without ever claiming a child is "checking"', () => {
    // Simulates the parent's own `useOrganizationWithMembers` fetch still
    // being in flight (as it genuinely is for a brief window right after
    // the wizard mounts) rather than the always-already-resolved data the
    // other tests in this file use. Child orgs never mount this fetch at
    // all now, so overriding their entries would have no effect.
    orgFetchOverride = {
      'parent-1': { data: undefined, isLoading: true },
    };
    renderWizard();

    expect(screen.getAllByText('Checking access…')).toHaveLength(1);
    expect(screen.queryByText("You can't invite here")).toBeNull();
    expect(
      (screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }) as HTMLButtonElement).disabled
    ).toBe(true);

    // The children's categorical explanation is unconditional and doesn't
    // flicker through a loading state of its own.
    expect(screen.getAllByText(CHILD_ORG_DIRECT_INVITE_BLOCKED_MESSAGE)).toHaveLength(2);
  });

  it('never selects a child organization or calls the invite mutation, even when its disabled radio is clicked', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Child Two' }));

    // Clicking a disabled radio has no effect: nothing becomes selected,
    // so `Next` stays disabled and the mutation is never reached.
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(inviteMutate).not.toHaveBeenCalled();
  });
});

describe('InvitePersonWizard role options', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    roleByOrg = { ...DEFAULT_ROLE_BY_ORG };
    orgFetchOverride = {};
  });

  it("renders only the roles available for the parent organization's viewer role", async () => {
    roleByOrg['parent-1'] = 'admin';
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    screen.getByText('Step 2 of 2: Invite by email');
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

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    screen.getByRole('option', { name: 'Owner' });
  });
});

describe('InvitePersonWizard submit', () => {
  beforeEach(() => {
    inviteMutate.mockReset();
    roleByOrg = { ...DEFAULT_ROLE_BY_ORG };
    orgFetchOverride = {};
  });

  it('invites into the parent organization with the entered email and default role', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

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

  it('never calls the invite mutation with a child organization id, in any reachable scenario', () => {
    renderWizard();

    // Attempting to pick a child, then proceeding and submitting, is a
    // no-op end to end: the radio never selects, `Next` never enables, and
    // the mutation is never invoked with a child id (or at all).
    fireEvent.click(screen.getByRole('radio', { name: 'Child One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByText('Step 2 of 2: Invite by email')).toBeNull();
    expect(inviteMutate).not.toHaveBeenCalled();

    // The only organization that ever reaches the mutation is the parent.
    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
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

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'not-an-email' } });

    expect(
      (screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(inviteMutate).not.toHaveBeenCalled();
  });

  it('closes the wizard on a successful invite, which drives the directory query invalidation on drawer close', async () => {
    const onClose = jest.fn();
    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('radio', { name: PARENT_ORGANIZATION_LABEL }));
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
