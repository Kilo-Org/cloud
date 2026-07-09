import { Stack, useLocalSearchParams } from 'expo-router';

import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';

// Mounts exactly one command observer per scope alongside a headerless Stack,
// so it stays mounted across Dashboard/Findings/Settings navigation without
// ever running twice for the same scope.
export default function SecurityAgentScopeLayout() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return (
    <>
      <SecurityAgentCommandObserver scope={scope} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
