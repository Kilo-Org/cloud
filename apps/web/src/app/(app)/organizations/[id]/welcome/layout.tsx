import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

export default async function WelcomeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { user } = await requireCanonicalOrganizationRouteContext(params, [
    'owner',
    'billing_manager',
  ]);

  return (
    <OrganizationContextProvider value={{ userRole: user.role, isKiloAdmin: user.is_admin }}>
      {children}
    </OrganizationContextProvider>
  );
}
