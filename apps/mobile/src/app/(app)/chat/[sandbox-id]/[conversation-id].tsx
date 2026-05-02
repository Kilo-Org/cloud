import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { toast } from 'sonner-native';

import { ConversationScreen } from '@/components/kilo-chat/conversation-screen';
import {
  getConversationRouteErrorMessage,
  shouldRenderConversationScreen,
} from '@/components/kilo-chat/conversation-route-state';
import { useConversationDetail } from '@/components/kilo-chat/hooks/use-conversations';
import { useKiloChatClient } from '@/components/kilo-chat/hooks/use-kilo-chat-client';

export default function ChatConversationRoute() {
  const params = useLocalSearchParams<{ 'sandbox-id': string; 'conversation-id': string }>();
  const sandboxId = params['sandbox-id'];
  const conversationId = params['conversation-id'];
  const router = useRouter();
  const client = useKiloChatClient();
  const conversationDetail = useConversationDetail(client, conversationId);
  const redirectPath = `/(app)/chat/${sandboxId}` as Href;

  useEffect(() => {
    if (!conversationDetail.isError) {
      return;
    }
    toast.error(getConversationRouteErrorMessage(conversationDetail.error));
    router.replace(redirectPath);
  }, [conversationDetail.isError, conversationDetail.error, redirectPath, router]);

  if (!shouldRenderConversationScreen(conversationDetail)) {
    return null;
  }

  return (
    <ConversationScreen
      sandboxId={sandboxId}
      conversationId={conversationId}
      conversationTitle={conversationDetail.data.title ?? 'Untitled'}
    />
  );
}
