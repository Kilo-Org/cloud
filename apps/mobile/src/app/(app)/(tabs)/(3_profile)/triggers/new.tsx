import { useLocalSearchParams } from 'expo-router';

import { TriggerCreateScreen } from '@/components/cloud-triggers/trigger-create-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';
import { triggerCreateHref } from '@/lib/cloud-triggers/trigger-routes';
import { useRepairTriggerRouteStack } from '@/lib/hooks/use-repair-trigger-route-stack';

export default function NewTriggerRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  const organizationId = triggerScopeFromParam(org);
  // A link that arrives without the triggers list beneath it rebuilds it, so
  // Back returns to the list instead of leaving the profile tree.
  useRepairTriggerRouteStack({
    self: triggerCreateHref(organizationId),
  });
  return <TriggerCreateScreen organizationId={organizationId} />;
}
