import { useLocalSearchParams } from 'expo-router';

import { ConversationListScreen } from '@/components/kilo-chat/conversation-list-screen';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';

export default function ChatSandboxIndex() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();
  const { data: instances } = useAllKiloClawInstances();
  const sandboxLabel = instances?.find(i => i.sandboxId === sandboxId)?.name ?? 'Chat';
  return <ConversationListScreen sandboxId={sandboxId} sandboxLabel={sandboxLabel} />;
}
