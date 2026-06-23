import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { McpGatewayListContent } from '@/app/(app)/cloud/mcp-gateway/McpGatewayListContent';

export default async function OrganizationMcpGatewayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, role, isGlobalAdmin }) => {
        if (!isGlobalAdmin && role !== 'owner') notFound();
        return <McpGatewayListContent organizationId={organization.id} />;
      }}
    />
  );
}
