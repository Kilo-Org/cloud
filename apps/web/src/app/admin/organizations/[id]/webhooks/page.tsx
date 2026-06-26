import { getUserFromAuth } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { AdminWebhookTriggersList } from '@/app/admin/webhooks/AdminWebhookTriggersList';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { getOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils';
import { resolveOrganizationRouteIdentifierDetails } from '@/lib/organizations/organization-route-utils.server';

export default async function AdminOrganizationWebhooksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const resolvedOrganization = await resolveOrganizationRouteIdentifierDetails(
    decodeURIComponent(id)
  );
  if (!resolvedOrganization) {
    redirect('/admin/organizations');
  }

  if (decodeURIComponent(id) !== resolvedOrganization.routeIdentifier) {
    redirect(
      `/admin/organizations/${encodeURIComponent(resolvedOrganization.routeIdentifier)}/webhooks`
    );
  }

  const organization = await db.query.organizations.findFirst({
    columns: {
      id: true,
      name: true,
      slug: true,
    },
    where: eq(organizations.id, resolvedOrganization.id),
  });

  if (!organization) {
    redirect('/admin/organizations');
  }

  const routeIdentifier = getOrganizationRouteIdentifier(organization);

  return (
    <AdminWebhookTriggersList
      organizationId={organization.id}
      label={organization.name}
      backHref={`/admin/organizations/${encodeURIComponent(routeIdentifier)}`}
      detailBasePath={`/admin/organizations/${encodeURIComponent(routeIdentifier)}/webhooks`}
    />
  );
}
