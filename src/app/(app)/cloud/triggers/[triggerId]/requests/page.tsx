'use client';

import { Suspense } from 'react';
import { PageContainer } from '@/components/layouts/PageContainer';
import { WebhookRequestsContent } from '../../../webhooks/[triggerId]/requests/WebhookRequestsContent';

type TriggerRequestsPageProps = {
  params: Promise<{ triggerId: string }>;
};

export default function TriggerRequestsPage({ params }: TriggerRequestsPageProps) {
  return (
    <PageContainer>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
      >
        <WebhookRequestsContent params={params} />
      </Suspense>
    </PageContainer>
  );
}
