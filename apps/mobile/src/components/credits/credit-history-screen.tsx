import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useMutation } from '@tanstack/react-query';
import { Receipt } from '@/components/ui/icons';
import { type ReactNode, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { LedgerHistoryRow, PurchaseHistoryRow } from '@/components/credits/credit-history-rows';
import { EmptyState } from '@/components/empty-state';
import { QueryError, type QueryErrorVariant } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { buildCreditHistoryItems, type CreditHistoryItem } from '@/lib/credits/credit-history';
import { openExternalUrl } from '@/lib/external-link';
import {
  useCreditPurchaseHistory,
  usePersonalCreditBlocks,
} from '@/lib/hooks/use-personal-credits';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

// FlashList takes `contentContainerStyle` (no className), so the flat list's
// rows draw their own 14pt gutter and 0.5pt hairline instead of the content
// container carrying a page inset.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { flexGrow: 1 } satisfies ViewStyle;

function HistoryRowSkeleton({ last }: Readonly<{ last: boolean }>) {
  return <RowSkeleton subtitle last={last} />;
}

/**
 * The person's own credit history: every paid purchase with the receipt its
 * channel allows, and the ledger the web `/credits` page lists — grants,
 * bonuses, expiries, deductions, and adjustments — as one chronological list.
 *
 * Purchases are paged and the ledger is not, so the two are merged by date; the
 * ledger names the grant an expiry closed, which is why both land together.
 */
export function PersonalCreditHistoryScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const paddingBottom = useTabBarBottomPadding();

  const purchases = useCreditPurchaseHistory(true);
  const blocks = usePersonalCreditBlocks(true);
  const receiptMutation = useMutation(
    trpc.user.getCreditPurchaseReceipt.mutationOptions({
      onSuccess: result => {
        if (!result.url) {
          toast.error(t('credits.history.receiptUnavailable'));
          return;
        }
        void openExternalUrl(result.url, { label: t('credits.history.receipt') });
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const deductions = blocks.data?.deductions;
  const items = useMemo<CreditHistoryItem[]>(
    () => buildCreditHistoryItems(purchases.entries, deductions ?? []),
    [purchases.entries, deductions]
  );

  const openReceipt = useCallback(
    (transactionId: string) => {
      receiptMutation.mutate({ transactionId });
    },
    [receiptMutation]
  );
  const openingReceiptId = receiptMutation.isPending
    ? receiptMutation.variables.transactionId
    : null;

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<CreditHistoryItem>) =>
      item.kind === 'purchase' ? (
        <PurchaseHistoryRow
          entry={item.entry}
          isOpeningReceipt={openingReceiptId === item.entry.id}
          onOpenReceipt={openReceipt}
          last={index === items.length - 1}
        />
      ) : (
        <LedgerHistoryRow
          deduction={item.deduction}
          grantListed={item.grantListed}
          last={index === items.length - 1}
        />
      ),
    [openReceipt, openingReceiptId, items.length]
  );

  const purchasesFirstPageError = purchases.query.isError && purchases.entries.length === 0;
  const isFirstPageError = purchasesFirstPageError || (blocks.isError && items.length === 0);

  // NOT_FOUND maps to the not-found state; FORBIDDEN/UNAUTHORIZED map to the
  // permission state, and anything else keeps the retryable neutral copy.
  const classifiedError = trpcErrorVariant(purchases.query.error ?? blocks.error);
  const errorVariant: QueryErrorVariant =
    classifiedError === 'not-found' ||
    classifiedError === 'permission' ||
    classifiedError === 'timeout'
      ? classifiedError
      : 'neutral';
  // Those two variants come only from the thrown code, so they cannot be fixed
  // by retrying; every other failure keeps its Retry.
  const isPermanentError = errorVariant === 'not-found' || errorVariant === 'permission';

  const isLoading = purchases.query.status === 'pending' || blocks.isPending;
  const isLaterPageError = purchases.query.isFetchNextPageError;
  // The ledger is a second read feeding this list. When it fails on its own the
  // purchases that already loaded stay on screen, and the footer names the part
  // that is missing instead of dropping it without a word.
  const ledgerFailed = blocks.isError && items.length > 0;

  const retryAll = () => {
    void purchases.query.refetch();
    void blocks.refetch();
  };

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)}>
        <HistoryRowSkeleton last={false} />
        <HistoryRowSkeleton last={false} />
        <HistoryRowSkeleton last />
      </Animated.View>
    );
  } else if (isFirstPageError) {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <QueryError
          variant={errorVariant}
          onRetry={isPermanentError ? undefined : retryAll}
          isRetrying={purchases.query.isFetching || blocks.isFetching}
        />
      </Animated.View>
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon={Receipt}
        title={t('credits.history.emptyTitle')}
        description={t('credits.history.emptyDescription')}
      />
    );
  } else {
    const footer = (
      <View className="pt-3">
        {purchases.isRetentionLimited && !isLaterPageError && !purchases.hasMore && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
              {t('credits.history.retentionLimit')}
            </Text>
          </View>
        )}
        {purchases.hasMore && !isLaterPageError && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
              {t('organization.creditActivity.truncated')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void purchases.query.fetchNextPage()}
              loading={purchases.query.isFetchingNextPage}
              accessibilityLabel={t('common.loadMore')}
            >
              <Text>{t('common.loadMore')}</Text>
            </Button>
          </View>
        )}
        {isLaterPageError && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
              {t('common.couldnTLoadMore')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => void purchases.query.fetchNextPage()}
              loading={purchases.query.isFetchingNextPage}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        )}
        {ledgerFailed && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
              {t('credits.history.activityUnavailable')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                void blocks.refetch();
              }}
              loading={blocks.isFetching}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        )}
        <View style={{ height: paddingBottom }} pointerEvents="none" />
      </View>
    );

    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlashList
          style={listStyle}
          data={items}
          keyExtractor={item => item.key}
          renderItem={renderItem}
          getItemType={item => item.kind}
          contentContainerStyle={listContentContainerStyle}
          ListFooterComponent={footer}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.creditHistory')} backFallback={PROFILE_TAB_HREF} />
      {body}
    </View>
  );
}
