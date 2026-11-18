import { CreateOrganizationScreen } from '@/components/organization/create-organization-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';

export default function CreateOrganizationRoute() {
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({ self: '/(app)/(tabs)/(3_profile)/organization/create' });
  return <CreateOrganizationScreen />;
}
