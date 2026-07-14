import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner-native';

import { captureEvent, SESSION_VIEWED_EVENT } from '@/lib/analytics/posthog';

import { ChatSandboxRouteMounts } from '@/components/kilo-chat/chat-sandbox-route-mounts';
import { ConversationScreen } from '@/components/kilo-chat/conversation-screen';
import {
  ConversationHistoryErrorView,
  ConversationHistoryLoadingView,
} from '@/components/kilo-chat/conversation-history-state-views';
import { getConversationRouteDecision } from '@/components/kilo-chat/conversation-route-state';
import { useConversationDetail } from '@/components/kilo-chat/hooks/use-conversations';
import { useKiloChatClient } from '@/components/kilo-chat/hooks/use-kilo-chat-client';
import { chatSandboxPath } from '@/lib/kilo-chat-routes';

export default function ChatConversationRoute() {
  const params = useLocalSearchParams<{
    'sandbox-id': string;
    'conversation-id': string;
    via?: string;
  }>();
  const sandboxId = params['sandbox-id'];
  const conversationId = params['conversation-id'];
  const openedVia = params.via === 'push' ? 'push' : 'app';
  const router = useRouter();
  const client = useKiloChatClient();
  const conversationDetail = useConversationDetail(client, conversationId);
  const redirectPath = chatSandboxPath(sandboxId);
  const routeDecision = getConversationRouteDecision({
    detail: {
      data: conversationDetail.data,
      error: conversationDetail.error,
      isError: conversationDetail.isError,
    },
    routeSandboxId: sandboxId,
  });

  const viewTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationDetail.data || viewTrackedRef.current === conversationId) {
      return;
    }
    viewTrackedRef.current = conversationId;
    captureEvent(SESSION_VIEWED_EVENT, { surface: 'claw', via: openedVia });
  }, [conversationDetail.data, conversationId, openedVia]);

  useEffect(() => {
    if (routeDecision === 'not-found') {
      toast.error('Conversation not found');
      router.replace(redirectPath);
    }
  }, [redirectPath, routeDecision, router]);

  if (routeDecision === 'pending') {
    return <ConversationHistoryLoadingView />;
  }

  if (routeDecision === 'retryable-error') {
    return (
      <ConversationHistoryErrorView
        message="Failed to load conversation"
        onRetry={() => {
          void conversationDetail.refetch();
        }}
      />
    );
  }

  if (routeDecision !== 'ready' || !conversationDetail.data) {
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
