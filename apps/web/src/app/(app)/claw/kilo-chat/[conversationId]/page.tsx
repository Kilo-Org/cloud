'use client';

import { useParams } from 'next/navigation';
import { useKiloChatContext } from '../components/KiloChatLayout';
import { MessageArea } from '../components/MessageArea';

export default function KiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const { getToken, currentUserId, token } = useKiloChatContext();

  return (
    <MessageArea
      conversationId={params.conversationId}
      currentUserId={currentUserId}
      getToken={getToken}
      token={token}
    />
  );
}
