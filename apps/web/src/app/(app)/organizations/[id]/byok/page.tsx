import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { BYOKContent } from '@/components/organizations/BYOKContent';

export default async function OrganizationBYOKPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => (
        <BYOKContent organizationId={organization.id} role={role} />
      )}
    />
  );
}
