import { Suspense } from 'react';
import { AdminWebhookTriggerDetails } from '@/app/admin/webhooks/AdminWebhookTriggerDetails';
import { resolveOrganizationRouteIdentifierDetails } from '@/lib/organizations/organization-route-utils.server';
import { redirect } from 'next/navigation';

type AdminOrganizationWebhookDetailPageProps = {
  params: Promise<{ id: string; triggerId: string }>;
};

export default async function AdminOrganizationWebhookDetailPage({
  params,
}: AdminOrganizationWebhookDetailPageProps) {
  const { id, triggerId } = await params;
  const organization = await resolveOrganizationRouteIdentifierDetails(decodeURIComponent(id));
  if (!organization) {
    redirect('/admin/organizations');
  }

  if (decodeURIComponent(id) !== organization.routeIdentifier) {
    redirect(
      `/admin/organizations/${encodeURIComponent(organization.routeIdentifier)}/webhooks/${encodeURIComponent(triggerId)}`
    );
  }

  const resolvedParams = Promise.resolve({ id: organization.id, triggerId });

  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <AdminWebhookTriggerDetails
        params={resolvedParams}
        scope="organization"
        ownerRouteIdentifier={organization.routeIdentifier}
      />
    </Suspense>
  );
}
