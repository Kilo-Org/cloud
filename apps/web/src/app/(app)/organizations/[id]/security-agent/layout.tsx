import { PageContainer } from '@/components/layouts/PageContainer';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SecurityAgentLayout } from '@/components/security-agent/SecurityAgentLayout';
import { SecurityAgentProvider } from '@/components/security-agent/SecurityAgentContext';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Dependabot security alerts',
};

type LayoutProps = {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
};

export default async function OrgSecurityAgentLayout({ params, children }: LayoutProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <PageContainer>
          <SecurityAgentProvider organizationId={organization.id}>
            <SecurityAgentLayout>{children}</SecurityAgentLayout>
          </SecurityAgentProvider>
        </PageContainer>
      )}
    />
  );
}
