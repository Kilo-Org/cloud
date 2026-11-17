import { useLocalSearchParams } from 'expo-router';

import { TriggersListScreen } from '@/components/cloud-triggers/triggers-list-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function TriggersRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <TriggersListScreen organizationId={triggerScopeFromParam(org)} />;
}
