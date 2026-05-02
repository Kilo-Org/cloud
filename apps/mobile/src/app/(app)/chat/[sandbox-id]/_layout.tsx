import { Stack, useLocalSearchParams } from 'expo-router';

import { useInstanceEventSubscription } from '@/components/kilo-chat/hooks/use-instance-event-subscription';

export function ChatSandboxInstanceEventSubscriptionMount() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  useInstanceEventSubscription(sandboxId);
  return null;
}

export default function ChatSandboxLayout() {
  return (
    <>
      <ChatSandboxInstanceEventSubscriptionMount />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
