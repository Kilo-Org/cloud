import { OrganizationAdminDashboard } from '@/app/admin/components/OrganizationAdmin/OrganizationAdminDashboard';
import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';

export default async function OrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Check authentication first
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  // admins are always owners of every organization
  return <OrganizationAdminDashboard organizationId={organizationId} />;
}
