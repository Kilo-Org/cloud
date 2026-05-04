import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { useInstanceEventSubscription } from '@/components/kilo-chat/hooks/use-instance-event-subscription';
import { setLastActiveInstance } from '@/lib/last-active-instance';

export function ChatSandboxInstanceEventSubscriptionMount() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  useInstanceEventSubscription(sandboxId);
  return null;
}

function ChatSandboxLastActiveInstanceMount() {
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

export function ChatSandboxRouteMounts() {
  return (
    <>
      <ChatSandboxInstanceEventSubscriptionMount />
      <ChatSandboxLastActiveInstanceMount />
    </>
  );
}
