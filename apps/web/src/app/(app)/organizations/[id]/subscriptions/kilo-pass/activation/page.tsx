import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgKiloPassActivation } from '@/components/subscriptions/org-kilo-pass/OrgKiloPassActivation';

export default async function OrganizationKiloPassActivationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: checkoutSessionId } = await searchParams;
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => (
        <OrgKiloPassActivation
          organizationId={organization.id}
          checkoutSessionId={checkoutSessionId ?? ''}
        />
      )}
    />
  );
}
