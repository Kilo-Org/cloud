import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { CloudNextSessionsPage } from '@/components/cloud-agent-next/CloudNextSessionsPage';

export default async function OrganizationCloudPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <CloudNextSessionsPage organizationId={organization.id} />}
    />
  );
}
