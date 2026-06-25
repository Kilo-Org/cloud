import { Suspense } from 'react';
import { CloudAgentProvider } from '@/components/cloud-agent-next/CloudAgentProvider';
import { CloudSidebarLayout } from '@/components/cloud-agent-next/CloudSidebarLayout';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

export default async function OrgCloudAgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { organization, canonicalRouteIdentifier } =
    await requireCanonicalOrganizationRouteContext(params);

  return (
    <CloudAgentProvider organizationId={organization.id}>
      <Suspense fallback={<div className="flex h-dvh items-center justify-center">Loading...</div>}>
        <CloudSidebarLayout
          organizationId={organization.id}
          organizationRouteIdentifier={canonicalRouteIdentifier}
        >
          {children}
        </CloudSidebarLayout>
      </Suspense>
    </CloudAgentProvider>
  );
}
