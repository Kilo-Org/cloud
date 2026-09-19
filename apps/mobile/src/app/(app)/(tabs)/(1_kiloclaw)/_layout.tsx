import { Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { FormSheetStackLaidOutContext, useFormSheetDetents } from '@/lib/form-sheet';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function KiloClawLayout() {
  // Native formSheets handle the top safe area, so PickerSheet's header does
  // not add its own top clearance.
  const { fullSheetDetent } = useFormSheetDetents();
  // Flipped by this stack's first layout. A formSheet opened before that (a
  // deep link straight into the picker on a cold tab) was created against a
  // not-yet-measured stack; the sheet reads this and re-presents itself once.
  const [laidOut, setLaidOut] = useState(false);
  const handleLayout = useCallback(() => {
    setLaidOut(true);
  }, []);
  return (
    <FormSheetStackLaidOutContext.Provider value={laidOut}>
      <View className="flex-1" onLayout={handleLayout}>
        <Stack screenLayout={appUnlockScreenLayout} screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen
            name="chat/instance-picker"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.5, fullSheetDetent],
              sheetGrabberVisible: true,
              headerShown: false,
            }}
          />
        </Stack>
      </View>
    </FormSheetStackLaidOutContext.Provider>
  );
}
