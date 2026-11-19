import { OrganizationInvoicesScreen } from '@/components/organization/invoices-screen';
import { useRepairOrganizationRouteStack } from '@/lib/hooks/use-repair-organization-route-stack';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function OrganizationInvoicesRoute() {
  // The previous account's invoices belong to that account: once the reader
  // switches away, this route returns to the current account's hub instead of
  // re-scoping to an organization that may not read it at all.
  const stale = useLeaveStaleOrganizationScope();
  // A link or a relaunch restore that arrives without the hub beneath it
  // rebuilds it, so Back returns to the hub instead of leaving the
  // organization tree.
  useRepairOrganizationRouteStack({ self: '/(app)/(tabs)/(3_profile)/organization/invoices' });
  if (stale) {
    return null;
  }
  return <OrganizationInvoicesScreen />;
}
