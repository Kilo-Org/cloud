import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function OrgCloudAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user] = await Promise.all([params, getUserFromAuthOrRedirect()]);
  const organizationId = decodeURIComponent(id);

  return (
    <CloudAgentProvider organizationId={organizationId}>
      <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
        <CloudSidebarLayout currentUserId={user.id} organizationId={organizationId}>
          {children}
        </CloudSidebarLayout>
      </Suspense>
    </CloudAgentProvider>
  );
}
