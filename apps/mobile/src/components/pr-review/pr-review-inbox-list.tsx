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
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { type PrInboxView, selectPrInboxView } from '@/components/pr-review/pr-review-inbox-view';
import { Button } from '@/components/ui/button';
import { Clock, GitPullRequest, Inbox } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  providerPrRefLabel,
  providerPrRoutePath,
  providerPrTermKey,
} from '@/lib/pr-review/provider-pr-ref';
import { type ProviderInboxRow, useProviderInbox } from '@/lib/pr-review/use-provider-inbox';
import { parseTimestamp, timeAgo } from '@/lib/utils';

const SKELETON_ROW_COUNT = 5;

type InboxItem = ProviderInboxRow;

type PrReviewInboxListProps = {
  /** The "Paste a PR link" block, rendered above the Inbox eyebrow. */
  header: ReactNode;
  /** The recents body, rendered below the pagination footer. */
  recents: ReactNode;
};

export function PrReviewInboxList({ header, recents }: Readonly<PrReviewInboxListProps>) {
  const inbox = useProviderInbox(true);
  // Two different retries, because they recover two different failures: the
  // empty-state CTA re-runs the inbox from scratch, while the footer CTA must
  // load only the page (or the provider) that failed — re-fetching pages the
  // list already shows would never load the missing one.
  const handleRetry = () => {
    inbox.refetch();
  };
  const handleRetryMore = () => {
    inbox.retryFailedPages();
  };
  const reconnectOnly = inbox.githubNeedsReconnect && !inbox.isPending && inbox.items.length === 0;
  const view = selectPrInboxView({
    isLoading: inbox.isPending,
    itemCount: inbox.items.length,
    firstPageErrorState:
      inbox.firstPageErrorState ?? (reconnectOnly ? { kind: 'reconnect' } : null),
    laterPageError: inbox.laterPageError,
  });
  // A provider outage that left the merged list empty is the retryable view
  // itself (`selectPrInboxView`), so the empty state can no longer sit beside
  // this footer. Only the reconnect notice stays a first-page state: a provider
  // that also failed beside it keeps the inline retry for its own page.
  const showLoadMoreRetry =
    view.showLoadMoreRetry || (view.kind === 'reconnect' && inbox.laterPageError);

  // Landscape: side insets keep inbox rows and the px-6 header/footer
  // content clear of the sensor housing; portrait insets are zero, so the
  // style carries explicit zeros and nothing else changes.
  const insets = useSafeAreaInsets();
  const contentContainerStyle = useMemo<ViewStyle>(
    () => ({ paddingLeft: insets.left, paddingRight: insets.right }),
    [insets.left, insets.right]
  );

  return (
    <FlashList
      data={view.kind === 'happy' ? inbox.items : []}
      keyExtractor={item => item.key}
      renderItem={({ item }) => <InboxRow item={item} />}
      ListHeaderComponent={
        <View className="gap-6 px-6 pt-4">
          {header}
          <InboxEyebrow />
        </View>
      }
      ListEmptyComponent={
        <InboxEmpty view={view} onRetry={handleRetry} isRetrying={inbox.isFetching} />
      }
      ListFooterComponent={
        <View className="gap-6 px-6 pb-12 pt-4">
          {inbox.githubNeedsReconnect && view.kind !== 'reconnect' ? (
            <PrReviewReconnectNotice />
          ) : null}
          {showLoadMoreRetry ? <LoadMoreRetry onRetry={handleRetryMore} /> : null}
          <RecentEyebrow />
          {recents}
        </View>
      }
      onEndReached={() => {
        if (inbox.hasNextPage && !inbox.isFetchingNextPage) {
          inbox.fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={contentContainerStyle}
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
        {t('common.recent')}
      </Text>
    </View>
  );
}

function InboxRow({ item }: Readonly<{ item: InboxItem }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const updatedLabel = timeAgo(parseTimestamp(item.updatedAt));
  // `group/sub/repo!12` on GitLab, `owner/repo#7` elsewhere — the row says
  // which provider it came from before the term chip repeats it in words.
  const rowLabel = providerPrRefLabel(item.ref);

  return (
    <Pressable
      onPress={() => {
        router.push(providerPrRoutePath(item.ref));
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
          {/* The ref · age is the row's flexible value: a nested GitLab path or
              a long owner/repo (#2 `discussion-conversation-only`) is wider than
              the row, so without `min-w-0 shrink` the text keeps its intrinsic
              width and pushes the provider chip past the px-6 edge, where the
              parent clips the pill to "Pull re" and hides its rounded end.
              Truncate the metadata to one line instead; the chip is the row's
              identity and must stay whole. Same pattern as `PrRefsRow` in
              pr-review-overview-parts.tsx. */}
          <Text variant="muted" className="min-w-0 shrink text-xs" numberOfLines={1}>
            {rowLabel} · {updatedLabel}
          </Text>
          <InboxChip label={t(providerPrTermKey(item.ref.platform))} />
          {item.isDraft ? <InboxChip label={t('common.draft')} /> : null}
        </View>
      </View>
      <DirectionalChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

function InboxChip({ label }: Readonly<{ label: string }>) {
  return (
    <View className="shrink-0 rounded-full bg-secondary px-2 py-0.5">
      <Text variant="muted" className="text-[10px] font-medium">
        {label}
      </Text>
    </View>
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
        {t('common.couldnTLoadMore')}
      </Text>
      <Button
        size="sm"
        variant="outline"
        onPress={onRetry}
        accessibilityLabel={t('common.retryLoadingMore')}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
