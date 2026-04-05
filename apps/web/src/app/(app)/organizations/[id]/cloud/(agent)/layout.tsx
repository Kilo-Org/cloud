import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';

export default async function OrgCloudAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  return (
    <CloudAgentProvider organizationId={organizationId}>
      <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
        <CloudSidebarLayout organizationId={organizationId}>{children}</CloudSidebarLayout>
      </Suspense>
    </CloudAgentProvider>
  );
}
