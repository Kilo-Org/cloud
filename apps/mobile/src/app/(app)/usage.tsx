import { PersonalUsageScreen } from '@/components/usage/personal-usage-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export default function UsageRoute() {
  // Usage accrues off-screen (the app is one client among the CLI and the web),
  // so a returning screen asks for fresh numbers instead of showing the window
  // it opened with.
  useRouteForegroundRefresh([
    [['usageAnalytics', 'getSummary']],
    [['usageAnalytics', 'getTimeseries']],
    [['usageAnalytics', 'getBreakdown']],
  ]);
  return <PersonalUsageScreen />;
}
