import { OrganizationMembersScreen } from '@/components/organization/members-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function OrganizationMembersRoute() {
  // The members list belongs to the account it was opened under; a switch to
  // another account returns to that account's hub.
  const stale = useLeaveStaleOrganizationScope();
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({ self: '/(app)/(tabs)/(3_profile)/organization/members' });
  if (stale) {
    return null;
  }
  return <OrganizationMembersScreen />;
}
