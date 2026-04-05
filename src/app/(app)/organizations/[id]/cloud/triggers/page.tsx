import { Suspense } from 'react';
import { WebhookTriggersListContent } from '@/app/(app)/cloud/webhooks/WebhookTriggersListContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationTriggersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <Suspense
          fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
        >
          <WebhookTriggersListContent organizationId={organization.id} />
        </Suspense>
      )}
    />
  );
}
