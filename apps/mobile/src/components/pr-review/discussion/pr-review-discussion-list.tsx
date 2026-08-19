// Happy-path FlashList for the Discussion tab (extracted so the tab stays
// under the max-lines cap). Expansion state and settle bookkeeping stay in
// the tab; this file only renders the virtualized list.

import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useQuery } from '@tanstack/react-query';
import { type RefObject, useMemo } from 'react';
import { View } from 'react-native';

import { CommentRow } from '@/components/pr-review/discussion/comment-row';
import { DiscussionThread } from '@/components/pr-review/discussion/discussion-thread';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type DiscussionListItem,
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { expandedForThread } from '@/lib/pr-review/discussion/thread-expansion';
import { useTRPC } from '@/lib/trpc';

const DISCUSSION_LIST_CONTENT_STYLE = { paddingTop: 12 };
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
}: Readonly<PrReviewDiscussionListProps>) {
  const trpc = useTRPC();
  // Account-local hidden users (blocked + muted GitHub logins) filter rows.
  const hiddenUsers = useQuery(trpc.moderation.listHiddenUsers.queryOptions());
  // Viewer login for self-target gating on the comment overflow menu.
  const pr = useQuery(trpc.githubPrReview.getPullRequest.queryOptions({ owner, repo, number }));
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
                  readOnly
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
            />
          </View>
        );
      }}
      contentContainerStyle={DISCUSSION_LIST_CONTENT_STYLE}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
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
  if (laterPageError) {
    return (
      <View className="items-center gap-2 px-4 pb-8 pt-2">
        <Text variant="muted" className="text-center text-xs">
          Could not load more comments.
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={onRetryLoadMore}
          accessibilityLabel="Retry loading more comments"
        >
          <Text>Retry</Text>
        </Button>
      </View>
    );
  }
  if (!hasNextPage) {
    return <View className="h-6" />;
  }
  return (
    <View className="items-center px-4 pb-8 pt-2">
      <Button
        size="sm"
        variant="outline"
        loading={isFetchingNextPage}
        onPress={onLoadMore}
        accessibilityLabel="Load more comments"
      >
        <Text>Load more</Text>
      </Button>
    </View>
  );
}
