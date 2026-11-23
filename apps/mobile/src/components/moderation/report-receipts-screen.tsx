import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView, useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Flag } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup, RowGroupItem, rowGroupPosition } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { SCREEN_GUTTER_DP } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import {
  hasRetentionBudget,
  reconcileFirstPage,
  withInfiniteRetention,
} from '@/lib/query/infinite-retention';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { reportReceiptRoute } from '@/lib/report-receipt-route';
import {
  APPEAL_KEYS,
  REASON_KEYS,
  statusLabel,
  TARGET_KEYS,
  TRIAGE_KEYS,
} from '@/lib/report-receipt-status';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/** Rows requested per page; the server accepts the same bound. */
const PAGE_SIZE = 30;

/** Retained pages; the bound refuses the next page rather than dropping the newest. */
const MAX_PAGES = 10;

/**
 * The row's parts are described in one line, so a list of reports reads as a
 * list of things rather than a stack of unrelated settings. `·` matches the
 * separator the app's other lead-plus-detail rows use.
 */
const SEPARATOR = ' · ';

const listStyle = { flex: 1 } satisfies ViewStyle;
// The page gutter and the top pad live on the content container; the cells are
// one continuous grouped card, so no per-cell inset and no gap between them.
//
// Both branches take this one style, so the skeleton keeps the geometry of the
// rows that replace it: the gutter is the app's single page inset, the same one
// the header and the receipt this list opens use, and the top pad is the 14pt
// the loading branch's `pt-4` painted before (the native rem is 14pt). One
// inset value for both axes is what stops the card moving 2dp sideways and 2dp
// up the moment the first page settles.
const listContentContainerStyle = {
  paddingHorizontal: SCREEN_GUTTER_DP,
  paddingTop: SCREEN_GUTTER_DP,
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
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslation();
  const now = useRelativeTimeNow();
  const paddingBottom = useTabBarBottomPadding();
  const [refreshing, setRefreshing] = useState(false);

  const query = useInfiniteQuery(
    withInfiniteRetention(
      trpc.moderation.listReportReceipts.infiniteQueryOptions(
        { limit: PAGE_SIZE },
        {
          // A report filed a moment ago is the one the reader opens this screen
          // for, so an open reads the server instead of a cached page. That
          // read is the page-one reconcile below, not React Query's mount
          // refetch: on an entry that holds pages, the mount refetch re-requests
          // every retained page (up to the bound), one after another.
          refetchOnMount: false,
          // A newest-first list reaches its retention bound by refusing the
          // next page: `maxPages` alone would drop index 0, which is the newest
          // page.
          getNextPageParam: (lastPage, pages) =>
            hasRetentionBudget(pages.length, MAX_PAGES)
              ? (lastPage.nextCursor ?? undefined)
              : undefined,
          // A paused first load leaves the skeleton on screen with no retry.
          ...SETTLE_WHILE_OFFLINE,
        }
      ),
      MAX_PAGES
    )
  );

  // Opening the screen reads the server, and reads one page of it. The helper
  // keeps the retained rows until that page arrives, so a paused or failed
  // refresh never blanks the list into its empty or full-screen error state; a
  // cold open has nothing cached, so its own page-one fetch is left alone.
  useEffect(() => {
    void reconcileFirstPage(queryClient, trpc.moderation.listReportReceipts.pathFilter().queryKey);
  }, [queryClient, trpc]);

  const items = useMemo(
    () => query.data?.pages.flatMap(page => page.items) ?? [],
    [query.data?.pages]
  );

  const loading = query.isPending;
  // A failed page must not replace the rows already measured: only a first page
  // that never arrived turns into the error state.
  const failure = query.isError && query.data === undefined;
  // One answer for every screen: a terminal code (including a stale or malformed
  // cursor) cannot be fixed by asking again, so it offers no Retry.
  const retryable = query.isError && isRetryableTrpcError(query.error);
  const capped = !query.hasNextPage && (query.data?.pages.at(-1)?.nextCursor ?? null) !== null;

  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      try {
        // A retained page is a keyset window that only stays contiguous with
        // the page above it while page one's newest row is unchanged. A report
        // the reader filed since would move page one's tail past the older
        // pages' cursors, so a refresh collapses the list and reloads from the
        // newest row instead of re-requesting every retained window.
        //
        // Three different keys: the path resets every variant of this read, the
        // infinite key is the entry the list observes, and `getQueryState` only
        // answers an exact key.
        const path = trpc.moderation.listReportReceipts.pathKey();
        const key = trpc.moderation.listReportReceipts.infiniteQueryKey({ limit: PAGE_SIZE });
        await reconcileFirstPage(queryClient, path);
        if (queryClient.getQueryState(key)?.status === 'error') {
          toast.error(t('common.couldNotRefresh'));
        }
      } finally {
        setRefreshing(false);
      }
    })();
  };
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('profile.reportReceipts.title')}
        showBackButton
        backFallback={PROFILE_TAB_HREF}
      />
      <View className="flex-1">
        {loading ? (
          <TabScreenScrollView className="flex-1" contentContainerStyle={listContentContainerStyle}>
            {/* The loaded rows are one grouped card, so the reserve is one. */}
            <RowGroup>
              <RowSkeleton subtitle />
              <RowSkeleton subtitle />
              <RowSkeleton subtitle />
            </RowGroup>
          </TabScreenScrollView>
        ) : null}

        {!loading && failure ? (
          <QueryError
            title={t('profile.reportReceipts.couldNotLoad')}
            // A receipt list the server says is not this reader's cannot be
            // fixed by asking again.
            variant={trpcErrorVariant(query.error)}
            onRetry={
              retryable
                ? () => {
                    void query.refetch();
                  }
                : undefined
            }
            isRetrying={query.isFetching}
          />
        ) : null}

        {!loading && !failure && items.length === 0 ? (
          <EmptyState
            icon={Flag}
            refreshControl={refreshControl}
            title={t('profile.reportReceipts.emptyTitle')}
            description={t('profile.reportReceipts.emptyDescription')}
          />
        ) : null}

        {!loading && !failure && items.length > 0 ? (
          <FlashList
            style={listStyle}
            data={items}
            keyExtractor={item => item.receiptId}
            renderItem={({ item, index }) => {
              const target = statusLabel(TARGET_KEYS, item.targetKind);
              const reason = statusLabel(REASON_KEYS, item.reason);
              const triage = statusLabel(TRIAGE_KEYS, item.triageStatus);
              const age = timeAgo(parseTimestamp(item.createdAt), undefined, now);
              // The appeal line is only drawn when the reader appealed, so a
              // report without one keeps the row it has always had. It names
              // itself as the appeal: the triage line above it can already hold
              // the same word (a rejected report and a declined appeal share
              // one), and a bare second status reads as the report's own.
              const appeal =
                item.appealStatus === 'none'
                  ? undefined
                  : t('profile.reportReceipt.appealStatusLine', {
                      status: statusLabel(APPEAL_KEYS, item.appealStatus),
                    });
              // A screen reader hears the whole row in one pass: what was
              // reported, why, how it was decided, and the appeal when there is
              // one. The visual lines are separate nodes, so each is also
              // joined with '.' here.
              const lead = [target, reason].join(SEPARATOR);
              const outcome = [triage, age].join(SEPARATOR);
              const spoken = [lead, outcome, appeal].filter(part => part !== undefined);
              return (
                <RowGroupItem
                  position={rowGroupPosition({
                    first: index === 0,
                    last: index === items.length - 1,
                  })}
                >
                  <RowFrame
                    title={lead}
                    subtitle={{ text: outcome }}
                    secondSubtitle={appeal === undefined ? undefined : { text: appeal }}
                    accessibilityLabel={spoken.join('. ')}
                    onPress={() => {
                      router.push(reportReceiptRoute(item.receiptId));
                    }}
                  />
                </RowGroupItem>
              );
            }}
            contentContainerStyle={listContentContainerStyle}
            // FlashList adds its own control from this pair; the element
            // below is for the state scrollers that accept one.
            refreshing={refreshing}
            onRefresh={handleRefresh}
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
                {query.isFetchingNextPage ? (
                  <RowGroupItem position="only">
                    <RowSkeleton subtitle />
                  </RowGroupItem>
                ) : null}
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
