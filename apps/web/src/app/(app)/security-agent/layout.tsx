import { SecurityAgentLayout } from '@/components/security-agent/SecurityAgentLayout';
import { SecurityAgentProvider } from '@/components/security-agent/SecurityAgentContext';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Security Findings synced from Dependabot',
};

export default function SecurityAgentRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <SecurityAgentProvider>
      <SecurityAgentLayout>{children}</SecurityAgentLayout>
    </SecurityAgentProvider>
  );
}
