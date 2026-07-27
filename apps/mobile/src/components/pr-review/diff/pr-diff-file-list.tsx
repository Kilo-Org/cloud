// PR diff viewer core: the file list that the orchestrator drops into
// `pr-review-files-tab.tsx` (replacing the S5 placeholder body).
//
// Architecture:
//   * A single FlashList with mixed item kinds (see `pr-diff-list-items`)
//   * `usePrReviewFileListQuery` drives a tRPC infinite query for `listFiles`
//   * `usePrReviewViewedFiles` reads + toggles the per-PR viewed set
//   * `useFetchToCompletion` lets S6c's navigator drive the query to its end
//   * `subscribeFileNavigatorRequest` is consumed here so a "scroll to file"
//     request (emitted by S6c) snaps the list to the right section
//   * S7a adds diff-line selection: tapping a line runs the pure
//     `selectLine` reducer; the result is mirrored into the
//     `diff-selection-bridge` (so the comment composer can read it on
//     mount) and a floating action bar (`PrDiffFloatingActions`)
//     hosts the "Comment" and "Finish review" affordances.
//
// Cold first paint: FlashList mounts only after the first page of files is
// present. The first-load waiting state is a plain skeleton outside the list
// (see `PrDiffFileListLoading`). Mounting the list on a single pagination-row
// loading item and then swapping in ~50 file rows left FlashList v2 with a
// full content height but zero mounted cells until the user scrolled; warm
// remounts already had data at mount and painted. Deferring the list mount
// makes cold match warm.

import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import {
  DiffFontMetricsContext,
  useBoundedDiffFontMetrics,
} from '@/components/pr-review/diff/diff-font-metrics';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import {
  PrDiffFileListHeader,
  useDiffViewMode,
} from '@/components/pr-review/diff/pr-diff-file-list-header';
import { PrDiffFileListLoading } from '@/components/pr-review/diff/pr-diff-file-list-loading';
import { PrDiffFloatingActions } from '@/components/pr-review/diff/pr-diff-floating-actions';
import { useDiffRenderItem } from '@/components/pr-review/diff/pr-diff-file-list-render';
import { useDiffSelection } from '@/components/pr-review/diff/use-diff-selection';
import {
  EmptyFilesView,
  LIST_CONTENT_STYLE,
  TabStateMessage,
} from '@/components/pr-review/diff/pr-diff-rows';
import { dedupeFilesByPath } from '@/lib/pr-review/diff/dedupe-file-pages';
import { buildItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { itemTypeFor, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { usePrDiffContextLoader } from '@/lib/pr-review/diff/use-pr-diff-context-loader';
import {
  useFetchToCompletion,
  usePrReviewFileListQuery,
  usePrReviewViewedFiles,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { usePrDiffListScroll } from '@/lib/pr-review/diff/use-pr-diff-list-scroll';
import { clearDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { useIsTablet } from '@/lib/hooks/use-is-tablet';

type PrReviewFileListProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly changedFiles: number;
  /** Optional callback for the 0-changed-files empty state. */
  readonly onRequestOverview?: () => void;
};

export function PrReviewFileList({
  owner,
  repo,
  number,
  headSha,
  changedFiles,
  onRequestOverview,
}: PrReviewFileListProps) {
  const listRef = useRef<FlashListRef<ListItem>>(null);
  // Bounded font-scale metrics for diff rows. We pass the scale into
  // `extraData` so FlashList re-measures every row when the user changes
  // a11y text size. The metrics are also provided via context so memoized
  // diff rows receive the live scale and resize to fit.
  const diffFontMetrics = useBoundedDiffFontMetrics();

  const { query, firstPageErrorState } = usePrReviewFileListQuery({
    owner,
    repo,
    number,
    enabled: true,
  });
  const viewed = usePrReviewViewedFiles({ owner, repo, number }, headSha);
  const fetchToCompletion = useFetchToCompletion(query, changedFiles);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { expandedContext, handleLoadContext } = usePrDiffContextLoader({
    owner,
    repo,
    headSha,
  });
  const { viewMode, setViewMode } = useDiffViewMode();
  const isTablet = useIsTablet();
  const { selection, selectionView, handleLineTap, clearSelection } = useDiffSelection({
    owner,
    repo,
    number,
    viewMode,
    isTablet,
  });

  // When the component unmounts (user navigates away from the PR or
  // pops the PR screen off the stack), drop the bridge so a stale
  // selection can never leak into the next mount. Re-mounting this
  // list always starts with no selection.
  useEffect(() => clearDiffSelection, []);

  const files = useMemo(() => {
    const all: PrReviewFile[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const f of page.files) {
        all.push(f);
      }
    }
    // Dedupe by path (first wins) so retry/refetch races cannot emit
    // duplicate `file-header:<path>` keys into FlashList.
    return dedupeFilesByPath(all);
  }, [query.data]);

  const viewedCount = useMemo(() => {
    let count = 0;
    for (const file of files) {
      if (viewed.isViewed(file.path)) {
        count += 1;
      }
    }
    return count;
  }, [files, viewed]);

  const items = useMemo(
    () =>
      buildItems({
        files,
        expanded,
        expandedContext,
        viewed: viewed.isViewed,
        headSha,
        owner,
        repo,
        number,
        changedFiles,
        isLoading: query.isLoading,
        isFetchingNextPage: query.isFetchingNextPage,
        hasNextPage: query.hasNextPage,
        laterPageError: query.isError && files.length > 0,
        fetchToCompletionRunning: fetchToCompletion.isRunning,
        fetchToCompletionLoaded: fetchToCompletion.loadedFiles,
        totalFiles: changedFiles,
        viewMode: isTablet ? viewMode : 'unified',
      }),
    [
      files,
      expanded,
      expandedContext,
      viewed,
      headSha,
      owner,
      repo,
      number,
      changedFiles,
      query.isLoading,
      query.isFetchingNextPage,
      query.hasNextPage,
      query.isError,
      fetchToCompletion.isRunning,
      fetchToCompletion.loadedFiles,
      viewMode,
      isTablet,
    ]
  );

  const { handleContentSizeChange } = usePrDiffListScroll({
    owner,
    repo,
    number,
    filesLength: files.length,
    items,
    listRef,
    setExpanded,
  });

  const renderItem = useDiffRenderItem({
    viewed,
    query,
    fetchToCompletion,
    handleLoadContext,
    setExpanded,
    onLineTap: handleLineTap,
    selection: selectionView,
  });

  if (files.length === 0) {
    if (firstPageErrorState?.kind === 'not-found') {
      return (
        <TabStateMessage
          title="Pull request unavailable"
          message="This PR can't be opened. It may have been deleted, the repository is private, or the Kilo GitHub App isn't installed on it."
        />
      );
    }
    if (firstPageErrorState?.kind === 'permission') {
      return (
        <TabStateMessage
          title="Access denied"
          message="You don't have permission to view this pull request."
        />
      );
    }
    if (firstPageErrorState?.kind === 'reconnect') {
      return (
        <View className="flex-1 items-center justify-center px-6 py-12">
          <PrReviewReconnectNotice />
        </View>
      );
    }
    if (firstPageErrorState?.kind === 'retryable') {
      return (
        <View className="flex-1">
          <QueryError
            variant="server"
            onRetry={() => {
              void query.refetch();
            }}
            isRetrying={query.isFetching}
          />
        </View>
      );
    }
  }

  if (!query.isLoading && files.length === 0) {
    return <EmptyFilesView changedFiles={changedFiles} onRequestOverview={onRequestOverview} />;
  }

  const isTruncated = query.hasNextPage || Boolean(fetchToCompletion.error);
  const effectiveViewMode = isTablet ? viewMode : 'unified';
  // First page still in flight: keep FlashList unmounted. A list that first
  // lays out a single loading pagination-row and later receives the real file
  // rows can measure full content height without mounting cells until scroll.
  const showFirstPageLoading = files.length === 0;

  return (
    <DiffFontMetricsContext.Provider value={diffFontMetrics}>
      <View className="flex-1" accessibilityLabel="Files list">
        <PrDiffFileListHeader
          owner={owner}
          repo={repo}
          number={number}
          viewedCount={viewedCount}
          totalListed={files.length}
          isTruncated={isTruncated}
          viewMode={effectiveViewMode}
          onViewModeChange={setViewMode}
        />
        {showFirstPageLoading ? (
          <PrDiffFileListLoading />
        ) : (
          <FlashList
            ref={listRef}
            data={items}
            renderItem={renderItem}
            keyExtractor={item => item.key}
            getItemType={item => itemTypeFor(item)}
            // Re-measure rows when the bounded font scale changes.
            extraData={diffFontMetrics.scale}
            onContentSizeChange={handleContentSizeChange}
            onEndReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) {
                void query.fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.5}
            contentContainerStyle={LIST_CONTENT_STYLE}
            ItemSeparatorComponent={null}
          />
        )}
        <PrDiffFloatingActions
          owner={owner}
          repo={repo}
          number={number}
          viewMode={effectiveViewMode}
          selection={selection}
          onClearSelection={clearSelection}
        />
      </View>
    </DiffFontMetricsContext.Provider>
  );
}
