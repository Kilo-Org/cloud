// PR diff viewer core: the file list that the orchestrator drops into
// `pr-review-files-tab.tsx` (replacing the S5 placeholder body).
//
// Architecture:
//   * A single FlashList with mixed item kinds (see `pr-diff-list-items`)
//   * `usePrReviewFileListQuery` drives a tRPC infinite query for `listFiles`
//     and produces a deduped `files` array via `flattenFilePages`
//   * `usePrReviewViewedFiles` reads + toggles the per-PR viewed set
//   * `useFetchToCompletion` lets the navigator drive the query to its end
//   * `subscribeFileNavigatorRequest` is consumed here so a "scroll to file"
//     request from the navigator sheet snaps the list to the right section
//   * S7a adds diff-line selection: tapping a line runs the pure
//     `selectLine` reducer; the result is mirrored into the
//     `diff-selection-bridge` (so the comment composer can read it on
//     mount) and a footer action bar (`PrDiffFloatingActions`) rendered
//     in-flow below the list hosts the "Comment" and "Finish review"
//     affordances.
//
// Cold first paint: FlashList mounts only after the first page of files is
// present. The first-load waiting state is a plain skeleton outside the list
// (see `PrDiffFileListLoading`). Mounting the list on a single pagination-row
// loading item and then swapping in ~50 file rows left FlashList v2 with a
// full content height but zero mounted cells until the user scrolled; warm
// remounts already had data at mount and painted. Deferring the list mount
// makes cold match warm.

import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, View } from 'react-native';

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
import { usePrDiffStateCopy } from '@/components/pr-review/diff/pr-diff-state-copy';
import { useProviderPrScope } from '@/lib/pr-review/provider-pr-ref';
import { useDiffRenderItem } from '@/components/pr-review/diff/pr-diff-file-list-render';
import { useDiffSelection } from '@/components/pr-review/diff/use-diff-selection';
import { EmptyFilesView, TabStateMessage } from '@/components/pr-review/diff/pr-diff-rows';
import { buildFileItems, buildPaginationItem } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { itemTypeFor, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { stickyFileHeaderIndices } from '@/lib/pr-review/diff/sticky-file-headers';
import { usePrDiffContextLoader } from '@/lib/pr-review/diff/use-pr-diff-context-loader';
import {
  useFetchToCompletion,
  usePrReviewFileListQuery,
  usePrReviewViewedFiles,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import { usePrDiffListScroll } from '@/lib/pr-review/diff/use-pr-diff-list-scroll';
import { clearDiffSelection } from '@/lib/pr-review/diff-selection-bridge';
import { CenteredState } from '@/components/centered-state';
import { useIsTablet } from '@/lib/hooks/use-is-tablet';

// Gap between the last diff row and the in-flow footer bar's top edge.
const PR_DIFF_LIST_FOOTER_GAP = 12;

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
  const { t } = useTranslation();
  // Bounded font-scale metrics for diff rows. We pass the scale into
  // `extraData` so FlashList re-measures every row when the user changes
  // a11y text size. The metrics are also provided via context so memoized
  // diff rows receive the live scale and resize to fit.
  const diffFontMetrics = useBoundedDiffFontMetrics();

  const { query, files, firstPageErrorState } = usePrReviewFileListQuery({
    owner,
    repo,
    number,
    enabled: true,
  });
  // The live provider scope: the viewed set is keyed by the ref (s6,
  // identity rule 17), so a GitLab MR and a same-numbered GitHub PR — or
  // one project on two GitLab instances — never share a set. On the GitHub
  // route the fallback ref is the triple itself, keeping the legacy bytes.
  const scope = useProviderPrScope({ owner, repo, number });
  const viewed = usePrReviewViewedFiles(scope.ref, headSha);
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
  useEffect(
    () => () => {
      clearDiffSelection({ owner, repo, number });
    },
    [owner, repo, number]
  );

  // The write bar renders on every provider (s6): its two routes — the
  // comment composer and the review-submit sheet — are siblings of the
  // GitHub route AND of the provider route, so the bar pushes the sheet
  // inside the scope its queries run under. The bar is an in-flow footer
  // below the list (spot check e3), so the list only keeps a small gap
  // between its last row and the footer's top edge.
  const listContentStyle = useMemo(() => ({ paddingBottom: PR_DIFF_LIST_FOOTER_GAP }), []);

  // Which provider's words the terminal and empty states use.
  const copy = usePrDiffStateCopy({ owner, repo, number });

  const viewedCount = useMemo(() => {
    let count = 0;
    for (const file of files) {
      if (viewed.isViewed(file.path)) {
        count += 1;
      }
    }
    return count;
  }, [files, viewed]);

  const effectiveViewMode = isTablet ? viewMode : 'unified';

  const fileItems = useMemo(
    () =>
      buildFileItems({
        files,
        expanded,
        expandedContext,
        viewed: viewed.isViewed,
        headSha,
        owner,
        repo,
        number,
        changedFiles,
        viewMode: effectiveViewMode,
        // Pagination fields — required by BuildItemsArgs but unused by buildFileItems.
        isLoading: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        laterPageError: false,
        fetchToCompletionRunning: false,
        fetchToCompletionLoaded: 0,
        totalFiles: null,
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
      effectiveViewMode,
    ]
  );

  const paginationItem = useMemo(
    () =>
      buildPaginationItem({
        files,
        expanded,
        expandedContext,
        viewed: viewed.isViewed,
        headSha,
        owner,
        repo,
        number,
        changedFiles,
        viewMode: effectiveViewMode,
        isLoading: query.isLoading,
        isFetchingNextPage: query.isFetchingNextPage,
        hasNextPage: query.hasNextPage,
        laterPageError: query.isError && files.length > 0,
        fetchToCompletionRunning: fetchToCompletion.isRunning,
        fetchToCompletionLoaded: fetchToCompletion.loadedFiles,
        totalFiles: changedFiles,
      }),
    // buildPaginationItem only reads the pagination-specific fields below;
    // the other fields are required by BuildItemsArgs but unused by this
    // builder so they must not force a rebuild when file-level state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      query.isLoading,
      query.isFetchingNextPage,
      query.hasNextPage,
      query.isError,
      files.length,
      fetchToCompletion.isRunning,
      fetchToCompletion.loadedFiles,
      changedFiles,
    ]
  );

  const items = useMemo(() => [...fileItems, paginationItem], [fileItems, paginationItem]);

  const stickyHeaderIndices = useMemo(() => stickyFileHeaderIndices(items), [items]);

  usePrDiffListScroll({
    owner,
    repo,
    number,
    items,
    listRef,
    setExpanded,
  });

  const onFetchAll = useCallback(() => {
    void fetchToCompletion.run();
    // fetchToCompletion.run is a stable useCallback reference; the full
    // fetchToCompletion object would change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchToCompletion.run]);

  const renderItem = useDiffRenderItem({
    viewed,
    onRetryPage: useCallback(() => {
      void query.fetchNextPage();
      // query.fetchNextPage is a stable reference in React Query v5;
      // depending on `query` would make this callback new on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query.fetchNextPage]),
    onFetchAll,
    handleLoadContext,
    setExpanded,
    onLineTap: handleLineTap,
    selection: selectionView,
  });

  if (files.length === 0) {
    if (firstPageErrorState?.kind === 'not-found') {
      return <TabStateMessage title={copy.unavailableTitle} message={copy.unavailableMessage} />;
    }
    if (firstPageErrorState?.kind === 'permission') {
      return (
        <TabStateMessage title={t('common.accessDenied')} message={copy.accessDeniedMessage} />
      );
    }
    if (firstPageErrorState?.kind === 'reconnect') {
      return (
        <CenteredState className="px-6">
          <PrReviewReconnectNotice />
        </CenteredState>
      );
    }
    if (firstPageErrorState?.kind === 'retryable') {
      return (
        <QueryError
          variant="server"
          onRetry={() => {
            void query.refetch();
          }}
          isRetrying={query.isFetching}
        />
      );
    }
  }

  if (!query.isLoading && files.length === 0) {
    return (
      <EmptyFilesView
        changedFiles={changedFiles}
        noChangesDescription={copy.noChangesDescription}
        onRequestOverview={onRequestOverview}
        refreshControl={
          changedFiles > 0 ? (
            <RefreshControl
              refreshing={query.isFetching}
              onRefresh={() => {
                void query.refetch();
              }}
            />
          ) : undefined
        }
      />
    );
  }

  const isTruncated = query.hasNextPage || Boolean(fetchToCompletion.error);
  // First page still in flight: keep FlashList unmounted. A list that first
  // lays out a single loading pagination-row and later receives the real file
  // rows can measure full content height without mounting cells until scroll.
  const showFirstPageLoading = files.length === 0;

  return (
    <DiffFontMetricsContext.Provider value={diffFontMetrics}>
      <View className="flex-1" accessibilityLabel={t('prReview.fileList.filesList')}>
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
            stickyHeaderIndices={stickyHeaderIndices}
            // Height changes above the viewport (expand / collapse-on-mark)
            // misfire mVCP and jump the list; gap-context insert after
            // scroll-away is rare and acceptable without anchor hold.
            maintainVisibleContentPosition={{ disabled: true }}
            // Re-measure rows when the bounded font scale changes.
            extraData={diffFontMetrics.scale}
            onEndReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) {
                void query.fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.5}
            contentContainerStyle={listContentStyle}
            ItemSeparatorComponent={null}
          />
        )}
        <PrDiffFloatingActions
          owner={owner}
          repo={repo}
          number={number}
          prRef={scope.ref.platform === 'github' ? undefined : scope.ref}
          viewMode={effectiveViewMode}
          selection={selection}
          onClearSelection={clearSelection}
        />
      </View>
    </DiffFontMetricsContext.Provider>
  );
}
