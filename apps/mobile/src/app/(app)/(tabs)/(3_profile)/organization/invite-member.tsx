import { InviteMemberSheet } from '@/components/organization/invite-member-sheet';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function InviteMemberRoute() {
  // The sheet invites into the account it was opened under; a switch elsewhere
  // closes it rather than offering the next account's form.
  const stale = useLeaveStaleOrganizationScope();
  if (stale) {
    return null;
  }
  return <InviteMemberSheet />;
}
