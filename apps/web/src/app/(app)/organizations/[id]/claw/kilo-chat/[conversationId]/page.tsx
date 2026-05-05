'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function OrgLegacyKiloChatConversationPage() {
  const params = useParams<{ id: string; conversationId: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/organizations/${params.id}/claw/chat/${params.conversationId}`);
  }, [params.conversationId, params.id, router]);

  return null;
}
