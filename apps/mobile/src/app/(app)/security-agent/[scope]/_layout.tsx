import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { appScreenLayout } from '@/components/app-screen-layout';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
import { SecurityAgentScopeProvider } from '@/components/security-agent/security-agent-scope-route';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { parseSecurityScope } from '@/lib/security-agent';

export const unstable_settings = {
  anchor: 'index',
};

// Mounts exactly one command observer per scope alongside a headerless Stack,
// so it stays mounted across Dashboard/Findings/Settings navigation without
// ever running twice for the same scope. Also the single validation point
// for the `scope` param — every route under `[scope]/` is a descendant of
// this layout, so rejecting a segment that cannot name a scope here blocks
// all of them before any query/mutation runs with an invalid owner.
export default function SecurityAgentScopeLayout() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseSecurityScope(rawScope);
  const sheetOptions = useFormSheetScreenOptions();

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
  }

  return (
    <SecurityAgentScopeProvider scope={scope}>
      <SecurityAgentCommandObserver scope={scope} />
      <Stack screenLayout={appScreenLayout} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="dismiss/[id]" options={sheetOptions} />
        <Stack.Screen name="filter" options={sheetOptions} />
      </Stack>
    </SecurityAgentScopeProvider>
  );
}
