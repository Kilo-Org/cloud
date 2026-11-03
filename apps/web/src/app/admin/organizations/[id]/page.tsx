import { OrganizationAdminDashboard } from '@/app/admin/components/OrganizationAdmin/OrganizationAdminDashboard';
import { requireAdminPage, AdminStepUpGate } from '@/lib/admin/require-admin-page';

export default async function OrganizationDetailPage({
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
  // admins are always owners of every organization
  return <OrganizationAdminDashboard organizationId={organizationId} />;
}
