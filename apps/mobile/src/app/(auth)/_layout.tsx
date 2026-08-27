import { Stack } from 'expo-router';

import { useFormSheetDetents } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'login',
};

export default function AuthLayout() {
  const { fullSheetDetent } = useFormSheetDetents();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen
        name="language-picker"
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
