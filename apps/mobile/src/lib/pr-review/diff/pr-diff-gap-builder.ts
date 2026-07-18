// Gap builder helpers for the PR diff FlashList. Kept separate so the
// main list builder stays under the max-lines limit.

import { type ParsedDiffLine, type ParsedPatch } from '@/lib/pr-review/diff/parse-patch';
import {
  type BuildItemsArgs,
  type DiffViewMode,
  type ExpandSeparatorItem,
  type ExpandSeparatorState,
  getCumulativeLines,
  getTotalLines,
  type ListItem,
} from '@/lib/pr-review/diff/pr-diff-list-items';
import { type SideBySideRow } from '@/lib/pr-review/diff/side-by-side';

function deriveSeparatorState(
  state: ExpandSeparatorState,
  loadedCount: number
): ExpandSeparatorItem['state'] {
  if (state.status === 'loading') {
    return 'loading';
  }
  if (state.status === 'error') {
    return 'error';
  }
  if (state.status === 'unavailable') {
    return 'unavailable';
  }
  return loadedCount > 0 ? 'partial' : 'idle';
}

export function pushGapItems(args: {
  items: ListItem[];
  file: BuildItemsArgs['files'][number];
  startLine: number;
  endLine: number;
  gapIndex: number;
  hunkIndex: number;
  fileContext: Record<number, ExpandSeparatorState>;
  parsed: ParsedPatch;
  language: string | null;
  headSha: string;
  viewMode?: DiffViewMode;
}): void {
  const state = args.fileContext[args.gapIndex] ?? { status: 'idle' as const };
  const cumulativeLines = getCumulativeLines(state);
  const loadedCount = cumulativeLines.length;
  const effectiveEndLine = getTotalLines(state) ?? args.endLine;
  const gapSize = effectiveEndLine - args.startLine + 1;
  const isComplete = loadedCount >= gapSize;
  const viewMode: DiffViewMode = args.viewMode ?? 'unified';

  for (let lineIdx = 0; lineIdx < loadedCount; lineIdx += 1) {
    const lineText = cumulativeLines[lineIdx] ?? '';
    const newLineNo = args.startLine + lineIdx;
    if (viewMode === 'side-by-side') {
      const line: ParsedDiffLine = {
        type: 'context',
        oldLine: newLineNo,
        newLine: newLineNo,
        text: lineText,
        noNewlineAtEndOfFile: false,
      };
      const row: SideBySideRow = { left: { line }, right: { line } };
      const rowKeyId = `gap-sbs:${args.file.path}:${args.gapIndex}:${lineIdx}`;
      args.items.push({
        kind: 'side-by-side-row',
        key: rowKeyId,
        rowKey: rowKeyId,
        filePath: args.file.path,
        hunkIndex: args.hunkIndex,
        rowIndex: lineIdx,
        row,
        language: args.language,
        rowKeyId,
      });
    } else {
      args.items.push({
        kind: 'diff-line',
        key: `gap-line:${args.file.path}:${args.gapIndex}:${lineIdx}`,
        lineKey: `gap-line:${args.file.path}:${args.gapIndex}:${lineIdx}`,
        filePath: args.file.path,
        hunkIndex: args.hunkIndex,
        lineIndex: lineIdx,
        parsed: args.parsed,
        line: {
          type: 'context',
          newLine: newLineNo,
          text: lineText,
          noNewlineAtEndOfFile: false,
        },
        language: args.language,
        lineKeyId: `gap-line:${args.file.path}:${args.gapIndex}:${lineIdx}`,
        selectable: false,
      });
    }
  }

  if (isComplete || state.status === 'unavailable') {
    return;
  }

  const remainingStartLine = args.startLine + loadedCount;
  args.items.push({
    kind: 'expand-separator',
    key: `gap:${args.file.path}:${args.gapIndex}`,
    filePath: args.file.path,
    ref: {
      owner: '',
      repo: '',
      number: 0,
      ref: args.headSha,
    },
    context: {
      gapIndex: args.gapIndex,
      startLine: remainingStartLine,
      endLine: effectiveEndLine,
    },
    state: deriveSeparatorState(state, loadedCount),
  });
}
