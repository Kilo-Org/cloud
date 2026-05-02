'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { KiloChatApiError } from '@kilocode/kilo-chat';
import { useKiloChatContext } from '../components/kiloChatContext';
import { useConversationDetail } from '../hooks/useConversations';
import { MessageArea } from '../components/MessageArea';
import { conversationRouteDecision } from './conversation-route-guard';

export default function KiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();
  const {
    kiloChatClient,
    leavingConversationId,
    basePath,
    sandboxId,
    isInstanceLoading,
    noInstanceRedirect,
  } = useKiloChatContext();
  const isLeaving = leavingConversationId === params.conversationId;
  const conversationDetail = useConversationDetail(
    kiloChatClient,
    isLeaving ? null : params.conversationId
  );
  const routeDecision = conversationRouteDecision({
    conversationMembers: conversationDetail.data?.members,
    isInstanceLoading,
    isLeaving,
    routeSandboxId: sandboxId,
  });

  useEffect(() => {
    if (routeDecision === 'redirect-no-instance') {
      router.replace(noInstanceRedirect);
      return;
    }
    if (routeDecision === 'not-found') {
      toast.error('Conversation not found');
      router.replace(basePath);
      return;
    }
    if (conversationDetail.isError && !isLeaving) {
      const status =
        conversationDetail.error instanceof KiloChatApiError
          ? conversationDetail.error.status
          : undefined;
      const message =
        status === 400 || status === 403 || status === 404
          ? 'Conversation not found'
          : 'Failed to load conversation';
      toast.error(message);
      router.replace(basePath);
    }
  }, [
    conversationDetail.isError,
    conversationDetail.error,
    isLeaving,
    router,
    basePath,
    noInstanceRedirect,
    routeDecision,
  ]);

  if (isLeaving || routeDecision !== 'ready') {
    return null;
  }

  if (conversationDetail.isError) {
    return null;
  }

  return <MessageArea key={params.conversationId} conversationId={params.conversationId} />;
}
