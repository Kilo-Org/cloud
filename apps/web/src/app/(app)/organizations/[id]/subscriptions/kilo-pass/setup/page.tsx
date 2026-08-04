import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgKiloPassSetup } from '@/components/subscriptions/org-kilo-pass/OrgKiloPassSetup';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

export default async function OrganizationKiloPassSetupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => (
        <OrgKiloPassSetup organizationId={organization.id} organizationName={organization.name} />
      )}
    />
  );
}
