'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { useKiloChatContext } from '@/app/(app)/claw/kilo-chat/components/kiloChatContext';
import { KiloChatStatusError } from '@/app/(app)/claw/kilo-chat/components/KiloChatStatusError';
import { kiloChatInstanceRouteDecision } from '@/app/(app)/claw/kilo-chat/[conversationId]/conversation-route-guard';

export default function ChatIndexPage() {
  const router = useRouter();
  const {
    instanceErrorMessage,
    instanceStatus,
    isInstanceError,
    isInstanceLoading,
    noInstanceRedirect,
    onRetryInstanceStatus,
  } = useKiloChatContext();
  const routeDecision = kiloChatInstanceRouteDecision({
    instanceStatus,
    isInstanceError,
    isInstanceLoading,
  });

  useEffect(() => {
    if (routeDecision === 'redirect-no-instance') {
      router.replace(noInstanceRedirect);
    }
  }, [noInstanceRedirect, routeDecision, router]);

  if (routeDecision === 'status-error') {
    return <KiloChatStatusError message={instanceErrorMessage} onRetry={onRetryInstanceStatus} />;
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <MessagesSquare className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">Select a conversation or start a new one</p>
      </div>
    </div>
  );
}
