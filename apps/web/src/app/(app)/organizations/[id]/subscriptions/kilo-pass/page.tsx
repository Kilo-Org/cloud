import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgKiloPassBillingHistory } from '@/components/subscriptions/org-kilo-pass/OrgKiloPassBillingHistory';
import { OrgKiloPassDetail } from '@/components/subscriptions/org-kilo-pass/OrgKiloPassDetail';

export default async function OrganizationKiloPassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => (
        <div className="space-y-6">
          <OrgKiloPassDetail
            organizationId={organization.id}
            organizationName={organization.name}
          />
          <OrgKiloPassBillingHistory organizationId={organization.id} />
        </div>
      )}
    />
  );
}
