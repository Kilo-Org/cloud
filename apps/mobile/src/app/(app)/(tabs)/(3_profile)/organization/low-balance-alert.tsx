import { LowBalanceAlertScreen } from '@/components/organization/low-balance-alert-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function LowBalanceAlertRoute() {
  // The threshold belongs to the account it was opened under; a switch
  // elsewhere leaves this screen instead of saving into the next account.
  const stale = useLeaveStaleOrganizationScope();
  if (stale) {
    return null;
  }
  return <LowBalanceAlertScreen />;
}
