import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { NOTIFICATION_HISTORY_RETENTION_DAYS } from '@kilocode/notifications';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { RefreshControl } from '@/components/ui/refresh-control';
import { BellOff } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { setPendingDeepLink } from '@/lib/deep-link-launch';
import { pendingDeepLinkOptionsForData } from '@/lib/notification-actions';
import {
  NOTIFICATION_HISTORY_FILTERS,
  notificationHistoryCopy,
  type NotificationHistoryFilter,
  notificationHistoryFilters,
  notificationHistoryTarget,
} from '@/lib/notification-history';
import { useNotificationMasterGate } from '@/lib/hooks/use-notification-master-gate';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { hasRetentionBudget, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/** Rows requested per page; the server defaults to the same 30. */
const PAGE_SIZE = 30;
/** How often a row's relative time is re-read while the screen stays open. */
const RELATIVE_TIME_TICK_MS = 60_000;

const SETTINGS_ROUTE = '/(app)/notifications' as Href;

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingHorizontal: 16 } satisfies ViewStyle;

type HistoryPage = inferRouterOutputs<MobileRouter>['user']['getNotificationHistory'];
type HistoryRow = HistoryPage['items'][number];

type HistoryRowProps = Readonly<{
  row: HistoryRow;
  now: number;
  onOpen: (payload: Record<string, unknown>) => void;
}>;

function HistoryRowView({ row, now, onOpen }: HistoryRowProps) {
  const { i18n } = useTranslation();
  const copy = notificationHistoryCopy(row, i18n.language);
  return (
    <Pressable
      className="mb-3 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-70"
      accessibilityRole="button"
      onPress={() => {
        onOpen(row.payload);
      }}
    >
      <View className="flex-row items-start gap-3">
        <Text className="flex-1 text-sm font-medium" numberOfLines={2}>
          {copy.title}
        </Text>
        <Text variant="muted" className="text-xs">
          {timeAgo(parseTimestamp(row.createdAt), undefined, now)}
        </Text>
      </View>
      <Text variant="muted" className="mt-1 text-sm" numberOfLines={3}>
        {copy.body}
      </Text>
    </Pressable>
  );
}

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
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
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
  const now = useNowTicker(RELATIVE_TIME_TICK_MS);
  const paddingBottom = useTabBarBottomPadding();
  const [category, setCategory] = useState<NotificationHistoryFilter['category']>(null);
  const [refreshing, setRefreshing] = useState(false);

  const preferences = useQuery({
    ...trpc.user.getNotificationPreferences.queryOptions(),
    enabled: authToken != null,
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
            hasRetentionBudget(pages.length) ? (lastPage.nextCursor ?? undefined) : undefined,
        }
      )
    )
  );

  const items = useMemo(
    () => query.data?.pages.flatMap(page => page.items) ?? [],
    [query.data?.pages]
  );
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
      // The same slot a notification response fills, so the root layout owns
      // the organization switch and the navigation.
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
        const result = await query.refetch();
        if (result.isError) {
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

  let footer = <View style={{ height: paddingBottom }} pointerEvents="none" />;
  if (query.isFetchNextPageError) {
    footer = (
      <View className="pb-8">
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
                router.push(SETTINGS_ROUTE);
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
              title={t('notifications.history.emptyTitle')}
              description={t('notifications.history.emptyBody', {
                days: NOTIFICATION_HISTORY_RETENTION_DAYS,
              })}
            />
          ) : null}

          {!loading && !failure && hasListContent ? (
            <FlashList<HistoryRow>
              style={listStyle}
              data={items}
              keyExtractor={item => item.id}
              renderItem={renderItem}
              contentContainerStyle={listContentContainerStyle}
              refreshControl={refreshControl}
              onEndReached={() => {
                // Once the next page has failed, auto-loading re-fires on every
                // content-size change, so recovery waits for the footer's tap.
                if (
                  query.hasNextPage &&
                  !query.isFetchingNextPage &&
                  !query.isFetchNextPageError
                ) {
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
