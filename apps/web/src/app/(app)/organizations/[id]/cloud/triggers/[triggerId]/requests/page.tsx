import { Suspense } from 'react';
import { WebhookRequestsContent } from '@/app/(app)/cloud/webhooks/[triggerId]/requests/WebhookRequestsContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationTriggerRequestsPage({
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
          <WebhookRequestsContent params={params} organizationId={organization.id} />
        </Suspense>
      )}
    />
  );
}
