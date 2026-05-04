import { Stack } from 'expo-router';

import { CHAT_STACK_ROUTE_NAME } from '@/lib/kilo-chat-routes';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function KiloClawLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name={CHAT_STACK_ROUTE_NAME} />
      <Stack.Screen
        name="chat/instance-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
    </Stack>
  );
}
