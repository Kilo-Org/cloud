import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { McpGatewayDetailContent } from '@/app/(app)/cloud/mcp-gateway/McpGatewayDetailContent';

export default async function OrganizationMcpGatewayDetailPage({
  params,
}: {
  params: Promise<{ id: string; configId: string }>;
}) {
  const { id, configId } = await params;
  return (
    <OrganizationByPageLayout
      params={Promise.resolve({ id })}
      render={({ organization, isGlobalAdmin }) => {
        if (!isGlobalAdmin) notFound();
        return <McpGatewayDetailContent organizationId={organization.id} configId={configId} />;
      }}
    />
  );
}
