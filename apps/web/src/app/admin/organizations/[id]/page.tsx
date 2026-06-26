import { OrganizationAdminDashboard } from '@/app/admin/components/OrganizationAdmin/OrganizationAdminDashboard';
import { resolveOrganizationRouteIdentifierDetails } from '@/lib/organizations/organization-route-utils.server';
import { getUserFromAuth } from '@/lib/user/server';
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
  const organization = await resolveOrganizationRouteIdentifierDetails(decodeURIComponent(id));
  if (!organization) {
    redirect('/admin/organizations');
  }

  if (decodeURIComponent(id) !== organization.routeIdentifier) {
    redirect(`/admin/organizations/${encodeURIComponent(organization.routeIdentifier)}`);
  }

  // admins are always owners of every organization
  return <OrganizationAdminDashboard organizationId={organization.id} />;
}
