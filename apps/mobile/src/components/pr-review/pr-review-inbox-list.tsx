// PR inbox list: the entry screen's single scroll container.
//
// The screen keeps its ScreenHeader and the paste-a-link + recents
// state; this component owns the ONE FlashList that composes the whole
// body. The paste block and recents are passed in and rendered in the
// list header/footer so they stay mounted in every inbox state (E4/E5
// depend on reaching Recents right after a failed open). Inbox states
// render inside `ListEmptyComponent` — never as a replacement for the
// screen.

import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { type PrInboxView, selectPrInboxView } from '@/components/pr-review/pr-review-inbox-view';
import { Button } from '@/components/ui/button';
import { ChevronRight, Clock, GitPullRequest, Inbox } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { usePrInbox } from '@/lib/pr-review/use-pr-inbox';
import { parseTimestamp, timeAgo } from '@/lib/utils';

const SKELETON_ROW_COUNT = 5;

type InboxItem = ReturnType<typeof usePrInbox>['items'][number];

type PrReviewInboxListProps = {
  /** The "Paste a PR link" block, rendered above the Inbox eyebrow. */
  header: ReactNode;
  /** The recents body, rendered below the pagination footer. */
  recents: ReactNode;
};

export function PrReviewInboxList({ header, recents }: Readonly<PrReviewInboxListProps>) {
  const { query, items, firstPageErrorState, laterPageError } = usePrInbox(true);
  const view = selectPrInboxView({
    isLoading: query.isPending,
    itemCount: items.length,
    firstPageErrorState,
    laterPageError,
  });

  return (
    <FlashList
      data={view.kind === 'happy' ? items : []}
      keyExtractor={item => `${item.owner}/${item.repo}#${item.number}`}
      renderItem={({ item }) => <InboxRow item={item} />}
      ListHeaderComponent={
        <View className="gap-6 px-6 pt-4">
          {header}
          <InboxEyebrow />
        </View>
      }
      ListEmptyComponent={
        <InboxEmpty
          view={view}
          onRetry={() => {
            void query.refetch();
          }}
          isRetrying={query.isFetching}
        />
      }
      ListFooterComponent={
        <View className="gap-6 px-6 pb-12 pt-4">
          {view.showLoadMoreRetry ? (
            <LoadMoreRetry
              onRetry={() => {
                void query.fetchNextPage();
              }}
            />
          ) : null}
          <RecentEyebrow />
          {recents}
        </View>
      }
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    />
  );
}

function InboxEyebrow() {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-2">
      <Inbox size={16} color={colors.mutedForeground} />
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.inbox.title')}
      </Text>
    </View>
  );
}

function RecentEyebrow() {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-2">
      <Clock size={16} color={colors.mutedForeground} />
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.inbox.recent')}
      </Text>
    </View>
  );
}

function InboxRow({ item }: Readonly<{ item: InboxItem }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const updatedLabel = timeAgo(parseTimestamp(item.updatedAt));
  const rowLabel = `${item.owner}/${item.repo}#${item.number}`;

  return (
    <Pressable
      onPress={() => {
        router.push(getPrReviewPath(item.owner, item.repo, item.number));
      }}
      accessibilityRole="button"
      accessibilityLabel={rowLabel}
      className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft px-6 py-3 active:opacity-70"
    >
      <View className="flex-1 gap-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {item.title}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text variant="muted" className="text-xs">
            {item.owner}/{item.repo}#{item.number} · {updatedLabel}
          </Text>
          {item.isDraft ? (
            <View className="rounded-full bg-secondary px-2 py-0.5">
              <Text variant="muted" className="text-[10px] font-medium">
                {t('prReview.inbox.draft')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <ChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

function InboxEmpty({
  view,
  onRetry,
  isRetrying,
}: Readonly<{ view: PrInboxView; onRetry: () => void; isRetrying: boolean }>) {
  const { t } = useTranslation();
  if (view.kind === 'loading') {
    return (
      <View accessibilityLabel={t('prReview.inbox.loading')}>
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
          // eslint-disable-next-line react/no-array-index-key -- skeleton placeholders have no stable id
          <View key={index} className="gap-2 border-b-[0.5px] border-hair-soft px-6 py-3">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </View>
        ))}
      </View>
    );
  }

  if (view.kind === 'empty') {
    return (
      <EmptyState
        icon={GitPullRequest}
        title={t('prReview.inbox.noReviewRequests')}
        description={t('prReview.inbox.noReviewRequestsDescription')}
        placement="top"
      />
    );
  }

  if (view.kind === 'permission') {
    return <QueryError variant="permission" placement="top" />;
  }

  if (view.kind === 'not-found') {
    return <QueryError variant="not-found" placement="top" />;
  }

  if (view.kind === 'reconnect') {
    return (
      <View className="px-6 py-6">
        <PrReviewReconnectNotice />
      </View>
    );
  }

  // retryable
  return (
    <QueryError
      variant="server"
      title={t('prReview.inbox.couldNotLoad')}
      placement="top"
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
}

function LoadMoreRetry({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-2">
      <Text variant="muted" className="text-center text-xs">
        {t('prReview.inbox.couldNotLoadMore')}
      </Text>
      <Button
        size="sm"
        variant="outline"
        onPress={onRetry}
        accessibilityLabel={t('prReview.inbox.retryLoadingMore')}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
