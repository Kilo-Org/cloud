import { useLocalSearchParams } from 'expo-router';

import { TriggerDetailScreen } from '@/components/cloud-triggers/trigger-detail-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function TriggerDetailRoute() {
  const { triggerId, org } = useLocalSearchParams<{ triggerId: string; org?: string }>();
  return (
    <TriggerDetailScreen
      triggerId={triggerId}
      organizationId={triggerScopeFromParam(org)}
    />
  );
}
