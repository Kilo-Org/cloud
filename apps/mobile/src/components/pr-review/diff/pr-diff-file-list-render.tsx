// `renderItem` for the PR diff FlashList. Extracted out of
// `pr-diff-file-list.tsx` so that file stays under the max-lines
// limit. Receives the full set of state needed to switch on item kind
// and dispatch to the right row component.

import { useCallback } from 'react';

import { DiffLine } from '@/components/pr-review/diff/diff-line';
import {
  EmptyFilesView,
  ExpandSeparatorRow,
  FileHeaderRow,
  HunkHeaderRow,
  PaginationRow,
  PatchMissingRow,
  TabStateMessage,
  TruncationBannerRow,
} from '@/components/pr-review/diff/pr-diff-rows';
import {
  HunkSideBySideHeader,
  SideBySideRow,
} from '@/components/pr-review/diff/pr-diff-side-by-side-row';
import { type ExpandSeparatorItem, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import {
  type FetchToCompletionResult,
  type PrReviewFile,
  type UsePrReviewFileListQueryResult,
} from '@/lib/pr-review/diff/pr-review-file-list-state';

export type UseDiffRenderItemArgs = {
  viewed: {
    isViewed: (path: string) => boolean;
    toggle: (path: string) => Promise<void>;
  };
  query: UsePrReviewFileListQueryResult['query'];
  fetchToCompletion: FetchToCompletionResult;
  handleLoadContext: (item: ExpandSeparatorItem, windowSize: number) => void;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
};

// Re-exported here so the file-list module can import the terminal
// state views from one place.
export { EmptyFilesView, TabStateMessage };

// Re-export so the file-list module can keep its PrReviewFile import
// without touching the file-list-types module.
export type { PrReviewFile };

export function useDiffRenderItem({
  viewed,
  query,
  fetchToCompletion,
  handleLoadContext,
  setExpanded,
}: UseDiffRenderItemArgs) {
  return useCallback(
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
        case 'hunk-side-by-side': {
          return <HunkSideBySideHeader hunk={item.hunk} />;
        }
        case 'side-by-side-row': {
          return <SideBySideRow row={item.row} language={item.language} rowKeyId={item.rowKeyId} />;
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
    [viewed, query, fetchToCompletion, handleLoadContext, setExpanded]
  );
}
