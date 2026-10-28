import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { appSurfaceSceneLayout } from '@/components/app-screen-layout';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export const unstable_settings = {
  initialRouteName: 'login',
};

export default function AuthLayout() {
  const colors = useThemeColors();
  const options = useFormSheetScreenOptions();
  const sheetOptions =
    Platform.OS === 'android'
      ? { ...options, sheetAllowedDetents: [options.sheetAllowedDetents[1]] }
      : options;
  // A formSheet without a themed content background draws its surface
  // transparent: react-native-screens tints the sheet from the resolved
  // background of the screen content, and the black dimming view behind it
  // then shows through as a near-black card in light mode. The (app) stack
  // paints every sheet through `contentStyle`; the auth stack needs the same
  // for its own formSheet routes.
  const themedSheetOptions = {
    ...sheetOptions,
    contentStyle: { backgroundColor: colors.background },
  };

  return (
    <Stack screenLayout={appSurfaceSceneLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="language-picker" options={themedSheetOptions} />
    </Stack>
  );
}
