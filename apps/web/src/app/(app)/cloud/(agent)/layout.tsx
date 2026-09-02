import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function CloudAgentLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserFromAuthOrRedirect();

  return (
    <CloudAgentProvider>
      <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
        <CloudSidebarLayout currentUserId={user.id}>{children}</CloudSidebarLayout>
      </Suspense>
    </CloudAgentProvider>
  );
}
