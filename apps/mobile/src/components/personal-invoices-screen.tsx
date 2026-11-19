import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { InvoiceListScreen } from '@/components/invoice-list-screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { usePersonalInvoicesPage } from '@/lib/hooks/use-personal-credits';
import { CREDIT_HISTORY_HREF, PROFILE_TAB_HREF } from '@/lib/profile-navigation';

/**
 * The person's own Stripe invoices. It reads the same page the web `/invoices`
 * page lists, through `user.invoicesPage`, and renders the shared invoice rows
 * the organization scope uses — including the PDF share sheet.
 */
export function PersonalInvoicesScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { query, entries, hasMore, isRetentionLimited } = usePersonalInvoicesPage();
  // An invoice can appear off-screen (a renewal charging while the app is
  // backgrounded), so the list refreshes when the route regains foreground.
  useRouteForegroundRefresh([[['user', 'invoicesPage']]]);

  return (
    <InvoiceListScreen
      title={t('organization.invoices.title')}
      subtitle={t('invoices.personalPeriod')}
      backFallback={PROFILE_TAB_HREF}
      query={query}
      entries={entries}
      hasMore={hasMore}
      isRetentionLimited={isRetentionLimited}
      emptyTitle={t('organization.invoices.emptyTitle')}
      emptyDescription={t('invoices.personalEmptyDescription')}
      emptyAction={
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            router.push(CREDIT_HISTORY_HREF);
          }}
        >
          <Text>{t('common.creditHistory')}</Text>
        </Button>
      }
    />
  );
}
