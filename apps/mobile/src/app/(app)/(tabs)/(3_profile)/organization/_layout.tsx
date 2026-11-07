import { Stack } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

import { appScreenLayout } from '@/components/app-screen-layout';

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
    <Stack screenLayout={appScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen
        name="invite-member"
        options={{
          ...organizationSheetOptions,
          // The invite form auto-focuses its email field, so the keyboard opens
          // while the sheet is still at the half detent and covers the field
          // and the role list. The fields sit at the sheet's top, so a half
          // sheet cannot keep them above the IME: one full detent keeps the
          // form above the keyboard and the dismissal inside the sheet, the
          // same single-detent layout every other Android formSheet with a
          // focused input carries.
          ...(Platform.OS === 'android'
            ? { sheetAllowedDetents: [sheetOptions.sheetAllowedDetents[1]] }
            : {}),
          gestureEnabled: false,
        }}
      />
      <Stack.Screen name="member-limit" options={organizationSheetOptions} />
      <Stack.Screen name="low-balance-alert" options={organizationSheetOptions} />
    </Stack>
  );
}
