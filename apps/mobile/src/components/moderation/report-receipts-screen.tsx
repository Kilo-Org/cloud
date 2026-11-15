import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView, useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Flag } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { hasRetentionBudget, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { reportReceiptRoute } from '@/lib/report-receipt-route';
import { statusLabel, TRIAGE_KEYS } from '@/lib/report-receipt-status';
import { readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/** Rows requested per page; the server accepts the same bound. */
const PAGE_SIZE = 30;

/** Retained pages; the bound refuses the next page rather than dropping the newest. */
const MAX_PAGES = 10;

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  gap: 12,
  paddingHorizontal: 16,
  paddingTop: 16,
} satisfies ViewStyle;

/**
 * The reports this reader filed, newest first: one row per receipt, and each row
 * opens the receipt the confirmation's toast only showed once.
 *
 * The list is the durable half of that confirmation: the receipt screen tells
 * the reader to keep the id, and this is where they find it again.
 */
export function ReportReceiptsScreen() {
  const trpc = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();
  const now = useRelativeTimeNow();
  const paddingBottom = useTabBarBottomPadding();

  const query = useInfiniteQuery(
    withInfiniteRetention(
      trpc.moderation.listReportReceipts.infiniteQueryOptions(
        { limit: PAGE_SIZE },
        {
          // A report filed a moment ago is the one the reader opens this screen
          // for, so an open reads the server instead of a cached page.
          staleTime: 0,
          // A newest-first list reaches its retention bound by refusing the
          // next page: `maxPages` alone would drop index 0, which is the newest
          // page.
          getNextPageParam: (lastPage, pages) =>
            hasRetentionBudget(pages.length, MAX_PAGES)
              ? (lastPage.nextCursor ?? undefined)
              : undefined,
        }
      ),
      MAX_PAGES
    )
  );

  const items = useMemo(
    () => query.data?.pages.flatMap(page => page.items) ?? [],
    [query.data?.pages]
  );

  const loading = query.isPending;
  // A failed page must not replace the rows already measured: only a first page
  // that never arrived turns into the error state.
  const failure = query.isError && query.data === undefined;
  const errorCode = query.isError ? readTrpcErrorField(query.error, 'code') : undefined;
  const permanent =
    errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED';
  const capped = !query.hasNextPage && (query.data?.pages.at(-1)?.nextCursor ?? null) !== null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.reportReceipts.title')} showBackButton />
      <View className="flex-1">
        {loading ? (
          <TabScreenScrollView className="flex-1" contentContainerClassName="gap-3 px-4 pt-4">
            <Skeleton className="h-[62px] rounded-lg" />
            <Skeleton className="h-[62px] rounded-lg" />
            <Skeleton className="h-[62px] rounded-lg" />
          </TabScreenScrollView>
        ) : null}

        {!loading && failure ? (
          <QueryError
            title={t('profile.reportReceipts.couldNotLoad')}
            // A receipt list the server says is not this reader's cannot be
            // fixed by asking again.
            variant={trpcErrorVariant(query.error)}
            onRetry={
              permanent
                ? undefined
                : () => {
                    void query.refetch();
                  }
            }
            isRetrying={query.isFetching}
          />
        ) : null}

        {!loading && !failure && items.length === 0 ? (
          <EmptyState
            placement="top"
            icon={Flag}
            title={t('profile.reportReceipts.emptyTitle')}
            description={t('profile.reportReceipts.emptyDescription')}
          />
        ) : null}

        {!loading && !failure && items.length > 0 ? (
          <FlashList
            style={listStyle}
            data={items}
            keyExtractor={item => item.receiptId}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                className="rounded-lg bg-secondary px-3 py-3 active:opacity-70"
                onPress={() => {
                  router.push(reportReceiptRoute(item.receiptId));
                }}
              >
                <Text className="text-sm font-medium" numberOfLines={1}>
                  {statusLabel(TRIAGE_KEYS, item.triageStatus)}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {timeAgo(parseTimestamp(item.createdAt), undefined, now)}
                </Text>
              </Pressable>
            )}
            contentContainerStyle={listContentContainerStyle}
            onEndReached={() => {
              // Once the next page has failed, auto-loading re-fires on every
              // content-size change, so recovery waits for the footer's tap.
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              <View className="pt-3">
                {query.isFetchingNextPage ? <Skeleton className="h-[62px] rounded-lg" /> : null}
                {query.isFetchNextPageError ? (
                  <Button
                    variant="ghost"
                    onPress={() => {
                      void query.fetchNextPage();
                    }}
                  >
                    <Text>{t('common.retryLoadingMore')}</Text>
                  </Button>
                ) : null}
                {capped ? (
                  <Text variant="muted" className="text-center text-xs">
                    {t('profile.reportReceipts.capped')}
                  </Text>
                ) : null}
                <View style={{ height: paddingBottom }} pointerEvents="none" />
              </View>
            }
          />
        ) : null}
      </View>
    </View>
  );
}
