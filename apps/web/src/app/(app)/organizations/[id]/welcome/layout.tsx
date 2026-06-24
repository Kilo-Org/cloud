import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user/server';
import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
import { WelcomeAccessRedirect } from '@/components/organizations/welcome/WelcomeAccessRedirect';

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
    return <WelcomeAccessRedirect href={href} />;
  }
  const { user } = result.data;
  return (
    <OrganizationContextProvider value={{ userRole: user.role, isKiloAdmin: user.is_admin }}>
      {children}
    </OrganizationContextProvider>
  );
}
