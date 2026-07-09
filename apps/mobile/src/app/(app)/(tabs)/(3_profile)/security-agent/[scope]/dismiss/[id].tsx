import { useLocalSearchParams } from 'expo-router';

import { DismissFindingScreen } from '@/components/security-agent/dismiss-finding-screen';

export default function SecurityAgentDismissFindingRoute() {
  const { scope, id } = useLocalSearchParams<{ scope: string; id: string }>();
  return <DismissFindingScreen scope={scope} findingId={id} />;
}
