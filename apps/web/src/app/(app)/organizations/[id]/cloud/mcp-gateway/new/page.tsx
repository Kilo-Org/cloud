import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { McpGatewaySetupContent } from '@/app/(app)/cloud/mcp-gateway/McpGatewaySetupContent';

export default async function OrganizationMcpGatewaySetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, role, isGlobalAdmin }) => {
        if (!isGlobalAdmin && role !== 'owner') notFound();
        return <McpGatewaySetupContent organizationId={organization.id} />;
      }}
    />
  );
}
