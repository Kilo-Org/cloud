import { useLocalSearchParams } from 'expo-router';

import { TriggerDetailScreen } from '@/components/cloud-triggers/trigger-detail-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function TriggerDetailRoute() {
  const { 'trigger-id': triggerId, org } = useLocalSearchParams<{
    'trigger-id': string;
    org?: string;
  }>();
  return <TriggerDetailScreen triggerId={triggerId} organizationId={triggerScopeFromParam(org)} />;
}
