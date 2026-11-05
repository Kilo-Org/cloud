import type { Organization } from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';
import { resolveFeatureAdoption } from '@/lib/organizations/feature-adoption';

export async function OrganizationUsageDashboardServer({
  organization,
  role,
}: {
  organization: Pick<Organization, 'id' | 'name' | 'plan' | 'settings'>;
  role: OrganizationRole;
}) {
  const isSalesDemo = organization.settings.is_sales_demo === true;
  const featureAdoption = isSalesDemo
    ? { complete: false, checks: null }
    : await resolveFeatureAdoption({
        organizationId: organization.id,
        plan: organization.plan,
        settings: organization.settings,
      });

  return (
    <UsageAnalyticsDashboard
      context="organization"
      organizationId={organization.id}
      organizationName={organization.name}
      callerRole={role}
      organizationPlan={organization.plan}
      isSalesDemo={isSalesDemo}
      featureAdoptionComplete={featureAdoption.complete}
      initialFeatureAdoptionChecks={featureAdoption.checks ?? undefined}
      title={`Usage — ${organization.name}`}
    />
  );
}
