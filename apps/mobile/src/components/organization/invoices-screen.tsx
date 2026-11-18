import { useTranslation } from 'react-i18next';

import { InvoiceListScreen } from '@/components/invoice-list-screen';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useOrgBoundary, useOrgInvoicesPage } from '@/lib/hooks/use-organization-queries';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

export function OrganizationInvoicesScreen() {
  const { t } = useTranslation();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const { query, entries, hasMore } = useOrgInvoicesPage(organizationId);
  useRouteForegroundRefresh([[['organizations']]]);

  if (isResolving || organizationId == null || org == null) {
    // Only the transient membership read reserves the eyebrow line: the header
    // that replaces this boundary fills it with the screen's name, so the swap
    // keeps the header's height. A settled boundary state (no membership, no
    // selection, access denied, unavailable) never fills that line, so it keeps
    // its own header height.
    return (
      <OrganizationBoundary
        title={t('organization.invoices.title')}
        reserveEyebrow={isResolving}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }

  return (
    <InvoiceListScreen
      title={org.organizationName}
      eyebrow={t('organization.invoices.title')}
      // The title keeps the header's default tail ellipsis, so the start of the
      // organization name always stays readable.
      backFallback={ORGANIZATION_HUB_PATH}
      query={query}
      entries={entries}
      hasMore={hasMore}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('organization.invoices.emptyDescription')}
    />
  );
}
