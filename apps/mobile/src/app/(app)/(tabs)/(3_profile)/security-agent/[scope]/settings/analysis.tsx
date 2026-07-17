import { useLocalSearchParams } from 'expo-router';

import { AnalysisSettingsScreen } from '@/components/security-agent/analysis-settings-screen';

export default function SecurityAgentAnalysisSettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <AnalysisSettingsScreen scope={scope} />;
}
