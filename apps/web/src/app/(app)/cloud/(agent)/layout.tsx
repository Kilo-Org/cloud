import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';

export default function CloudAgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <CloudAgentProvider>
      <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
        <CloudSidebarLayout>{children}</CloudSidebarLayout>
      </Suspense>
    </CloudAgentProvider>
  );
}
