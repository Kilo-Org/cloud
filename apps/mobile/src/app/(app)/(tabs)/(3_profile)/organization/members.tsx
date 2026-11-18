import { OrganizationMembersScreen } from '@/components/organization/members-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function OrganizationMembersRoute() {
  // The members list belongs to the account it was opened under; a switch to
  // another account returns to that account's hub.
  const stale = useLeaveStaleOrganizationScope();
  if (stale) {
    return null;
  }
  return <OrganizationMembersScreen />;
}
