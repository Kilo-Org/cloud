import { useLocalSearchParams } from 'expo-router';
import { TRIGGERS_LIST_ROUTE_NAME } from '@/lib/profile-route-stack';
import { useRetireCoveredSource } from '@/lib/navigation/retire-covered-source';

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
    organizationId,
  });
  // The create hand-off pushes this screen and retires the form beneath it
  // from the form's own listener — which a covered screen never runs. This
  // side owns the retire instead: one reset that removes a `triggers/new`
  // entry directly beneath this detail, with the triggers list beneath the
  // form, and leaves every other stack (a deep link, a wedge) alone.
  useRetireCoveredSource('triggers/new', TRIGGERS_LIST_ROUTE_NAME);
  return <TriggerDetailScreen triggerId={triggerId} organizationId={organizationId} />;
}
