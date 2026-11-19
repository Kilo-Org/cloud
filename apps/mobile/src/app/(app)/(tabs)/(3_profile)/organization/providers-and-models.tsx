import { OrganizationProvidersAndModelsScreen } from '@/components/organization/providers-and-models-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';

export default function OrganizationProvidersAndModelsRoute() {
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({
    self: '/(app)/(tabs)/(3_profile)/organization/providers-and-models',
  });
  return <OrganizationProvidersAndModelsScreen />;
}
