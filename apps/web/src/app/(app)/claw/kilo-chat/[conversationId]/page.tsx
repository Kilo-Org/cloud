'use client';

import { useParams } from 'next/navigation';
import { useKiloChatContext } from '../components/KiloChatLayout';
import { MessageArea } from '../components/MessageArea';

export default function KiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const { getToken, currentUserId, instanceStatus, leavingConversationId } = useKiloChatContext();

  // Don't render (or fire queries) for a conversation we're leaving
  if (leavingConversationId === params.conversationId) {
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
