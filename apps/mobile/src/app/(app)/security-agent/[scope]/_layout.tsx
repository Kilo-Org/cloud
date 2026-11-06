import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { appScreenLayout } from '@/components/app-screen-layout';

import { type ScreenLayoutProps } from '@/components/centered-state-surface';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { useRepairSecurityAgentScopeStack } from '@/lib/hooks/use-repair-security-agent-scope-stack';
import { parseSecurityScope } from '@/lib/security-agent';

export const unstable_settings = {
  anchor: 'index',
};

/**
 * One scene of the group's Stack: repair the Stack if the screen arrived
 * without the dashboard beneath it, then render the app's shared scene layout.
 *
 * A scene layout renders outside the route's NavigationProvider, so the repair
 * is handed the screen's navigation instead of reading one, and the segment
 * comes from the layout that validated it rather than from a second read of
 * the route's own params.
 */
function SecurityAgentSceneLayout({
  scope,
  ...props
}: ScreenLayoutProps & Readonly<{ scope: string | null }>) {
  useRepairSecurityAgentScopeStack(props.navigation, scope);
  return appScreenLayout(props);
}

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
  // The group's dashboard must sit beneath every screen of this Stack: a
  // link that opens a screen as a fresh destination makes it the Stack's only
  // route, and a Back press then leaves the whole Security Agent group instead
  // of returning to the dashboard.
  const screenLayout = useCallback(
    (props: ScreenLayoutProps) => <SecurityAgentSceneLayout {...props} scope={scope} />,
    [scope]
  );

  if (!scope) {
    return <InvalidRouteState backTo={'/(app)/security-agent' as Href} />;
  }

  return (
    <>
      <SecurityAgentCommandObserver scope={scope} />
      <Stack
        screenLayout={screenLayout}
        screenOptions={{ headerShown: false }}
        // Registered so the dashboard is declared in this Stack's route names
        // even when nothing has pushed it yet: the repair inserts a route by
        // that name.
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="dismiss/[id]" options={sheetOptions} />
        <Stack.Screen name="filter" options={sheetOptions} />
      </Stack>
    </>
  );
}
