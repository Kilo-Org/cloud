// Pure builder for the organization Members screen's FlashList items.
//
// One flat array drives a single FlashList. The composition rules are exact so
// the empty state can never go missing:
//
//   - both lists empty        -> `[]` (the list renders `ListEmptyComponent`)
//   - active members present  -> `section: 'Members'` + one `member` row each
//   - no active, invites      -> `members-empty` + the invites section
//   - invites present         -> `section: 'Pending invitations'` + one
//                                `invite` row each
//
// `last` marks the final row of each group so the existing hairline rule is
// preserved.

import { i18n } from '@/i18n';
import { type ActiveOrgMember, type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';

export type MembersListItem =
  | { kind: 'section'; title: string }
  | { kind: 'members-empty' }
  | { kind: 'member'; member: ActiveOrgMember; last: boolean }
  | { kind: 'invite'; invite: InvitedOrgMember; last: boolean };

export function buildMembersListItems(args: {
  activeMembers: ActiveOrgMember[];
  invitedMembers: InvitedOrgMember[];
}): MembersListItem[] {
  const { activeMembers, invitedMembers } = args;
  const items: MembersListItem[] = [];

  if (activeMembers.length > 0) {
    items.push({ kind: 'section', title: i18n.t('organization.members.title') });
    for (const [index, member] of activeMembers.entries()) {
      items.push({
        kind: 'member',
        member,
        last: index === activeMembers.length - 1,
      });
    }
  } else if (invitedMembers.length > 0) {
    items.push({ kind: 'members-empty' });
  }

  if (invitedMembers.length > 0) {
    items.push({ kind: 'section', title: i18n.t('organization.members.pendingInvitations') });
    for (const [index, invite] of invitedMembers.entries()) {
      items.push({
        kind: 'invite',
        invite,
        last: index === invitedMembers.length - 1,
      });
    }
  }

  return items;
}
