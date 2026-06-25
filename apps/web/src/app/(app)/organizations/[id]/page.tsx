import { OrganizationDashboard } from '@/components/organizations/OrganizationDashboard';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { TOPUP_AMOUNT_QUERY_STRING_KEY } from '@/lib/organizations/constants';
import { isOrgAutoTopUpFeatureEnabled } from '@/lib/organizations/organization-auto-top-up';

export default async function OrganizationByIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const search = new URLSearchParams(await searchParams);
  const topupAmount = Number.parseFloat(search.get(TOPUP_AMOUNT_QUERY_STRING_KEY) || '0') || 0;

  return (
    <OrganizationByPageLayout
      params={params}
      render={async ({ role, organization, organizationRouteIdentifier }) => {
        const isAutoTopUpEnabled = await isOrgAutoTopUpFeatureEnabled(organization.id);
        return (
          <OrganizationDashboard
            organizationId={organization.id}
            organizationRouteIdentifier={organizationRouteIdentifier}
            role={role}
            topupAmount={topupAmount}
            isAutoTopUpEnabled={isAutoTopUpEnabled}
          />
        );
      }}
    />
  );
}
