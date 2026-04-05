'use client';

import { Suspense } from 'react';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';

type CloudChatPageWrapperNextProps = {
  organizationId: string;
};

export function CloudChatPageWrapperNext({ organizationId }: CloudChatPageWrapperNextProps) {
  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <CloudChatPage organizationId={organizationId} />
    </Suspense>
  );
}
