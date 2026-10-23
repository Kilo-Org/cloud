import { useLocalSearchParams } from 'expo-router';

import { SettingsOverviewScreen } from '@/components/security-agent/settings-overview-screen';

export default function SecurityAgentSettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <SettingsOverviewScreen scope={scope} presentation="route" />;
}
