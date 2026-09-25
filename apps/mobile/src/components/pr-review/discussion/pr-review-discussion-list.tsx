// Happy-path FlashList for the Discussion tab (extracted so the tab stays
// under the max-lines cap). Expansion state and settle bookkeeping stay in
// the tab; this file only renders the virtualized list.

import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { CommentRow } from '@/components/pr-review/discussion/comment-row';
import { DiscussionThread } from '@/components/pr-review/discussion/discussion-thread';
import { Button } from '@/components/ui/button';
import { MessageSquarePlus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  type DiscussionListItem,
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { expandedForThread } from '@/lib/pr-review/discussion/thread-expansion';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';
import { useProviderPrScope } from '@/lib/pr-review/provider-pr-ref';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { useTRPC } from '@/lib/trpc';

const noopReactionToggle = () => {
  // Conversation comments are read-only (A2.3): no reaction mutations.
};

type PrReviewDiscussionListProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly listItems: readonly DiscussionListItem[];
  readonly listRef: RefObject<FlashListRef<DiscussionListItem> | null>;
  readonly expansion: Record<string, boolean>;
  readonly suppressContentPosition: boolean;
  readonly onToggleExpand: (thread: ReviewThread, index: number) => void;
  readonly onScrollBeginDrag: () => void;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly laterPageError: boolean;
  readonly onLoadMore: () => void;
  readonly onRetryLoadMore: () => void;
  /**
   * Invoked when a thread row's inline reply field gains focus, with the
   * row's index. The tab scrolls the row above the keyboard-lifted bottom
   * CTA bar (useReplyFocusScroll). Optional; absent = no scroll handling.
   */
  readonly onReplyInputFocus?: (index: number) => void;
  /**
   * Invoked with the list viewport's height on every layout commit. The tab
   * anchors the keyboard-open reply scroll on the COMMITTED viewport — the
   * CTA bar's keyboard lift lands asynchronously and shrinks this frame
   * (useReplyFocusScroll). Optional; absent = no viewport reporting.
   */
  readonly onViewportLayout?: (height: number) => void;
  /**
   * The tab's empty state, rendered instead of the rows when the blocked /
   * muted filter removes every loaded row. The tab decides "empty" from the
   * unfiltered page, so without this the body would render nothing at all.
   * The copy stays the tab's: it is the same surface, and a distinct message
   * needs a catalog key the translation slice owns.
   */
  readonly emptyState?: ReactNode;
};

export function PrReviewDiscussionList({
  owner,
  repo,
  number,
  listItems,
  listRef,
  expansion,
  suppressContentPosition,
  onToggleExpand,
  onScrollBeginDrag,
  hasNextPage,
  isFetchingNextPage,
  laterPageError,
  onLoadMore,
  onRetryLoadMore,
  onReplyInputFocus,
  onViewportLayout,
  emptyState,
}: Readonly<PrReviewDiscussionListProps>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  // Provider noun for the empty message below (GitLab calls it a merge
  // request); the same scope the tab reads for its own copy.
  const { ref } = useProviderPrScope({ owner, repo, number });
  const isMergeRequest = ref.platform === 'gitlab';
  // Account-local hidden users (blocked + muted GitHub logins) filter rows.
  const hiddenUsers = useQuery(trpc.moderation.listHiddenUsers.queryOptions());
  // Viewer login for self-target gating on the comment overflow menu. The
  // overview goes through the provider seam, not `githubPrReview` directly:
  // this list also renders under a GitLab MR / Bitbucket PR scope, where the
  // GitHub-shaped triple is a synthesized stand-in and a GitHub call with it
  // would fail on every render. On GitHub the key is unchanged, so this
  // still dedupes with the screen's own overview query.
  const queries = useProviderPrQueries({ owner, repo, number });
  const pr = useQuery(queries.overviewOptions());
  const viewerLogin = pr.data?.repo.viewerLogin ?? null;

  const hiddenLogins = useMemo(() => {
    const set = new Set<string>();
    for (const login of hiddenUsers.data?.blockedLogins ?? []) {
      set.add(login.toLowerCase());
    }
    for (const login of hiddenUsers.data?.mutedLogins ?? []) {
      set.add(login.toLowerCase());
    }
    return set;
  }, [hiddenUsers.data]);

  // Hide rows whose author is hidden. Conversation comments drop whole; a
  // mixed-author thread keeps its visible comments and drops only when empty.
  const visibleItems = useMemo(() => {
    const result: DiscussionListItem[] = [];
    for (const item of listItems) {
      if (item.kind === 'comment') {
        const login = item.comment.author?.login;
        if (login == null || !hiddenLogins.has(login.toLowerCase())) {
          result.push(item);
        }
      } else {
        const visibleComments = item.thread.comments.filter(
          comment =>
            comment.author?.login == null || !hiddenLogins.has(comment.author.login.toLowerCase())
        );
        if (visibleComments.length > 0) {
          result.push({ kind: 'thread', thread: { ...item.thread, comments: visibleComments } });
        }
      }
    }
    return result;
  }, [listItems, hiddenLogins]);

  // Landscape: side insets keep comment/thread cards clear of the sensor
  // housing (rows keep their px-4 gutter, so the insets add to it); portrait
  // insets are zero, so the style carries explicit zeros and nothing else
  // changes.
  const insets = useSafeAreaInsets();
  const contentContainerStyle = useMemo<ViewStyle>(
    () => ({ paddingTop: 12, paddingLeft: insets.left, paddingRight: insets.right }),
    [insets.left, insets.right]
  );

  // Every loaded row belongs to a blocked or muted author. An empty FlashList
  // draws nothing, so the body would read as blank with no explanation. The
  // tab hands down the empty state it already owns for this surface; the
  // footer stays mounted so later pages (whose rows may be visible) and a
  // later-page retry stay reachable from the filtered body.
  if (visibleItems.length === 0 && emptyState) {
    return (
      <View className="flex-1">
        {emptyState}
        <ListFooter
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          laterPageError={laterPageError}
          onLoadMore={onLoadMore}
          onRetryLoadMore={onRetryLoadMore}
        />
      </View>
    );
  }

  return (
    <FlashList
      ref={listRef}
      data={visibleItems}
      extraData={expansion}
      keyExtractor={keyForItem}
      getItemType={item => item.kind}
      onScrollBeginDrag={onScrollBeginDrag}
      // Stays enabled (load-more inserts rows mid-list); the tab disables it
      // only for the exact commit of a deferred expand — see its comment.
      maintainVisibleContentPosition={{ disabled: suppressContentPosition }}
      renderItem={({ item, index }) => {
        if (item.kind === 'comment') {
          return (
            <View className="px-4 pb-3">
              <View className="gap-2.5 rounded-xl border border-border bg-card p-3.5">
                <CommentRow
                  comment={item.comment}
                  owner={owner}
                  repo={repo}
                  number={number}
                  commentKind="conversation"
                  readOnly
                  // s6: reactions render only when the provider exposes them;
                  // a provider without them shows no reaction row at all.
                  reactionsSupported={queries.capabilities.reactions.supported}
                  viewerLogin={viewerLogin}
                  onToggleReaction={noopReactionToggle}
                />
              </View>
            </View>
          );
        }
        const thread = item.thread;
        return (
          <View className="px-4 pb-3">
            <DiscussionThread
              owner={owner}
              repo={repo}
              number={number}
              thread={thread}
              viewerLogin={viewerLogin}
              expanded={expandedForThread(expansion, thread.threadId, thread.isResolved)}
              onToggleExpand={() => {
                onToggleExpand(thread, index);
              }}
              onReplyFocus={() => {
                onReplyInputFocus?.(index);
              }}
            />
          </View>
        );
      }}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      onLayout={event => {
        onViewportLayout?.(event.nativeEvent.layout.height);
      }}
      ListEmptyComponent={
        // Every loaded row can be hidden (blocked/muted authors) while the
        // tab still counts the discussion as content. Without this the list
        // renders an empty body under the pinned Comment bar: no rows, no
        // loading, no message (spot check e7). The copy is the discussion's
        // existing empty copy — new copy belongs to the translation slice.
        <EmptyState
          placement="top"
          icon={MessageSquarePlus}
          title={t('prReview.discussion.noDiscussion')}
          description={
            isMergeRequest
              ? t('prReview.terms.noDiscussionDescription')
              : t('prReview.discussion.noDiscussionDescription')
          }
        />
      }
      ListFooterComponent={
        <ListFooter
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          laterPageError={laterPageError}
          onLoadMore={onLoadMore}
          onRetryLoadMore={onRetryLoadMore}
        />
      }
    />
  );
}

function keyForItem(item: DiscussionListItem): string {
  return item.kind === 'thread'
    ? `thread:${item.thread.threadId}`
    : `comment:${item.comment.nodeId}`;
}

type ListFooterProps = {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly laterPageError: boolean;
  readonly onLoadMore: () => void;
  readonly onRetryLoadMore: () => void;
};

function ListFooter({
  hasNextPage,
  isFetchingNextPage,
  laterPageError,
  onLoadMore,
  onRetryLoadMore,
}: Readonly<ListFooterProps>) {
  // The footer is the last list content, so it owns the bottom clearance
  // that keeps the final row and every next action above the system bar.
  const { t } = useTranslation();
  const paddingBottom = useDetailScreenBottomPadding();

  if (laterPageError) {
    return (
      <View className="items-center gap-2 px-4 pt-2" style={{ paddingBottom }}>
        <Text variant="muted" className="text-center text-xs">
          {t('prReview.discussion.couldNotLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={onRetryLoadMore}
          accessibilityLabel={t('prReview.discussion.retryLoadingMore')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }
  if (!hasNextPage) {
    return <View style={{ height: paddingBottom }} />;
  }
  return (
    <View className="items-center px-4 pt-2" style={{ paddingBottom }}>
      <Button
        size="sm"
        variant="outline"
        loading={isFetchingNextPage}
        onPress={onLoadMore}
        accessibilityLabel={t('prReview.discussion.loadMoreComments')}
      >
        <Text>{t('common.loadMore')}</Text>
      </Button>
    </View>
  );
}
