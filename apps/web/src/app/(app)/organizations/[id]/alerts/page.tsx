import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationAlertsPage } from '@/components/organizations/alerts/OrganizationAlertsPage';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

/**
 * Alerts is reachable for every plan so a downgraded organization can still
 * disable or archive what it configured. Authorization is enforced here with the
 * same billing roles the alerts router requires, not by sidebar visibility.
 */
export default async function OrganizationAlertsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => (
        <OrganizationAlertsPage
          organizationId={organization.id}
          isEnterprise={organization.plan === 'enterprise'}
        />
      )}
    />
  );
}
