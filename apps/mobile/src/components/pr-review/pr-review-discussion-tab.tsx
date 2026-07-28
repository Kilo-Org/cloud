// PR review Discussion tab body.
//
// State matrix (per S7b §6 Discussion + Batch F item 2):
//   - happy:        one merged ascending list of review threads and
//                   conversation comments; first page auto-loads,
//                   "Load more" paginates threads. Full re-sort of
//                   the entire loaded set on every update (R4: a
//                   later page can insert rows mid-list).
//   - loading:      first page in flight; render `Skeleton`
//                   placeholders matching the row dimensions.
//   - retryable:    first page failed with a transient error;
//                   render `QueryError` with the standard Retry
//                   CTA wired to `refetch()`.
//   - permission:   first page failed with FORBIDDEN / UNAUTHORIZED;
//                   terminal message, no CTA (per the repo's
//                   rule that permanent permission errors must not
//                   offer a retry).
//   - not-found:    first page failed with NOT_FOUND; terminal
//                   message, no CTA (the PR is gone).
//   - reconnect:    first page failed with PRECONDITION_FAILED;
//                   terminal message pointing the user at the
//                   connect gate (the connect flow is owned by the
//                   screen-level `PrReviewConnectGate`, which is
//                   already mounted by the parent screen).
//   - empty:        first page returned zero threads AND zero
//                   conversation comments AND no terminal error;
//                   render `EmptyState` with copy covering both
//                   kinds and a "Review files" CTA that switches
//                   to the Files tab via `onRequestFiles`.
//
//   - later-page error: a per-page refetch failure during a
//                       "Load more" tap. The current loaded
//                       items are kept and a small retry row
//                       renders at the bottom of the list.
//
// The component does NOT own a ScrollView — the tab is mounted
// inside the screen's tab shell and needs a fresh FlatList so the
// list can virtualize when a PR has hundreds of threads. (Same
// approach as the Files tab.)

import { FlashList } from '@shopify/flash-list';
import { MessageSquarePlus } from 'lucide-react-native';
import { View } from 'react-native';

import { CommentRow } from '@/components/pr-review/discussion/comment-row';
import { DiscussionThread } from '@/components/pr-review/discussion/discussion-thread';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type DiscussionListItem,
  isDiscussionEmpty,
  mergeDiscussionListItems,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { usePrReviewDiscussionThreads } from '@/lib/pr-review/discussion/use-pr-review-discussion-threads';

type PrReviewDiscussionTabProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /**
   * Invoked by the empty state to switch to the Files tab.
   * Optional; if absent, the CTA is hidden.
   */
  readonly onRequestFiles?: () => void;
};

const SKELETON_ROW_COUNT = 4;
const DISCUSSION_LIST_CONTENT_STYLE = { paddingTop: 12 };
const noopReactionToggle = () => {
  // Conversation comments are read-only (A2.3): no reaction mutations.
};

export function PrReviewDiscussionTab({
  owner,
  repo,
  number,
  onRequestFiles,
}: PrReviewDiscussionTabProps) {
  const { query, threads, conversation, firstPageErrorState, laterPageError } =
    usePrReviewDiscussionThreads({
      owner,
      repo,
      number,
    });

  // ── First-page error / terminal states ─────────────────────────────
  if (firstPageErrorState) {
    if (firstPageErrorState.kind === 'permission') {
      return (
        <QueryError
          variant="permission"
          title="Access denied"
          message="You don't have permission to view this PR's discussion."
        />
      );
    }
    if (firstPageErrorState.kind === 'not-found') {
      return (
        <QueryError
          variant="not-found"
          title="Discussion unavailable"
          message="This pull request may have been removed."
        />
      );
    }
    if (firstPageErrorState.kind === 'reconnect') {
      return (
        <View className="flex-1 items-center justify-center px-6 py-12">
          <PrReviewReconnectNotice />
        </View>
      );
    }
    // retryable
    return (
      <QueryError
        variant="server"
        title="Could not load discussion"
        message="Something went wrong on our end. Please try again."
        onRetry={() => {
          void query.refetch();
        }}
        isRetrying={query.isFetching}
      />
    );
  }

  // ── Loading (first page in flight) ─────────────────────────────────
  if (query.isPending) {
    return (
      <View accessibilityLabel="Loading discussion" className="flex-1 gap-3 px-4 pb-6 pt-3">
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
          // eslint-disable-next-line react/no-array-index-key -- skeleton placeholders have no stable id
          <View key={index} className="gap-2 rounded-xl border border-border bg-card p-3.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </View>
        ))}
      </View>
    );
  }

  // ── Empty (neither threads nor conversation comments) ──────────────
  if (isDiscussionEmpty(threads, conversation)) {
    return (
      <View className="flex-1 px-4 pb-6">
        <EmptyState
          icon={MessageSquarePlus}
          title="No discussion yet"
          description="No review threads or conversation comments on this pull request."
          action={
            onRequestFiles ? (
              <Button variant="outline" onPress={onRequestFiles} accessibilityLabel="Review files">
                <Text>Review files</Text>
              </Button>
            ) : null
          }
        />
      </View>
    );
  }

  // ── Happy / paginated list ─────────────────────────────────────────
  // Full re-sort of every loaded thread + first-page conversation
  // comments (R4: "Load more" may insert rows mid-list; accepted).
  const listItems = mergeDiscussionListItems(threads, conversation);

  return (
    <FlashList
      data={listItems}
      keyExtractor={keyForItem}
      getItemType={item => item.kind}
      renderItem={({ item }) => {
        if (item.kind === 'comment') {
          return (
            <View className="px-4 pb-3">
              <View className="gap-2.5 rounded-xl border border-border bg-card p-3.5">
                <CommentRow
                  comment={item.comment}
                  reactionsDisabled
                  onToggleReaction={noopReactionToggle}
                />
              </View>
            </View>
          );
        }
        return (
          <View className="px-4 pb-3">
            <DiscussionThread owner={owner} repo={repo} number={number} thread={item.thread} />
          </View>
        );
      }}
      contentContainerStyle={DISCUSSION_LIST_CONTENT_STYLE}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      ListFooterComponent={
        <ListFooter
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          laterPageError={laterPageError}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
          onRetryLoadMore={() => {
            void query.refetch();
          }}
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

// ── Footer (Load more / error row) ───────────────────────────────────

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
