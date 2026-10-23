import { useLocalSearchParams } from 'expo-router';

import { SlaSettingsScreen } from '@/components/security-agent/sla-settings-screen';

export default function SecurityAgentSlaSettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <SlaSettingsScreen scope={scope} />;
}
