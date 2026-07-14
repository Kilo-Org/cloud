import { type Href, Stack, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
import { useFormSheetDetents } from '@/lib/form-sheet';
import { parseParam } from '@/lib/route-params';

// Mounts exactly one command observer per scope alongside a headerless Stack,
// so it stays mounted across Dashboard/Findings/Settings navigation without
// ever running twice for the same scope. Also the single validation point
// for the `scope` param — every route under `[scope]/` is a descendant of
// this layout, so rejecting an invalid scope here blocks all of them before
// any query/mutation runs.
export default function SecurityAgentScopeLayout() {
  const { scope: rawScope } = useLocalSearchParams<{ scope: string }>();
  const scope = parseParam(rawScope);
  const { fullSheetDetent } = useFormSheetDetents();

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/security-agent' as Href} />;
  }

  return (
    <>
      <SecurityAgentCommandObserver scope={scope} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen
          name="dismiss/[id]"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.5, fullSheetDetent],
            sheetGrabberVisible: true,
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="filter"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.5, fullSheetDetent],
            sheetGrabberVisible: true,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}
