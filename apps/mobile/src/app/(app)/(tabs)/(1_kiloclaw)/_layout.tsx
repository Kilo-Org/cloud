import { Stack } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function KiloClawLayout() {
  return (
    <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen
        name="chat/instance-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
    </Stack>
  );
}
