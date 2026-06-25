import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { OrgKiloChatRootLayoutClient } from './OrgKiloChatRootLayoutClient';

type OrgKiloChatRootLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export default async function OrgKiloChatRootLayout({
  children,
  params,
}: OrgKiloChatRootLayoutProps) {
  const { organization, canonicalRouteIdentifier } =
    await requireCanonicalOrganizationRouteContext(params);

  return (
    <OrgKiloChatRootLayoutClient
      organizationId={organization.id}
      organizationRouteIdentifier={canonicalRouteIdentifier}
    >
      {children}
    </OrgKiloChatRootLayoutClient>
  );
}
