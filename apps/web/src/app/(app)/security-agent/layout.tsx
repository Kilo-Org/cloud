import { SecurityAgentLayout } from '@/components/security-agent/SecurityAgentLayout';
import { SecurityAgentProvider } from '@/components/security-agent/SecurityAgentContext';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export const metadata = {
  title: 'Security Agent | Kilo Code',
  description: 'Monitor and manage Security Findings synced from Dependabot',
};

export default async function SecurityAgentRootLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();

  return (
    <SecurityAgentProvider>
      <SecurityAgentLayout>{children}</SecurityAgentLayout>
    </SecurityAgentProvider>
  );
}
