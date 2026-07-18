// Selection state hook for the PR diff file list. Encapsulates the
// reducer-driven line selection, the bridge mirror, the selection view
// used for row highlight, and the side-by-side mode guard that clears
// the selection. Extracted to keep `pr-diff-file-list.tsx` under the
// max-lines limit.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { type LineTapArgs } from '@/components/pr-review/diff/pr-diff-file-list-render';
import {
  clearDiffSelection,
  type DiffSelection,
  setDiffSelection,
} from '@/lib/pr-review/diff-selection-bridge';
import { type SelectionState, selectLine } from '@/lib/pr-review/diff-selection';
import { type DiffViewMode } from '@/lib/pr-review/diff/pr-diff-list-items';

type UseDiffSelectionArgs = {
  owner: string;
  repo: string;
  number: number;
  viewMode: DiffViewMode;
  isTablet: boolean;
};

type UseDiffSelectionResult = {
  selection: SelectionState | null;
  selectionView: SelectionView;
  handleLineTap: (args: LineTapArgs) => void;
  clearSelection: () => void;
};

type SelectionView = {
  filePath: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  line: number;
} | null;

export function useDiffSelection({
  owner,
  repo,
  number,
  viewMode,
  isTablet,
}: UseDiffSelectionArgs): UseDiffSelectionResult {
  const [selection, setSelectionState] = useState<SelectionState | null>(null);

  // Selection/commenting is a unified-view interaction; switching to
  // side-by-side drops any active selection so a stale unified
  // selection doesn't leave the floating affordance up.
  useEffect(() => {
    if (isTablet && viewMode === 'side-by-side') {
      setSelectionState(prev => {
        if (prev) {
          clearDiffSelection();
        }
        return null;
      });
    }
  }, [isTablet, viewMode]);

  // Diff-line tap producer: build the per-side line-number → text map
  // for this hunk, run the reducer, mirror to the bridge, and store
  // the result locally so the rows can render the focus ring.
  const handleLineTap = useCallback(
    (args: LineTapArgs) => {
      const map = new Map<number, string>();
      for (const hunkLine of args.hunk.lines) {
        const key = args.side === 'LEFT' ? hunkLine.oldLine : hunkLine.newLine;
        if (typeof key === 'number') {
          map.set(key, hunkLine.text);
        }
      }
      setSelectionState(prev => {
        const next = selectLine(
          prev,
          {
            path: args.filePath,
            side: args.side,
            line: args.line,
            hunkKey: args.hunkKey,
            text: args.text,
          },
          map
        );
        const bridgeSelection: DiffSelection = {
          owner,
          repo,
          number,
          path: next.path,
          side: next.side,
          line: next.line,
          ...(next.startLine !== next.line ? { startLine: next.startLine } : {}),
          selectedText: next.selectedText,
        };
        setDiffSelection(bridgeSelection);
        return next;
      });
    },
    [owner, repo, number]
  );

  const selectionView: SelectionView = useMemo(() => {
    if (!selection) {
      return null;
    }
    return {
      filePath: selection.path,
      side: selection.side,
      startLine: selection.startLine,
      line: selection.line,
    };
  }, [selection]);

  const clearSelection = useCallback(() => {
    setSelectionState(null);
  }, []);

  return { selection, selectionView, handleLineTap, clearSelection };
}
