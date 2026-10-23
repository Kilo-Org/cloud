import { Stack } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';

import { organizationSheetDetents } from '@/lib/form-sheet-detents';
import { useFormSheetScreenOptions } from '@/lib/form-sheet';

export default function OrganizationLayout() {
  const sheetOptions = useFormSheetScreenOptions();
  const { height } = useWindowDimensions();
  // A short window cannot show these forms at the half detent without clipping
  // their last row and submit action under the tab bar (see the detent helper).
  const organizationSheetOptions = {
    ...sheetOptions,
    sheetAllowedDetents: organizationSheetDetents({
      platform: Platform.OS,
      windowHeight: height,
      fullSheetDetent: sheetOptions.sheetAllowedDetents[1],
    }),
  };

  return (
    <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="invite-member"
        options={{ ...organizationSheetOptions, gestureEnabled: false }}
      />
      <Stack.Screen name="member-limit" options={organizationSheetOptions} />
      <Stack.Screen name="low-balance-alert" options={organizationSheetOptions} />
    </Stack>
  );
}
