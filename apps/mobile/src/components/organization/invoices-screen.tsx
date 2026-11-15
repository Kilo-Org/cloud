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
    // Only the transient membership read reserves the eyebrow line: the header
    // that replaces this boundary fills it with the screen's name, so the swap
    // keeps the header's height. A settled boundary state (no membership, no
    // selection, access denied, unavailable) never fills that line, so it keeps
    // its own header height.
    return (
      <OrganizationBoundary
        title={t('organization.invoices.title')}
        reserveEyebrow={isResolving}
        // The reserved line holds this label's own line box: Arabic-script copy
        // takes the 13px eyebrow twin, taller than the mono 10px space the
        // reserve would otherwise hold, so the header cannot grow on the swap.
        eyebrow={t('organization.invoices.title')}
      />
    );
  }

  return (
    <InvoiceListScreen
      title={org.organizationName}
      // The organization titles the screen, so the eyebrow keeps the list's own
      // name out of the header's uppercase style. The boundary reserved this
      // one-line eyebrow while the membership read ran, so the swap to this
      // header cannot move the list.
      eyebrow={t('organization.invoices.title')}
      // The title keeps the header's default tail ellipsis, so the start of the
      // organization name always stays readable.
      query={query}
      entries={entries}
      hasMore={hasMore}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('organization.invoices.emptyDescription')}
    />
  );
}
