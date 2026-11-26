import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { AdminStepUpGate } from '@/lib/admin/require-admin-page';
import { AdminAccessDenied } from '@/app/admin/components/AdminAccessDenied';
import { adminNetworkRefusalFor } from '@kilocode/web-shared/lib/admin/admin-network';
import { signInUrlWithCallbackPath } from '@kilocode/web-shared/lib/user/server';
import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { redirect } from 'next/navigation';

export default async function WelcomeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const result = await getAuthorizedOrgContext(organizationId, ORGANIZATION_BILLING_ROLES, {
    surface: 'server-component',
  });
  if (!result.success) {
    if (result.nextResponse.status === 401) redirect(await signInUrlWithCallbackPath());
    // A staff grant that needs a fresh proof renders the ceremony, not a redirect.
    if (result.stepUp) return <AdminStepUpGate requirement={result.stepUp} />;
    // Staff off the admin network get the admin refusal, not a generic redirect.
    if (result.adminNetworkDenial) {
      return (
        <AdminAccessDenied message={adminNetworkRefusalFor(result.adminNetworkDenial).message} />
      );
    }
    redirect('/profile');
  }
  const { user } = result.data;
  return (
    <OrganizationContextProvider value={{ userRole: user.role, isKiloAdmin: user.is_admin }}>
      {children}
    </OrganizationContextProvider>
  );
}
