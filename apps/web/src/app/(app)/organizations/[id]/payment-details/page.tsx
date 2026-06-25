import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationPaymentDetails } from '@/components/organizations/OrganizationPaymentDetails';
import { isOrgAutoTopUpFeatureEnabled } from '@/lib/organizations/organization-auto-top-up';

export default async function OrganizationPaymentDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={async ({ role, organization }) => {
        const isAutoTopUpEnabled = await isOrgAutoTopUpFeatureEnabled(organization.id);
        return (
          <OrganizationPaymentDetails
            organizationId={organization.id}
            role={role}
            isAutoTopUpEnabled={isAutoTopUpEnabled}
          />
        );
      }}
    />
  );
}
