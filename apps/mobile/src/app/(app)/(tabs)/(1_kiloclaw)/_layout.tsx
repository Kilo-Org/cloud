import { Stack } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { useFormSheetDetents } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function KiloClawLayout() {
  // Cap the full detent like every other formSheet: PickerSheet's header drops
  // the Android top clearance ("bottom-form-sheet"), which is only safe when
  // the sheet cannot reach the status bar.
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
