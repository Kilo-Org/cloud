'use client';

import { Suspense } from 'react';
import { PageContainer } from '@/components/layouts/PageContainer';
import { CreateWebhookTriggerContent } from '../../webhooks/new/CreateWebhookTriggerContent';

export default function CreateTriggerPage() {
  return (
    <PageContainer>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
      >
        <CreateWebhookTriggerContent />
      </Suspense>
    </PageContainer>
  );
}
