import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';
import { AdminWebhookTriggersList } from '@/app/admin/webhooks/AdminWebhookTriggersList';
import { db } from '@/lib/drizzle';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';

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
  const organizationId = decodeURIComponent(id);

  const organization = await db.query.organizations.findFirst({
    columns: {
      id: true,
      name: true,
    },
    where: eq(organizations.id, organizationId),
  });

  if (!organization) {
    redirect('/admin/organizations');
  }

  return (
    <AdminWebhookTriggersList
      organizationId={organization.id}
      label={organization.name}
      backHref={`/admin/organizations/${encodeURIComponent(organization.id)}`}
      detailBasePath={`/admin/organizations/${encodeURIComponent(organization.id)}/webhooks`}
    />
  );
}
