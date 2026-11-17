import { useLocalSearchParams } from 'expo-router';

import { TriggerCreateScreen } from '@/components/cloud-triggers/trigger-create-screen';
import { triggerScopeFromParam } from '@/lib/cloud-triggers/trigger-scope';

export default function NewTriggerRoute() {
  const { org } = useLocalSearchParams<{ org?: string }>();
  return <TriggerCreateScreen organizationId={triggerScopeFromParam(org)} />;
}
