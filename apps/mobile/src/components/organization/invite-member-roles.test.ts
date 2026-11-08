import { describe, expect, it } from 'vitest';

import { invitableRoles, submittedInviteRole } from './invite-member-roles';

describe('invitableRoles', () => {
  it('offers every assignable role to an owner, owner included', () => {
    expect(invitableRoles('owner')).toEqual(['member', 'billing_manager', 'owner']);
  });

  it('stops an admin at billing manager, because only an owner may invite an owner', () => {
    expect(invitableRoles('admin')).toEqual(['member', 'billing_manager']);
  });

  it('leaves a billing manager the plain member row', () => {
    expect(invitableRoles('billing_manager')).toEqual(['member']);
  });

  it('offers nothing to a role that cannot invite', () => {
    expect(invitableRoles('member')).toEqual([]);
    expect(invitableRoles(undefined)).toEqual([]);
  });
});

describe('submittedInviteRole', () => {
  it('keeps a selection the caller may still make', () => {
    expect(submittedInviteRole('owner', 'owner')).toBe('owner');
    expect(submittedInviteRole('admin', 'billing_manager')).toBe('billing_manager');
  });

  it('falls back to member when the caller lost the authority for the selection', () => {
    expect(submittedInviteRole('admin', 'owner')).toBe('member');
    expect(submittedInviteRole('billing_manager', 'billing_manager')).toBe('member');
  });
});
