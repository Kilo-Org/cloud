import { LowBalanceAlertSheet } from '@/components/organization/low-balance-alert-sheet';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function LowBalanceAlertRoute() {
  // The threshold belongs to the account it was opened under; a switch
  // elsewhere closes the sheet instead of saving into the next account.
  const stale = useLeaveStaleOrganizationScope();
  if (stale) {
    return null;
  }
  return <LowBalanceAlertSheet />;
}
