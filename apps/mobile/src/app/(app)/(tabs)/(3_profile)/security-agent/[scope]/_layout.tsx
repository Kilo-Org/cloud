import { Stack, useLocalSearchParams } from 'expo-router';
import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SecurityAgentCommandObserver } from '@/components/security-agent/security-agent-command-observer';

// Mounts exactly one command observer per scope alongside a headerless Stack,
// so it stays mounted across Dashboard/Findings/Settings navigation without
// ever running twice for the same scope.
export default function SecurityAgentScopeLayout() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  // Mirrors apps/(app)/_layout.tsx's Android-safe full-sheet detent — Android
  // formSheets can't hit 1.0 without clipping under the status bar.
  const androidTopInset = top > 0 ? top : (StatusBar.currentHeight ?? 0);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

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
