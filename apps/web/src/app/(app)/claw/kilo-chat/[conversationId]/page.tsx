'use client';

import { useParams } from 'next/navigation';

// Placeholder — Task 12 will wire this to MessageArea via useKiloChatContext
export default function KiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground text-sm">
        Conversation: {params.conversationId}
      </p>
    </div>
  );
}
