import { describe, expect, it } from 'vitest';

import {
  assignableMemberRoles,
  invitableRoles,
  submittedInviteRole,
} from './organization-role-options';

describe('invitableRoles', () => {
  it('offers every role to an owner, owner included, in the web order', () => {
    expect(invitableRoles('owner')).toEqual(['owner', 'admin', 'member', 'billing_manager']);
  });

  it('stops an admin at admin, because only an owner may invite an owner', () => {
    expect(invitableRoles('admin')).toEqual(['admin', 'member', 'billing_manager']);
  });

  it('leaves a billing manager the plain member row', () => {
    expect(invitableRoles('billing_manager')).toEqual(['member']);
  });

  it('offers nothing to a role that cannot invite', () => {
    expect(invitableRoles('member')).toEqual([]);
    expect(invitableRoles(undefined)).toEqual([]);
  });
});

describe('assignableMemberRoles', () => {
  it('lets an owner assign every role', () => {
    expect(assignableMemberRoles('owner')).toEqual(['owner', 'admin', 'member', 'billing_manager']);
  });

  it('stops an admin at the roles below owner', () => {
    expect(assignableMemberRoles('admin')).toEqual(['admin', 'member', 'billing_manager']);
  });

  it('offers nothing to a billing manager or a member', () => {
    expect(assignableMemberRoles('billing_manager')).toEqual([]);
    expect(assignableMemberRoles('member')).toEqual([]);
    expect(assignableMemberRoles(undefined)).toEqual([]);
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
