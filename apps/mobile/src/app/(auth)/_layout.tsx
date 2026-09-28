import { Stack } from 'expo-router';

import { NativeStateSurface } from '@/components/centered-state-surface';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'login',
};

export default function AuthLayout() {
  const sheetOptions = useFormSheetScreenOptions();

  return (
    <Stack
      screenLayout={props => <NativeStateSurface {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="language-picker" options={sheetOptions} />
    </Stack>
  );
}
