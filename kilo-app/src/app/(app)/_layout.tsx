import { Stack } from 'expo-router';

import { useDeepLink } from '@/lib/hooks/use-deep-link';

export default function AppLayout() {
  useDeepLink();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[instance-id]" />
      <Stack.Screen
        name="profile"
        options={{
          presentation: 'modal',
          headerShown: false,
        }}
      />
    </Stack>
  );
}
