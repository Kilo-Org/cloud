import { useLocalSearchParams } from 'expo-router';

import { ScopeEntryScreen } from '@/components/security-agent/scope-entry-screen';

export default function SecurityAgentScopeRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <ScopeEntryScreen scope={scope} />;
}
