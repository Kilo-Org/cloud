import { useLocalSearchParams } from 'expo-router';

import { RepositorySettingsScreen } from '@/components/security-agent/repository-settings-screen';

export default function SecurityAgentRepositorySettingsRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <RepositorySettingsScreen scope={scope} />;
}
