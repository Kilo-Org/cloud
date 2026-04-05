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
  const { id: organizationId } = await params;
  const search = new URLSearchParams(await searchParams);
  const topupAmount = Number.parseFloat(search.get(TOPUP_AMOUNT_QUERY_STRING_KEY) || '0') || 0;
  const isAutoTopUpEnabled = await isOrgAutoTopUpFeatureEnabled(organizationId);

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => (
        <OrganizationDashboard
          organizationId={organization.id}
          role={role}
          topupAmount={topupAmount}
          isAutoTopUpEnabled={isAutoTopUpEnabled}
        />
      )}
    />
  );
}
