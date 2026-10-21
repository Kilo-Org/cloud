'use client';

import { Suspense } from 'react';
import { CloudChatPage } from '@/components/cloud-agent-next/CloudChatPage';
import type { KnownModel } from '@/components/cloud-agent-next/known-models';

type CloudChatPageWrapperNextProps = {
  currentUserId: string;
  knownModels: KnownModel[];
};

export function CloudChatPageWrapperNext({
  currentUserId,
  knownModels,
}: CloudChatPageWrapperNextProps) {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <CloudChatPage currentUserId={currentUserId} knownModels={knownModels} />
    </Suspense>
  );
}
