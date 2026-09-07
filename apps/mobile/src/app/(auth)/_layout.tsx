import { Stack } from 'expo-router';

import { NativeStateSurface } from '@/components/centered-state-surface';
import { useFormSheetDetents } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'login',
};

export default function AuthLayout() {
  const { fullSheetDetent } = useFormSheetDetents();

  return (
    <Stack
      screenLayout={props => <NativeStateSurface {...props} />}
      screenOptions={{ headerShown: false }}
    >
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
