// Pure diff-line selection reducer for the PR review composer.
//
// A selection is a contiguous range of commentable lines within a single
// hunk. The producer (the diff) reports each tap as
// `{path, side, line, hunkKey, text}` together with a `hunkLines` map
// keyed by the line number visible on the selected side. The reducer
// returns the next selection state, or `null` to mean "no selection".
//
// Rules (S7a):
//   - No selection, or different path / different side / different
//     hunk → START a new single-line selection.
//   - Same path + same side + same hunk → EXTEND the range so that
//     `startLine = min(state.startLine, tap.line)` and
//     `line = max(state.line, tap.line)`. This keeps the range
//     contiguous from the user's point of view even if they tap
//     out of order, and matches the spec's "min/max" rule.
//
// Selection side is derived by the producer from the line type:
// `del` lines live on the LEFT, `add` and `context` lines live on
// the RIGHT (GitHub's review-comment model). Mixed-side ranges are
// rejected by the producer before they reach the reducer — a single
// tap can never carry both sides.

import { type DiffLineType } from '@/lib/pr-review/diff/parse-patch';

export type SelectionSide = 'LEFT' | 'RIGHT';

export type SelectionTap = {
  path: string;
  side: SelectionSide;
  line: number;
  hunkKey: string;
  /** The text of the tapped line (the right-side text for context/add, the left-side text for del). */
  text: string;
};

export type SelectionState = {
  path: string;
  side: SelectionSide;
  hunkKey: string;
  startLine: number;
  line: number;
  selectedText: string;
};

export function selectLine(
  state: SelectionState | null,
  tap: SelectionTap,
  hunkLines: ReadonlyMap<number, string>
): SelectionState {
  if (
    !state ||
    state.path !== tap.path ||
    state.side !== tap.side ||
    state.hunkKey !== tap.hunkKey
  ) {
    return {
      path: tap.path,
      side: tap.side,
      hunkKey: tap.hunkKey,
      startLine: tap.line,
      line: tap.line,
      selectedText: tap.text,
    };
  }

  const startLine = Math.min(state.startLine, tap.line);
  const endLine = Math.max(state.line, tap.line);
  const lines: string[] = [];
  for (let current = startLine; current <= endLine; current += 1) {
    lines.push(hunkLines.get(current) ?? tap.text);
  }
  return {
    path: tap.path,
    side: tap.side,
    hunkKey: tap.hunkKey,
    startLine,
    line: endLine,
    selectedText: lines.join('\n'),
  };
}

export function clearSelection(): null {
  return null;
}

export function isLineInSelection(state: SelectionState | null, tap: { line: number }): boolean {
  if (!state) {
    return false;
  }
  return tap.line >= state.startLine && tap.line <= state.line;
}

/**
 * Producer-side classification: which side of the diff a commentable line
 * lives on. `del` lines are on the LEFT; `add` and `context` lines are on
 * the RIGHT (GitHub's review-comment model). Mixed-side ranges are rejected
 * by the producer before they reach the reducer.
 */
export function sideForDiffLineType(type: DiffLineType): SelectionSide {
  return type === 'del' ? 'LEFT' : 'RIGHT';
}
