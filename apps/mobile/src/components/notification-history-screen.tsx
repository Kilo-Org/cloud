import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { NOTIFICATION_HISTORY_RETENTION_DAYS } from '@kilocode/notifications/schemas';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { RefreshControl } from '@/components/ui/refresh-control';
import { BellOff } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { tabEntryA11y } from '@/lib/a11y/tab-entry';
import { useAuth } from '@/lib/auth/auth-context';
import { setPendingDeepLink } from '@/lib/deep-link-launch';
import { pendingDeepLinkOptionsForData } from '@/lib/notification-actions';
import {
  NOTIFICATION_HISTORY_FILTERS,
  type NotificationHistoryFilter,
  notificationHistoryFilters,
  notificationHistoryTarget,
} from '@/lib/notification-history';
import { useNotificationMasterGate } from '@/lib/hooks/use-notification-master-gate';
import { type HistoryRow, HistoryRowView } from '@/components/notification-history-row';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  hasRetentionBudget,
  reconcileFirstPage,
  withInfiniteRetention,
} from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';

/** Rows requested per page; the server defaults to the same 30. */
const PAGE_SIZE = 30;

/** Retained pages; the bound refuses the next page rather than dropping the newest. */
const MAX_PAGES = 10;

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingHorizontal: 16 } satisfies ViewStyle;

/** One filter chip. Single-select, so the active one carries `selected`. */
function FilterChip({
  label,
  active,
  onPress,
}: Readonly<{ label: string; active: boolean; onPress: () => void }>) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      // `Button` pins `role="button"`; a real role must replace it, because
      // `role` outranks `accessibilityRole`.
      {...tabEntryA11y({ selected: active })}
      onPress={onPress}
    >
      <Text>{label}</Text>
    </Button>
  );
}

/**
 * The pushes this account received, newest first: one row per recorded
 * notification, rendered on the device from the catalog key and params the push
 * carried, filtered by the same categories the settings screen toggles, and
 * opening the destination a push tap opens.
 *
 * The list is independent of the push gate: a user whose pushes are off sees
 * what arrived before they were, with a banner that leads to the switch.
 */
export function NotificationHistoryScreen() {
  const trpc = useTRPC();
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { token: authToken } = useAuth();
  const gate = useNotificationMasterGate();
  const now = useRelativeTimeNow();
  const queryClient = useQueryClient();
  const paddingBottom = useTabBarBottomPadding();
  const [category, setCategory] = useState<NotificationHistoryFilter['category']>(null);
  const [refreshing, setRefreshing] = useState(false);

  const preferences = useQuery({
    ...trpc.user.getNotificationPreferences.queryOptions(),
    enabled: authToken != null,
    // Same reason as the list: a read started offline must settle into its
    // answer or its error instead of pausing in `pending`, which would hold the
    // chip skeletons on screen for as long as the device stays offline. A
    // settled failure falls back to every chip.
    networkMode: 'always',
    // `networkMode: 'always'` also drops the derived reconnect refetch.
    refetchOnReconnect: true,
  });

  const query = useInfiniteQuery(
    withInfiniteRetention(
      trpc.user.getNotificationHistory.infiniteQueryOptions(
        { category: category ?? undefined, limit: PAGE_SIZE },
        {
          enabled: authToken != null,
          // A newest-first list reaches its retention bound by refusing the
          // next page: `maxPages` alone would drop index 0, which is the newest
          // page.
          getNextPageParam: (lastPage, pages) =>
            hasRetentionBudget(pages.length, MAX_PAGES)
              ? (lastPage.nextCursor ?? undefined)
              : undefined,
          // A first load while offline must settle into the error state and its
          // retry rather than pausing in `pending`, which would leave the
          // skeleton on screen for as long as the device stays offline.
          networkMode: 'always',
          // `networkMode: 'always'` also drops the derived reconnect refetch,
          // so ask for it back.
          refetchOnReconnect: true,
        }
      ),
      MAX_PAGES
    )
  );

  const flatItems = useMemo(
    () => query.data?.pages.flatMap(page => page.items) ?? [],
    [query.data?.pages]
  );
  // `reconcileFirstPage` keeps the retained pages until page one arrives, so
  // the rows a refresh started from stay on screen (and scroll survives) even
  // when the refetch is paused by lost connectivity or fails.
  const items = flatItems;
  const hasListContent = items.length > 0 || query.isFetchNextPageError;
  // A query that is disabled never leaves `pending`; only a signed-in read can.
  const loading = authToken != null && query.isPending && !query.isError;
  const failure = !loading && query.isError && !hasListContent;

  const openRow = useCallback(
    (payload: Record<string, unknown>) => {
      const target = notificationHistoryTarget(payload);
      if (target === null) {
        toast.error(t('notifications.history.openFailed'));
        return;
      }
      // The same slot a notification response fills: the root layout navigates.
      setPendingDeepLink(target.href, 'notification', pendingDeepLinkOptionsForData(target.data));
    },
    [t]
  );

  const renderItem = useCallback(
    ({ item }: { item: HistoryRow }) => <HistoryRowView row={item} now={now} onOpen={openRow} />,
    [now, openRow]
  );

  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      try {
        // A retained page is a keyset window that only stays contiguous with
        // the page above it while page one's newest row is unchanged. Rows that
        // arrived since would move page one's tail past the older pages'
        // cursors, so a refresh collapses the list and reloads from the newest
        // row instead of re-requesting every retained window.
        //
        // Three different keys: the path resets every variant of this read, the
        // infinite key is the entry the list observes, and `getQueryState` only
        // answers an exact key.
        const path = trpc.user.getNotificationHistory.pathKey();
        const key = trpc.user.getNotificationHistory.infiniteQueryKey({
          category: category ?? undefined,
          limit: PAGE_SIZE,
        });
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

  const filters = preferences.data
    ? notificationHistoryFilters(preferences.data.capabilities)
    : NOTIFICATION_HISTORY_FILTERS;

  // The page bound, not the server, ends the list: say so.
  const capped = !query.hasNextPage && (query.data?.pages.at(-1)?.nextCursor ?? null) !== null;
  let footer = (
    <View className="pb-8" style={{ paddingBottom: paddingBottom + 32 }}>
      {capped ? (
        <Text variant="muted" className="text-center text-xs">
          {t('notifications.history.capped')}
        </Text>
      ) : null}
    </View>
  );
  if (query.isFetchNextPageError) {
    footer = (
      <View className="pb-8" style={{ paddingBottom: paddingBottom + 32 }}>
        <Button
          variant="ghost"
          onPress={() => {
            void query.fetchNextPage();
          }}
        >
          <Text>{t('common.retryLoadingMore')}</Text>
        </Button>
      </View>
    );
  } else if (query.isFetchingNextPage) {
    footer = <Skeleton className="mb-3 h-20 rounded-2xl" />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('notifications.history.title')} showBackButton />
      <View className="flex-1">
        {gate.settled && !gate.pushEnabled ? (
          <View className="mx-4 mb-3 gap-2 rounded-lg border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
              <BellOff size={16} color={colors.mutedForeground} />
              <Text className="flex-1 text-sm">{t('notifications.history.bannerBody')}</Text>
            </View>
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                router.push('/(app)/notifications' as Href);
              }}
            >
              <Text>{t('notifications.history.bannerAction')}</Text>
            </Button>
          </View>
        ) : null}

        {preferences.isPending && authToken != null ? (
          <View className="mx-4 mb-3 flex-row gap-2">
            <Skeleton className="h-8 w-16 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-full" />
            <Skeleton className="h-8 w-20 rounded-full" />
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityRole="tablist"
            className="grow-0"
            contentContainerClassName="gap-2 px-4"
          >
            {filters.map(filter => (
              <FilterChip
                key={filter.category ?? 'all'}
                label={t(filter.labelKey)}
                active={filter.category === category}
                onPress={() => {
                  setCategory(filter.category);
                }}
              />
            ))}
          </ScrollView>
        )}

        <View className="mt-3 flex-1">
          {loading ? (
            <View className="gap-3 px-4">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </View>
          ) : null}

          {failure ? (
            <QueryError
              message={t('notifications.history.loadError')}
              onRetry={() => {
                void query.refetch();
              }}
              isRetrying={query.isFetching}
              refreshControl={refreshControl}
            />
          ) : null}

          {!loading && !failure && !hasListContent ? (
            <EmptyState
              icon={BellOff}
              refreshControl={refreshControl}
              title={t(
                category === null
                  ? 'notifications.history.emptyTitle'
                  : 'notifications.history.emptyCategoryTitle'
              )}
              // The retention window describes the whole list, not one category.
              description={
                category === null
                  ? t('notifications.history.emptyBody', {
                      days: NOTIFICATION_HISTORY_RETENTION_DAYS,
                    })
                  : undefined
              }
            />
          ) : null}

          {!loading && !failure && hasListContent ? (
            <FlashList<HistoryRow>
              style={listStyle}
              data={items}
              keyExtractor={item => item.id}
              renderItem={renderItem}
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
              ListFooterComponent={footer}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}
