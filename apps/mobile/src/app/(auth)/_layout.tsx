import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { NativeStateSurface } from '@/components/centered-state-surface';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'login',
};

export default function AuthLayout() {
  const options = useFormSheetScreenOptions();
  const sheetOptions =
    Platform.OS === 'android'
      ? { ...options, sheetAllowedDetents: [options.sheetAllowedDetents[1]] }
      : options;

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
