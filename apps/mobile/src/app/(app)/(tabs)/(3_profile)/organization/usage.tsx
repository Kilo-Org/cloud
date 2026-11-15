import { useLocalSearchParams } from 'expo-router';

import { OrganizationUsageScreen } from '@/components/usage/organization-usage-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { normalizeOrgQueryParam } from '@/lib/org-deep-link';

export default function OrganizationUsageRoute() {
  // `/organizations/<id>/usage-details` is a universal link, and the org id rides
  // the query the way the credit-activity link carries it: the screen reads the
  // scope from it instead of the persisted selection.
  const { org: rawOrg } = useLocalSearchParams<{ org?: string | string[] }>();
  const orgIdOverride = normalizeOrgQueryParam(rawOrg);
  // The numbers belong to the account they were opened under: a switch to
  // another account returns to that account's hub instead of re-scoping to an
  // organization it may not read at all. A link that names its own organization
  // is a scope the reader asked for and keeps that account.
  const stale = useLeaveStaleOrganizationScope({
    namesOwnOrganization: orgIdOverride !== undefined,
  });
  // Usage keeps accruing off-screen, so a returning screen asks again.
  useRouteForegroundRefresh([
    [['usageAnalytics', 'getSummary']],
    [['usageAnalytics', 'getTimeseries']],
    [['usageAnalytics', 'getBreakdown']],
  ]);
  if (stale) {
    return null;
  }
  return <OrganizationUsageScreen organizationIdOverride={orgIdOverride} />;
}
