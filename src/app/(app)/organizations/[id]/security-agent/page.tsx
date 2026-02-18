import { SecurityAgentPageClient } from '@/components/security-agent';
import { PageContainer } from '@/components/layouts/PageContainer';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Dependabot security alerts',
};

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationSecurityAgentPage({ params }: PageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, isGlobalAdmin }) => (
        <PageContainer>
          <SecurityAgentPageClient organizationId={organization.id} isAdmin={isGlobalAdmin} />
        </PageContainer>
      )}
    />
  );
}
