import { Stack } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { useFormSheetDetents } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function KiloClawLayout() {
  // Native formSheets handle the top safe area, so PickerSheet's header does
  // not add its own top clearance.
  const { fullSheetDetent } = useFormSheetDetents();
  return (
    <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen
        name="chat/instance-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, fullSheetDetent],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
    </Stack>
  );
}
