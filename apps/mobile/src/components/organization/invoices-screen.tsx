import { useTranslation } from 'react-i18next';

import { InvoiceListScreen } from '@/components/invoice-list-screen';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useOrgBoundary, useOrgInvoicesPage } from '@/lib/hooks/use-organization-queries';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

export function OrganizationInvoicesScreen() {
  const { t } = useTranslation();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const { query, entries, hasMore, isRetentionLimited } = useOrgInvoicesPage(organizationId);
  useRouteForegroundRefresh([[['organizations']]]);

  if (isResolving || organizationId == null || org == null) {
    // Only the transient membership read reserves the subtitle line: the
    // header that replaces this boundary fills it with the organization's
    // name, so the swap keeps the header's height. A settled boundary state
    // (no membership, no selection, access denied, unavailable) never fills
    // that line, so it keeps its own header height.
    return (
      <OrganizationBoundary
        title={t('organization.invoices.title')}
        reserveSubtitle={isResolving}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }

  return (
    <InvoiceListScreen
      // The one two-line header: the title names the screen, as the personal
      // list's does, and the subtitle under it names the organization.
      title={t('organization.invoices.title')}
      subtitle={org.organizationName}
      backFallback={ORGANIZATION_HUB_PATH}
      query={query}
      entries={entries}
      hasMore={hasMore}
      isRetentionLimited={isRetentionLimited}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('organization.invoices.emptyDescription')}
    />
  );
}
