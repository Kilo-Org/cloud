import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationPaymentDetails } from '@/components/organizations/OrganizationPaymentDetails';
import { isOrgAutoTopUpFeatureEnabled } from '@/lib/organizations/organization-auto-top-up';

export default async function OrganizationPaymentDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: organizationId } = await params;
  const isAutoTopUpEnabled = await isOrgAutoTopUpFeatureEnabled(organizationId);

  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ role, organization }) => (
        <OrganizationPaymentDetails
          organizationId={organization.id}
          role={role}
          isAutoTopUpEnabled={isAutoTopUpEnabled}
        />
      )}
    />
  );
}
