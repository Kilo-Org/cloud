import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgChatRootLayoutClient } from './OrgChatRootLayoutClient';

type OrgChatRootLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export default async function OrgChatRootLayout({ children, params }: OrgChatRootLayoutProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={org => (
        <OrgChatRootLayoutClient organizationId={org.organization.id}>
          {children}
        </OrgChatRootLayoutClient>
      )}
    />
  );
}
