import { Stack } from 'expo-router';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function AppLayout() {
  const colors = useThemeColors();

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.background },
        headerShown: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[instance-id]" />
      <Stack.Screen
        name="chat/instance-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
      <Stack.Screen name="agent-chat/new" options={{ headerShown: false }} />
      <Stack.Screen name="agent-chat/[session-id]" />
      <Stack.Screen
        name="agent-chat/model-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="agent-chat/repo-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5, 1],
          sheetGrabberVisible: true,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="agent-chat/mode-picker"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: [0.5],
          sheetGrabberVisible: true,
          headerShown: true,
          title: 'Select Mode',
        }}
      />
      <Stack.Screen
        name="profile"
        options={{
          presentation: 'modal',
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="onboarding"
        options={{
          presentation: 'modal',
          headerShown: false,
          gestureEnabled: false,
        }}
      />
    </Stack>
  );
}
