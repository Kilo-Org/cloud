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
    return <OrganizationBoundary title={t('organization.invoices.title')} />;
  }

  return (
    <InvoiceListScreen
      title={t('organization.invoices.title')}
      query={query}
      entries={entries}
      hasMore={hasMore}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('organization.invoices.emptyDescription')}
    />
  );
}
