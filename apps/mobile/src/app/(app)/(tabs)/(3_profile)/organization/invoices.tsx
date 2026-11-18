import { OrganizationInvoicesScreen } from '@/components/organization/invoices-screen';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';

export default function OrganizationInvoicesRoute() {
  // The previous account's invoices belong to that account: once the reader
  // switches away, this route returns to the current account's hub instead of
  // re-scoping to an organization that may not read it at all.
  const stale = useLeaveStaleOrganizationScope();
  if (stale) {
    return null;
  }
  return <OrganizationInvoicesScreen />;
}
