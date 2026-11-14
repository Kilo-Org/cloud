import { useTranslation } from 'react-i18next';

import { InvoiceListScreen } from '@/components/invoice-list-screen';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useOrgBoundary, useOrgInvoicesPage } from '@/lib/hooks/use-organization-queries';

export function OrganizationInvoicesScreen() {
  const { t } = useTranslation();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const { query, entries, hasMore } = useOrgInvoicesPage(organizationId);
  useRouteForegroundRefresh([[['organizations']]]);

  if (isResolving || organizationId == null || org == null) {
    // The boundary paints this screen's name as the title and reserves the
    // eyebrow line, so the resolved header below swaps the name into the
    // title without changing the header's height.
    return <OrganizationBoundary title={t('organization.invoices.title')} reserveEyebrow />;
  }

  return (
    <InvoiceListScreen
      title={org.organizationName}
      // The organization titles the screen, so the eyebrow keeps the list's own
      // name out of the header's uppercase style. The boundary above already
      // reserved this one-line eyebrow, so the name arriving cannot move the
      // list.
      eyebrow={t('organization.invoices.title')}
      query={query}
      entries={entries}
      hasMore={hasMore}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('organization.invoices.emptyDescription')}
    />
  );
}
