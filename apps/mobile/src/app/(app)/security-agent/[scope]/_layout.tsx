import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { appScreenLayout } from '@/components/app-screen-layout';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { parseParam } from '@/lib/route-params';

export const unstable_settings = {
  anchor: 'index',
};

// Mounts exactly one command observer per scope alongside a headerless Stack,
// so it stays mounted across Dashboard/Findings/Settings navigation without
// ever running twice for the same scope. Also the single validation point
// for the `scope` param — every route under `[scope]/` is a descendant of
// this layout, so rejecting an invalid scope here blocks all of them before
// any query/mutation runs.
export default function SecurityAgentScopeLayout() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseParam(rawScope);
  const sheetOptions = useFormSheetScreenOptions();

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
  }

  return (
    <>
      <SecurityAgentCommandObserver scope={scope} />
      <Stack screenLayout={appScreenLayout} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="dismiss/[id]" options={sheetOptions} />
        <Stack.Screen name="filter" options={sheetOptions} />
      </Stack>
    </>
  );
}
