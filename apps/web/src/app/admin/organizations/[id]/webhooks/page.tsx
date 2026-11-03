import { requireAdminPage, AdminStepUpGate } from '@/lib/admin/require-admin-page';
import { redirect } from 'next/navigation';
import { AdminWebhookTriggersList } from '@/app/admin/webhooks/AdminWebhookTriggersList';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export default async function AdminOrganizationWebhooksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const adminAccess = await requireAdminPage();
  if (!adminAccess.user) {
    return <AdminStepUpGate requirement={adminAccess.stepUp} />;
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
