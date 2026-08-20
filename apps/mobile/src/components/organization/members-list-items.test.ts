import { describe, expect, it } from 'vitest';

import { type ActiveOrgMember, type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';

import { buildMembersListItems } from './members-list-items';

function activeMember(id: string): ActiveOrgMember {
  return {
    id,
    name: `Member ${id}`,
    email: `${id}@example.com`,
    role: 'member',
    status: 'active',
    inviteDate: null,
    dailyUsageLimitUsd: null,
    currentDailyUsageUsd: null,
  };
}

function invitedMember(id: string): InvitedOrgMember {
  return {
    email: `${id}@example.com`,
    role: 'member',
    inviteDate: null,
    inviteToken: `token-${id}`,
    inviteId: `invite-${id}`,
    status: 'invited',
    inviteUrl: `https://example.com/invite/${id}`,
    emailStatus: null,
    dailyUsageLimitUsd: null,
    currentDailyUsageUsd: null,
  };
}

describe('buildMembersListItems', () => {
  it('returns [] when both lists are empty', () => {
    expect(buildMembersListItems({ activeMembers: [], invitedMembers: [] })).toEqual([]);
  });

  it('builds members only with a Members section and a last flag', () => {
    const items = buildMembersListItems({
      activeMembers: [activeMember('a'), activeMember('b')],
      invitedMembers: [],
    });
    expect(items).toEqual([
      { kind: 'section', title: 'Members' },
      { kind: 'member', member: activeMember('a'), last: false },
      { kind: 'member', member: activeMember('b'), last: true },
    ]);
  });

  it('builds members plus invites with both sections and correct last flags', () => {
    const items = buildMembersListItems({
      activeMembers: [activeMember('a')],
      invitedMembers: [invitedMember('i1'), invitedMember('i2')],
    });
    expect(items).toEqual([
      { kind: 'section', title: 'Members' },
      { kind: 'member', member: activeMember('a'), last: true },
      { kind: 'section', title: 'Pending invitations' },
      { kind: 'invite', invite: invitedMember('i1'), last: false },
      { kind: 'invite', invite: invitedMember('i2'), last: true },
    ]);
  });

  it('omits the Pending invitations header when there are no invites', () => {
    const items = buildMembersListItems({
      activeMembers: [activeMember('a')],
      invitedMembers: [],
    });
    expect(
      items.some(item => item.kind === 'section' && item.title === 'Pending invitations')
    ).toBe(false);
    expect(items.some(item => item.kind === 'invite')).toBe(false);
  });

  it('starts with members-empty when there are no active members but invites exist', () => {
    const items = buildMembersListItems({
      activeMembers: [],
      invitedMembers: [invitedMember('i1')],
    });
    expect(items[0]).toEqual({ kind: 'members-empty' });
    expect(items).toEqual([
      { kind: 'members-empty' },
      { kind: 'section', title: 'Pending invitations' },
      { kind: 'invite', invite: invitedMember('i1'), last: true },
    ]);
  });

  it('flags the final row of each group as last', () => {
    const items = buildMembersListItems({
      activeMembers: [activeMember('a'), activeMember('b')],
      invitedMembers: [invitedMember('i1')],
    });
    const members = items.filter(item => item.kind === 'member');
    const invites = items.filter(item => item.kind === 'invite');
    expect(members.map(item => item.last)).toEqual([false, true]);
    expect(invites.map(item => item.last)).toEqual([true]);
  });
});
