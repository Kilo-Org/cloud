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

import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { DiffLine } from '@/components/pr-review/diff/diff-line';
import {
  EmptyFilesView,
  ExpandSeparatorRow,
  FileHeaderRow,
  HunkHeaderRow,
  LIST_CONTENT_STYLE,
  PaginationRow,
  PatchMissingRow,
  TabStateMessage,
  TruncationBannerRow,
} from '@/components/pr-review/diff/pr-diff-rows';
import { buildItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { fileHeaderKey, itemTypeFor, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { usePrDiffContextLoader } from '@/lib/pr-review/diff/use-pr-diff-context-loader';
import {
  type PrReviewFile,
  useFetchToCompletion,
  usePrReviewFileListQuery,
  usePrReviewViewedFiles,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import {
  type FileNavigatorRequest,
  subscribeFileNavigatorRequest,
} from '@/lib/pr-review/file-navigator-bridge';

export type PrReviewFileListProps = {
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

  const files = useMemo(() => {
    const all: PrReviewFile[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const f of page.files) {
        all.push(f);
      }
    }
    return all;
  }, [query.data]);

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
    ]
  );

  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item) {
        map.set(item.key, index);
      }
    }
    return map;
  }, [items]);
  const indexByKeyRef = useRef(indexByKey);
  indexByKeyRef.current = indexByKey;

  useEffect(() => {
    const unsubscribe = subscribeFileNavigatorRequest(
      { owner, repo, number },
      (request: FileNavigatorRequest) => {
        const targetKey = fileHeaderKey(request.path);
        const index = indexByKeyRef.current.get(targetKey);
        if (typeof index === 'number' && index !== -1) {
          setExpanded(prev => (prev[request.path] ? prev : { ...prev, [request.path]: true }));
          void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
        }
      }
    );
    return unsubscribe;
  }, [owner, repo, number]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      switch (item.kind) {
        case 'truncation-banner': {
          return <TruncationBannerRow text={item.text} />;
        }
        case 'file-header': {
          return (
            <FileHeaderRow
              file={item.file}
              expanded={item.expanded}
              hasDiff={item.hasDiff}
              viewed={item.viewed}
              onToggleExpand={() => {
                setExpanded(prev => ({ ...prev, [item.file.path]: !prev[item.file.path] }));
              }}
              onToggleViewed={() => {
                void viewed.toggle(item.file.path);
              }}
            />
          );
        }
        case 'file-patch-missing': {
          return (
            <PatchMissingRow
              file={item.file}
              viewed={item.viewed}
              githubUrl={item.githubUrl}
              onToggleViewed={() => {
                void viewed.toggle(item.file.path);
              }}
            />
          );
        }
        case 'hunk-header': {
          return <HunkHeaderRow header={item.header} />;
        }
        case 'diff-line': {
          return <DiffLine line={item.line} language={item.language} keyId={item.lineKeyId} />;
        }
        case 'expand-separator': {
          return (
            <ExpandSeparatorRow
              item={item}
              onLoad={windowSize => {
                handleLoadContext(item, windowSize);
              }}
            />
          );
        }
        case 'pagination-row': {
          return (
            <PaginationRow
              state={item.state}
              loadedFiles={item.loadedFiles}
              totalFiles={item.totalFiles}
              onRetry={() => {
                void query.fetchNextPage();
              }}
              onFetchAll={() => {
                void fetchToCompletion.run();
              }}
            />
          );
        }
        default: {
          return null;
        }
      }
    },
    [viewed, query, fetchToCompletion, handleLoadContext]
  );

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
    if (firstPageErrorState?.kind === 'retryable' || firstPageErrorState?.kind === 'reconnect') {
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

  return (
    <View className="flex-1" accessibilityLabel="Files list">
      <FlashList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={item => item.key}
        getItemType={item => itemTypeFor(item)}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) {
            void query.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        contentContainerStyle={LIST_CONTENT_STYLE}
        ItemSeparatorComponent={null}
      />
    </View>
  );
}
