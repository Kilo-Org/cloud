import { Suspense } from 'react';
import { EditWebhookTriggerContent } from '@/app/(app)/cloud/webhooks/[triggerId]/EditWebhookTriggerContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationEditTriggerPage({
  params,
}: {
  params: Promise<{ id: string; triggerId: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <Suspense
          fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
        >
          <EditWebhookTriggerContent params={params} organizationId={organization.id} />
        </Suspense>
      )}
    />
  );
}
