import { Stack } from 'expo-router';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';

import { useFormSheetScreenOptions } from '@/lib/form-sheet';

export default function OrganizationLayout() {
  const sheetOptions = useFormSheetScreenOptions();

  return (
    <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="invite-member" options={sheetOptions} />
      <Stack.Screen name="member-limit" options={sheetOptions} />
      <Stack.Screen name="low-balance-alert" options={sheetOptions} />
    </Stack>
  );
}
