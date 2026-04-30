import { useLocalSearchParams } from 'expo-router';

import { ConversationScreen } from '@/components/kilo-chat/conversation-screen';
import { useConversationDetail } from '@/components/kilo-chat/hooks/use-conversations';
import { useKiloChatClient } from '@/components/kilo-chat/hooks/use-kilo-chat-client';

export default function ChatConversationRoute() {
  const params = useLocalSearchParams<{ 'sandbox-id': string; 'conversation-id': string }>();
  const sandboxId = params['sandbox-id'];
  const conversationId = params['conversation-id'];
  const client = useKiloChatClient();
  const { data } = useConversationDetail(client, conversationId);
  return (
    <ConversationScreen
      sandboxId={sandboxId}
      conversationId={conversationId}
      conversationTitle={data?.title ?? 'Untitled'}
    />
  );
}
