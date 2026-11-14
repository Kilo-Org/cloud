import { useTranslation } from 'react-i18next';

import { InvoiceListScreen } from '@/components/invoice-list-screen';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { usePersonalInvoicesPage } from '@/lib/hooks/use-personal-credits';

/**
 * The person's own Stripe invoices. It reads the same page the web `/invoices`
 * page lists, through `user.invoicesPage`, and renders the shared invoice rows
 * the organization scope uses — including the PDF share sheet.
 */
export function PersonalInvoicesScreen() {
  const { t } = useTranslation();
  const { query, entries, hasMore } = usePersonalInvoicesPage();
  // An invoice can appear off-screen (a renewal charging while the app is
  // backgrounded), so the list refreshes when the route regains foreground.
  useRouteForegroundRefresh([[['user', 'invoicesPage']]]);

  return (
    <InvoiceListScreen
      title={t('organization.invoices.title')}
      query={query}
      entries={entries}
      hasMore={hasMore}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('invoices.personalEmptyDescription')}
    />
  );
}
