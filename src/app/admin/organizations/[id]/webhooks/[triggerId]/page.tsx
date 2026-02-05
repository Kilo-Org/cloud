'use client';

import { Suspense } from 'react';
import { AdminWebhookTriggerDetails } from '@/app/admin/webhooks/AdminWebhookTriggerDetails';

type AdminOrganizationWebhookDetailPageProps = {
  params: Promise<{ id: string; triggerId: string }>;
};

export default function AdminOrganizationWebhookDetailPage({
  params,
}: AdminOrganizationWebhookDetailPageProps) {
  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <AdminWebhookTriggerDetails params={params} scope="organization" />
    </Suspense>
  );
}
