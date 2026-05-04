import { useLocalSearchParams } from 'expo-router';

import { ChatSandboxRouteMounts } from '@/components/kilo-chat/chat-sandbox-route-mounts';
import { ConversationListScreen } from '@/components/kilo-chat/conversation-list-screen';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';

export default function ChatSandboxIndex() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  const { data: instances } = useAllKiloClawInstances();
  const instance = instances?.find(i => i.sandboxId === sandboxId);
  const sandboxLabel = instance?.name ?? instance?.organizationName ?? 'Chat';
  return (
    <>
      <ChatSandboxRouteMounts />
      <ConversationListScreen sandboxId={sandboxId} sandboxLabel={sandboxLabel} />
    </>
  );
}
