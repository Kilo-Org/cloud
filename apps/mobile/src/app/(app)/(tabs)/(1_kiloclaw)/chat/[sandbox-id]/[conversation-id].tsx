import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { toast } from 'sonner-native';

import { ChatSandboxRouteMounts } from '@/components/kilo-chat/chat-sandbox-route-mounts';
import { ConversationScreen } from '@/components/kilo-chat/conversation-screen';
import {
  getConversationRouteDecision,
  getConversationRouteErrorMessage,
  shouldRenderConversationScreen,
} from '@/components/kilo-chat/conversation-route-state';
import { useConversationDetail } from '@/components/kilo-chat/hooks/use-conversations';
import { useKiloChatClient } from '@/components/kilo-chat/hooks/use-kilo-chat-client';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

export default function ChatConversationRoute() {
  const params = useLocalSearchParams<{ 'sandbox-id': string; 'conversation-id': string }>();
  const sandboxId = params['sandbox-id'];
  const conversationId = params['conversation-id'];
  const router = useRouter();
  const client = useKiloChatClient();
  const conversationDetail = useConversationDetail(client, conversationId);
  const redirectPath = chatSandboxPath(sandboxId);
  const routeDecision = getConversationRouteDecision({
    detail: conversationDetail,
    routeSandboxId: sandboxId,
  });

  useEffect(() => {
    if (conversationDetail.isError) {
      toast.error(getConversationRouteErrorMessage(conversationDetail.error));
      router.replace(redirectPath);
      return;
    }
    if (routeDecision === 'not-found') {
      toast.error('Conversation not found');
      router.replace(redirectPath);
    }
  }, [conversationDetail.error, conversationDetail.isError, redirectPath, routeDecision, router]);

  if (
    !shouldRenderConversationScreen({
      detail: conversationDetail,
      routeSandboxId: sandboxId,
    }) ||
    !conversationDetail.data
  ) {
    return null;
  }

  return (
    <>
      <ChatSandboxRouteMounts activeConversationId={conversationId} />
      <ConversationScreen
        sandboxId={sandboxId}
        conversationId={conversationId}
        conversationTitle={conversationDetail.data.title ?? 'Untitled'}
        conversationRenameTitle={conversationDetail.data.title ?? ''}
        conversationMembers={conversationDetail.data.members}
      />
    </>
  );
}
