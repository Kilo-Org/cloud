import { Stack } from 'expo-router';

import { useFormSheetDetents } from '@/lib/form-sheet';

export default function OrganizationLayout() {
  const { fullSheetDetent } = useFormSheetDetents();

  const sheetOptions = {
    presentation: 'formSheet' as const,
    sheetAllowedDetents: [0.5, fullSheetDetent] as [number, number],
    sheetGrabberVisible: true,
    headerShown: false,
  };

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="invite-member" options={sheetOptions} />
      <Stack.Screen name="member-limit" options={sheetOptions} />
      <Stack.Screen name="low-balance-alert" options={sheetOptions} />
    </Stack>
  );
}
