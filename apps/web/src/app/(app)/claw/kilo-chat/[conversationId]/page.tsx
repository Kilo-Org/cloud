'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function LegacyKiloChatConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/claw/chat/${params.conversationId}`);
  }, [params.conversationId, router]);

  return null;
}
