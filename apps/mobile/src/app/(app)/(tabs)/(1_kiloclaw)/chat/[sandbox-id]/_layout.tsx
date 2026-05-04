import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { useInstanceEventSubscription } from '@/components/kilo-chat/hooks/use-instance-event-subscription';
import { setLastActiveInstance } from '@/lib/last-active-instance';

export function ChatSandboxInstanceEventSubscriptionMount() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  useInstanceEventSubscription(sandboxId);
  return null;
}

export function ChatSandboxLastActiveInstanceMount() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();

  useFocusEffect(
    useCallback(() => {
      if (sandboxId) {
        void setLastActiveInstance(sandboxId);
      }
    }, [sandboxId])
  );

  return null;
}

export default function ChatSandboxLayout() {
  return (
    <>
      <ChatSandboxInstanceEventSubscriptionMount />
      <ChatSandboxLastActiveInstanceMount />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="[conversation-id]" />
        <Stack.Screen
          name="rename-conversation"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.5],
            sheetGrabberVisible: true,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}
