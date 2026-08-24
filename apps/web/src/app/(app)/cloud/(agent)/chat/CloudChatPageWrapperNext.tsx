'use client';

import { Suspense } from 'react';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';

export function CloudChatPageWrapperNext({ currentUserId }: { currentUserId: string }) {
  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <CloudChatPage currentUserId={currentUserId} />
    </Suspense>
  );
}
