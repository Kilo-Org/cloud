// `renderItem` for the PR diff FlashList. Extracted out of
// `pr-diff-file-list.tsx` so that file stays under the max-lines
// limit. Receives the full set of state needed to switch on item kind
// and dispatch to the right row component.

import { useCallback, useRef } from 'react';

import { DiffLine } from '@/components/pr-review/diff/diff-line';
import {
  ExpandSeparatorRow,
  FileHeaderRow,
  HunkHeaderRow,
  PaginationRow,
  PatchMissingRow,
  TruncationBannerRow,
} from '@/components/pr-review/diff/pr-diff-rows';
import {
  HunkSideBySideHeader,
  SideBySideRow,
} from '@/components/pr-review/diff/pr-diff-side-by-side-row';
import { collapseOnMarkViewed } from '@/lib/pr-review/diff/collapse-on-mark-viewed';
import { type ExpandSeparatorItem, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type ParsedHunk } from '@/lib/pr-review/diff/parse-patch';
import { sideForDiffLineType } from '@/lib/pr-review/diff-selection';

type UseDiffRenderItemArgs = {
  viewed: {
    isViewed: (path: string) => boolean;
    toggle: (path: string) => Promise<void>;
  };
  /** Retries the failed next page (pagination row). */
  onRetryPage: () => void;
  /** Drives the query to completion ("Load all"). */
  onFetchAll: () => void;
  handleLoadContext: (item: ExpandSeparatorItem, windowSize: number) => void;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /** Producer-side tap handler. Receives the parsed data needed to run
   *  the diff-selection reducer. S7a wires this from `PrDiffFileList`. */
  onLineTap: (args: LineTapArgs) => void;
  /** `null` when no selection; otherwise the current selection range. */
  selection: SelectionView;
};

/** Lightweight view of the current selection — what the rows need to
 *  decide whether to paint the focus ring. The full `DiffSelection`
 *  (incl. `selectedText`) is in the bridge, not here. */
type SelectionView = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  line: number;
} | null;

export type LineTapArgs = {
  filePath: string;
  hunkKey: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  text: string;
  /** The full hunk — the reducer needs the line-number → text map. */
  hunk: ParsedHunk;
};

/** The one item the per-line tap map is keyed on. */
type DiffLineItem = Extract<ListItem, { kind: 'diff-line' }>;

export function useDiffRenderItem({
  viewed,
  onRetryPage,
  onFetchAll,
  handleLoadContext,
  setExpanded,
  onLineTap,
  selection,
}: UseDiffRenderItemArgs) {
  // Identity-stable per-line tap callbacks so `DiffLine`'s memo comparator —
  // which compares `onTap` by reference — can hit. A fresh closure per line per
  // render defeated it, so tapping one line re-rendered every mounted diff row
  // instead of only the rows whose `isSelected` changed. Mirrors
  // `pr-diff-file-navigator.tsx`'s `rowCallbacksRef`: the closures read the
  // latest item and the latest `onLineTap` through refs, so they stay
  // identity-stable (the memo keeps hitting) but never go stale when the item
  // is rebuilt or `onLineTap` changes identity. The maps are bounded by the
  // diff lines actually mounted — the same trade-off the navigator's per-row
  // callback map accepts.
  const onLineTapRef = useRef(onLineTap);
  onLineTapRef.current = onLineTap;

  const lineItemRef = useRef(new Map<string, DiffLineItem>());
  const lineTapRef = useRef(new Map<string, () => void>());

  const lineTapFor = useCallback((item: DiffLineItem) => {
    lineItemRef.current.set(item.key, item);
    let onTap = lineTapRef.current.get(item.key);
    if (!onTap) {
      onTap = () => {
        const current = lineItemRef.current.get(item.key);
        if (!current) {
          return;
        }
        const side = sideForDiffLineType(current.line.type);
        const lineNumber = side === 'LEFT' ? current.line.oldLine : current.line.newLine;
        const hunk = current.parsed.hunks[current.hunkIndex];
        if (lineNumber === undefined || !hunk) {
          return;
        }
        onLineTapRef.current({
          filePath: current.filePath,
          hunkKey: `${current.filePath}:${current.hunkIndex}`,
          side,
          line: lineNumber,
          text: current.line.text,
          hunk,
        });
      };
      lineTapRef.current.set(item.key, onTap);
    }
    return onTap;
  }, []);

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
                setExpanded(prev => collapseOnMarkViewed(prev, item.file.path, item.viewed));
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
                setExpanded(prev => collapseOnMarkViewed(prev, item.file.path, item.viewed));
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
          // Commenting is done from the unified view; side-by-side is read-only.
          return <SideBySideRow row={item.row} language={item.language} rowKeyId={item.rowKeyId} />;
        }
        case 'diff-line': {
          const parsedLine = item.line;
          const side = sideForDiffLineType(parsedLine.type);
          const lineNumber = side === 'LEFT' ? parsedLine.oldLine : parsedLine.newLine;
          const hunk = item.parsed.hunks[item.hunkIndex];
          const isSelectable = item.selectable !== false;
          return (
            <DiffLine
              line={parsedLine}
              language={item.language}
              keyId={item.lineKeyId}
              onTap={
                isSelectable && lineNumber !== undefined && hunk ? lineTapFor(item) : undefined
              }
              isSelected={
                selection !== null &&
                selection.filePath === item.filePath &&
                selection.side === side &&
                lineNumber !== undefined &&
                lineNumber >= selection.startLine &&
                lineNumber <= selection.line
              }
            />
          );
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
              onRetry={onRetryPage}
              onFetchAll={onFetchAll}
            />
          );
        }
        default: {
          return null;
        }
      }
    },
    [viewed, onRetryPage, onFetchAll, handleLoadContext, setExpanded, lineTapFor, selection]
  );
}
