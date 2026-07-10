import { Stack } from 'expo-router';
import { Platform, StatusBar, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Mirrors apps/(app)/_layout.tsx's Android-safe full-sheet detent — Android
// formSheets can't hit 1.0 without clipping under the status bar.
export default function OrganizationLayout() {
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const androidTopInset = top > 0 ? top : (StatusBar.currentHeight ?? 0);
  const androidFullSheetDetent =
    height > 0 ? Math.max(0.5, (height - androidTopInset) / height) : 1;
  const fullSheetDetent = Platform.OS === 'android' ? androidFullSheetDetent : 1;

  const sheetOptions = {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetGrabberVisible: true,
    headerShown: false,
  };

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="invite-member" options={sheetOptions} />
      <Stack.Screen name="member-limit" options={sheetOptions} />
      <Stack.Screen name="low-balance-alert" options={sheetOptions} />
    </Stack>
  );
}
