'use client';

import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';

export function CloudChatPageWrapper() {
  return (
    <CloudAgentProvider>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
      >
        <CloudChatPage />
      </Suspense>
    </CloudAgentProvider>
  );
}
