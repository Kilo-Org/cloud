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
//
// Happy-path list lives in discussion/pr-review-discussion-list.tsx
// (max-lines extraction). Expansion settle bookkeeping stays here.

import { type FlashListRef } from '@shopify/flash-list';
import { MessageSquarePlus } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { PrReviewDiscussionList } from '@/components/pr-review/discussion/pr-review-discussion-list';
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
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import {
  expandedForThread,
  expandThread,
  seedThreadExpansion,
  shouldDeferExpand,
  toggleThreadExpanded,
} from '@/lib/pr-review/discussion/thread-expansion';
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

  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const expansionRef = useRef(expansion);
  const listRef = useRef<FlashListRef<DiscussionListItem>>(null);
  const settleGenerationRef = useRef(0);
  const settleThreadIdRef = useRef<string | null>(null);

  // Single write path: the ref is the tap-time source of truth (render-closure
  // state can lag a queued update on rapid taps).
  const applyExpansion = (next: Record<string, boolean>) => {
    expansionRef.current = next;
    setExpansion(next);
  };

  // First-sight seeding: a resolve/unresolve must NOT change expansion (see
  // thread-expansion.ts). No-op on the loading branch (threads is []).
  useEffect(() => {
    const seeded = seedThreadExpansion(expansionRef.current, threads);
    if (seeded !== expansionRef.current) {
      applyExpansion(seeded);
    }
  }, [threads]);

  // A data change mid-settle (load-more re-sort, optimistic mutation) cancels the
  // settle: the captured scroll index can point at a different row after a re-sort.
  // The user taps again; a wrong-row settle is worse.
  useEffect(() => {
    settleGenerationRef.current += 1;
    settleThreadIdRef.current = null;
  }, [threads]);

  // Unmount cancels any in-flight settle.
  useEffect(
    () => () => {
      settleGenerationRef.current += 1;
      settleThreadIdRef.current = null;
    },
    []
  );

  const invalidateSettle = () => {
    settleGenerationRef.current += 1;
    settleThreadIdRef.current = null;
  };

  const handleToggleExpand = (thread: ReviewThread, index: number) => {
    // Same-thread retap during an in-flight settle: cancel that settle, then run
    // THIS tap's path below (cancel + supersede — never two concurrent settles,
    // and exactly one expand results, which E2E flow 7a asserts).
    if (settleThreadIdRef.current === thread.threadId) {
      invalidateSettle();
    }
    const expanded = expandedForThread(expansionRef.current, thread.threadId, thread.isResolved);
    if (!expanded) {
      const layout = listRef.current?.getLayout(index);
      const rowTop = layout ? layout.y + (listRef.current?.getFirstItemOffset() ?? 0) : null;
      const offset = listRef.current?.getAbsoluteLastScrollOffset() ?? 0;
      if (shouldDeferExpand(rowTop, offset)) {
        settleGenerationRef.current += 1;
        const generation = settleGenerationRef.current;
        settleThreadIdRef.current = thread.threadId;
        void (async () => {
          await listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true });
          if (settleGenerationRef.current === generation) {
            settleThreadIdRef.current = null;
            applyExpansion(expandThread(expansionRef.current, thread.threadId));
          }
        })();
        return;
      }
    }
    applyExpansion(toggleThreadExpanded(expansionRef.current, thread.threadId, thread.isResolved));
  };

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
    <PrReviewDiscussionList
      owner={owner}
      repo={repo}
      number={number}
      listItems={listItems}
      listRef={listRef}
      expansion={expansion}
      onToggleExpand={handleToggleExpand}
      onScrollBeginDrag={invalidateSettle}
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
  );
}
