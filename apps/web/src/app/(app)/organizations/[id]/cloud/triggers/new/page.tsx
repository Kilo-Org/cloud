import { Suspense } from 'react';
import { CreateWebhookTriggerContent } from '@/app/(app)/cloud/webhooks/new/CreateWebhookTriggerContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationCreateTriggerPage({
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
          <CreateWebhookTriggerContent organizationId={organization.id} />
        </Suspense>
      )}
    />
  );
}
