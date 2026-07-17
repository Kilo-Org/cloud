import { useLocalSearchParams } from 'expo-router';

import { AutomationSettingsScreen } from '@/components/security-agent/automation-settings-screen';

export default function SecurityAgentAutomationSettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <AutomationSettingsScreen scope={scope} />;
}
