import { useLocalSearchParams } from 'expo-router';

import { ChatSandboxRouteMounts } from '@/components/kilo-chat/chat-sandbox-route-mounts';
import { ConversationListScreen } from '@/components/kilo-chat/conversation-list-screen';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';

export default function ChatSandboxIndex() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  const { data: instances, isPending: instancesPending } = useAllKiloClawInstances();
  const instance = instances?.find(i => i.sandboxId === sandboxId);
  // Blank until instances resolve — never show a "KiloClaw" placeholder that
  // then flashes to the real instance name once the query settles.
  const sandboxLabel = instancesPending
    ? ''
    : (instance?.botName ?? instance?.name ?? instance?.organizationName ?? 'KiloClaw');
  return (
    <>
      <ChatSandboxRouteMounts />
      <ConversationListScreen sandboxId={sandboxId} sandboxLabel={sandboxLabel} />
    </>
  );
}
