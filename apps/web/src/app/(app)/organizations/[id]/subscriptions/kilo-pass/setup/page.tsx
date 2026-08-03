import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgKiloPassSetup } from '@/components/subscriptions/org-kilo-pass/OrgKiloPassSetup';

export default async function OrganizationKiloPassSetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => (
        <OrgKiloPassSetup organizationId={organization.id} organizationName={organization.name} />
      )}
    />
  );
}
