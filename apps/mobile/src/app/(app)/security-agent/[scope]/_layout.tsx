import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
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
  const sheetOptions = useFormSheetScreenOptions();

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
  }

  return (
    <>
      <SecurityAgentCommandObserver scope={scope} />
      {/* Anchored entry needs a valid scope root, not a parameterless dismissal route. */}
      <Stack
        initialRouteName="index"
        screenLayout={appUnlockScreenLayout}
        screenOptions={{ headerShown: false }}
      >
        {/*
         * An anchored navigation (a notification or system-search link to a
         * finding) inserts `index` below the target with only its
         * `initialParams`, not the URL params. Without `scope` here the
         * dashboard under the finding queries with no `organizationId`.
         */}
        <Stack.Screen name="index" initialParams={{ scope }} />
        <Stack.Screen name="dismiss/[id]" options={sheetOptions} />
        <Stack.Screen name="filter" options={sheetOptions} />
      </Stack>
    </>
  );
}
