import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgKiloCliRunClient } from './OrgKiloCliRunClient';

type OrgKiloCliRunPageProps = {
  params: Promise<{ id: string; runId: string }>;
};

export default async function OrgKiloCliRunPage({ params }: OrgKiloCliRunPageProps) {
  const { runId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgKiloCliRunClient organizationId={org.organization.id} runId={runId} />}
    />
  );
}
