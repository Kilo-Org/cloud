import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { useInstanceEventSubscription } from '@/components/kilo-chat/hooks/use-instance-event-subscription';
import { setLastActiveInstance } from '@/lib/last-active-instance';

type ChatSandboxRouteMountsProps = {
  activeConversationId?: string | null;
};

export function ChatSandboxInstanceEventSubscriptionMount({
  activeConversationId = null,
}: ChatSandboxRouteMountsProps = {}) {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  useInstanceEventSubscription(sandboxId, activeConversationId);
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

export function ChatSandboxRouteMounts({
  activeConversationId = null,
}: ChatSandboxRouteMountsProps) {
  return (
    <>
      <ChatSandboxInstanceEventSubscriptionMount activeConversationId={activeConversationId} />
      <ChatSandboxLastActiveInstanceMount />
    </>
  );
}
