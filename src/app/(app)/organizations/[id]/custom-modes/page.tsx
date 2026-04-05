import { CustomModesLayout } from '@/components/organizations/custom-modes/CustomModesLayout';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationCustomModesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <CustomModesLayout organizationId={organization.id} />}
    />
  );
}
