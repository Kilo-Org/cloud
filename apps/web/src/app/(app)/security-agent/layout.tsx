import { PageContainer } from '@/components/layouts/PageContainer';
import { SecurityAgentLayout } from '@/components/security-agent/SecurityAgentLayout';
import { SecurityAgentProvider } from '@/components/security-agent/SecurityAgentContext';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Dependabot security alerts',
};

export default function SecurityAgentRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <PageContainer>
      <SecurityAgentProvider>
        <SecurityAgentLayout>{children}</SecurityAgentLayout>
      </SecurityAgentProvider>
    </PageContainer>
  );
}
