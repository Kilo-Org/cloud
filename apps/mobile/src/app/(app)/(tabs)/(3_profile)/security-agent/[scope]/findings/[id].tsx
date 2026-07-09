import { useLocalSearchParams } from 'expo-router';

import { FindingDetailScreen } from '@/components/security-agent/finding-detail-screen';

export default function SecurityAgentFindingDetailRoute() {
  const { scope, id } = useLocalSearchParams<{ scope: string; id: string }>();
  return <FindingDetailScreen scope={scope} findingId={id} />;
}
