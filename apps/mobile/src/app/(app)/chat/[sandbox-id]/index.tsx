import { useLocalSearchParams } from 'expo-router';

import { ConversationListScreen } from '@/components/kilo-chat/conversation-list-screen';

export default function SandboxChatIndex() {
  const { 'sandbox-id': sandboxId } = useLocalSearchParams<{ 'sandbox-id': string }>();

  return <ConversationListScreen sandboxId={sandboxId} />;
}
