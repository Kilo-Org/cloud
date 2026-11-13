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
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { buildCreditHistoryItems, type CreditHistoryItem } from '@/lib/credits/credit-history';
import { openExternalUrl } from '@/lib/external-link';
import {
  useCreditPurchaseHistory,
  usePersonalCreditBlocks,
} from '@/lib/hooks/use-personal-credits';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

// FlashList takes `contentContainerStyle` (no className), so the FlatList's
// `grow gap-3 px-6 pt-4` content classes map to their pixel values. FlashList v2
// positions every cell absolutely and has no `gap` handling (2.3.2 ships zero
// `gap` references), so the 12px inter-row gap rides on the measured item
// separator instead of `contentContainerStyle.gap`.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingHorizontal: 24,
  paddingTop: 16,
} satisfies ViewStyle;

const HistoryRowSeparator = () => <View className="h-3" />;

function HistoryRowSkeleton() {
  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
    </View>
  );
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
    ({ item }: ListRenderItemInfo<CreditHistoryItem>) =>
      item.kind === 'purchase' ? (
        <PurchaseHistoryRow
          entry={item.entry}
          isOpeningReceipt={openingReceiptId === item.entry.id}
          onOpenReceipt={openReceipt}
        />
      ) : (
        <LedgerHistoryRow deduction={item.deduction} grantListed={item.grantListed} />
      ),
    [openReceipt, openingReceiptId]
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
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
        <HistoryRowSkeleton />
        <HistoryRowSkeleton />
        <HistoryRowSkeleton />
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
        {purchases.hasMore && !isLaterPageError && (
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
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
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
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
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
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
          ItemSeparatorComponent={HistoryRowSeparator}
          contentContainerStyle={listContentContainerStyle}
          ListFooterComponent={footer}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.creditHistory')} />
      {body}
    </View>
  );
}
