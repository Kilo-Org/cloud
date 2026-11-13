import { OrganizationUsageScreen } from '@/components/usage/organization-usage-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function OrganizationUsageRoute() {
  // The numbers belong to the account they were opened under: a switch to
  // another account returns to that account's hub instead of re-scoping to an
  // organization it may not read at all.
  const stale = useLeaveStaleOrganizationScope();
  // Usage keeps accruing off-screen, so a returning screen asks again.
  useRouteForegroundRefresh([
    [['usageAnalytics', 'getSummary']],
    [['usageAnalytics', 'getTimeseries']],
    [['usageAnalytics', 'getBreakdown']],
  ]);
  if (stale) {
    return null;
  }
  return <OrganizationUsageScreen />;
}
