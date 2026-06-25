import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user/server';
import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
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
  const result = await getAuthorizedOrgContext(organizationId, ['owner', 'billing_manager']);
  if (!result.success) {
    const href =
      result.nextResponse.status === 401 ? await signInUrlWithCallbackPath() : '/profile';
    redirect(href);
  }
  const { user } = result.data;
  return (
    <OrganizationContextProvider value={{ userRole: user.role, isKiloAdmin: user.is_admin }}>
      {children}
    </OrganizationContextProvider>
  );
}
