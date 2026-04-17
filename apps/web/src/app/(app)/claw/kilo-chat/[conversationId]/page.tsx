'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useKiloChatContext } from '../components/KiloChatLayout';
import { useConversationDetail } from '../hooks/useConversations';
import { MessageArea } from '../components/MessageArea';

export default function KiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();
  const { getToken, currentUserId, instanceStatus, leavingConversationId } = useKiloChatContext();
  const isLeaving = leavingConversationId === params.conversationId;
  const conversationDetail = useConversationDetail(
    getToken,
    isLeaving ? null : params.conversationId
  );

  useEffect(() => {
    if (conversationDetail.isError && !isLeaving) {
      toast.error('Conversation not found');
      router.replace('/claw/kilo-chat');
    }
  }, [conversationDetail.isError, isLeaving, router]);

  if (isLeaving) {
    return null;
  }

  if (conversationDetail.isError) {
    return null;
  }

  return (
    <MessageArea
      conversationId={params.conversationId}
      currentUserId={currentUserId}
      getToken={getToken}
      instanceStatus={instanceStatus}
    />
  );
}
