'use client';

import { Suspense } from 'react';
import { PageContainer } from '@/components/layouts/PageContainer';
import { WebhookTriggersListContent } from '../webhooks/WebhookTriggersListContent';

export default function TriggersListPage() {
  return (
    <PageContainer>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
      >
        <WebhookTriggersListContent />
      </Suspense>
    </PageContainer>
  );
}
