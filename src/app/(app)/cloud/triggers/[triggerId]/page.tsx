'use client';

import { Suspense } from 'react';
import { PageContainer } from '@/components/layouts/PageContainer';
import { EditWebhookTriggerContent } from '../../webhooks/[triggerId]/EditWebhookTriggerContent';

type EditTriggerPageProps = {
  params: Promise<{ triggerId: string }>;
};

export default function EditTriggerPage({ params }: EditTriggerPageProps) {
  return (
    <PageContainer>
      <Suspense
        fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
      >
        <EditWebhookTriggerContent params={params} />
      </Suspense>
    </PageContainer>
  );
}
