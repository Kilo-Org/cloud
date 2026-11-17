import { useLocalSearchParams } from 'expo-router';

import { TriggerDetailScreen } from '@/components/cloud-triggers/trigger-detail-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';
import { triggerDetailHref } from '@/lib/cloud-triggers/trigger-routes';
import { useRepairTriggerRouteStack } from '@/lib/hooks/use-repair-trigger-route-stack';

export default function TriggerDetailRoute() {
  const { 'trigger-id': triggerId, org } = useLocalSearchParams<{
    'trigger-id': string;
    org?: string;
  }>();
  const organizationId = triggerScopeFromParam(org);
  // A link or a post-create landing that arrives without the triggers list
  // beneath it rebuilds it, so Back returns to the list instead of leaving the
  // profile tree.
  useRepairTriggerRouteStack({
    self: triggerDetailHref(triggerId, organizationId),
  });
  return <TriggerDetailScreen triggerId={triggerId} organizationId={organizationId} />;
}
