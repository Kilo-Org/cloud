import { type Href, Stack, useLocalSearchParams } from 'expo-router';
import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';
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
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  // Mirrors apps/(app)/_layout.tsx's Android-safe full-sheet detent — Android
  // formSheets can't hit 1.0 without clipping under the status bar.
  const androidTopInset = top > 0 ? top : (StatusBar.currentHeight ?? 0);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

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
      </Stack>
    </>
  );
}
