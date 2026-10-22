import { Stack } from 'expo-router';
import { appScreenLayout } from '@/components/app-screen-layout';

import { useFormSheetScreenOptions } from '@/lib/form-sheet';

export default function OrganizationLayout() {
  const sheetOptions = useFormSheetScreenOptions();

  return (
    <Stack screenLayout={appScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="invite-member" options={{ ...sheetOptions, gestureEnabled: false }} />
      <Stack.Screen name="member-limit" options={sheetOptions} />
      <Stack.Screen name="low-balance-alert" options={sheetOptions} />
    </Stack>
  );
}
