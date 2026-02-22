import { SecurityAgentPageClient } from '@/components/security-agent';
import { PageContainer } from '@/components/layouts/PageContainer';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Dependabot security alerts',
};

export default async function SecurityAgentPage() {
  return (
    <PageContainer>
      <SecurityAgentPageClient />
    </PageContainer>
  );
}
