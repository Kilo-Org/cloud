import { useLocalSearchParams } from 'expo-router';

import { ConversationScreen } from '@/components/kilo-chat/conversation-screen';

export default function ConversationRoute() {
  const { 'sandbox-id': sandboxId, 'conversation-id': conversationId } = useLocalSearchParams<{
    'sandbox-id': string;
    'conversation-id': string;
  }>();

  return <ConversationScreen sandboxId={sandboxId} conversationId={conversationId} />;
}
