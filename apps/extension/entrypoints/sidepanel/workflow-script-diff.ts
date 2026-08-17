/**
 * Pure unified-diff builder for workflow scripts. The side panel renders a
 * stored workflow update as one diff instead of two full scripts, so a user
 * can see exactly what changed before approving the new version.
 *
 * The diff is line-based (split on '\n') and never looks inside a line, so the
 * syntax highlighter can stay a separate per-line module.
 */
export type ScriptDiffLineKind = 'context' | 'add' | 'del';
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type ScriptDiffLine = { kind: ScriptDiffLineKind; text: string };
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
export type ScriptDiffHunk = { header: string; lines: ScriptDiffLine[] };
export type ScriptDiff =
  | { kind: 'unchanged' }
  | { kind: 'tooLarge' }
  | { kind: 'hunks'; hunks: ScriptDiffHunk[] };

/**
 * The diff builds a quadratic DP table, so its memory is O(n * m) in the line
 * counts. MAX_DIFF_LINES caps each side at 1200 lines, which bounds that table
 * at ~1.4M cells; larger scripts fall back to a plain script block. A Myers
 * diff (O(n + m) time, but much more code) is the upgrade if a real workflow
 * ever needs to diff scripts this large.
 */
export const MAX_DIFF_LINES = 1200;
export const DIFF_CONTEXT_LINES = 3;

/**
 * An empty script is an empty file: zero lines. A script ending in '\n' keeps
 * the trailing empty line, so a trailing-newline-only change still diffs as
 * one changed line instead of being silently swallowed.
 */
const splitScriptLines = (script: string): string[] => (script === '' ? [] : script.split('\n'));

type EditOp =
  | { kind: 'context'; oldIndex: number; newIndex: number }
  | { kind: 'del'; oldIndex: number }
  | { kind: 'add'; newIndex: number };

/**
 * Longest-common-subsequence line diff: a plain DP table plus a backtrack.
 * Every matched line becomes a context op, so the edit script always names a
 * deletion before the insertion that replaces it.
 */
const computeEditScript = (oldLines: readonly string[], newLines: readonly string[]): EditOp[] => {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const stride = newLength + 1;

  /**
   * LCS[oldIndex * stride + newIndex] holds the length of the longest common
   * subsequence of oldLines[oldIndex..) and newLines[newIndex..).
   */
  const lcs = new Int32Array((oldLength + 1) * stride);
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = oldIndex * stride;
    const nextRow = row + stride;
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      const matched = lcs[nextRow + newIndex + 1] ?? 0;
      const deleted = lcs[nextRow + newIndex] ?? 0;
      const added = lcs[row + newIndex + 1] ?? 0;
      if (oldLines[oldIndex] === newLines[newIndex]) {
        lcs[row + newIndex] = matched + 1;
      } else if (deleted >= added) {
        lcs[row + newIndex] = deleted;
      } else {
        lcs[row + newIndex] = added;
      }
    }
  }

  const ops: EditOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ kind: 'context', newIndex, oldIndex });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      (lcs[(oldIndex + 1) * stride + newIndex] ?? 0) >= (lcs[oldIndex * stride + newIndex + 1] ?? 0)
    ) {
      ops.push({ kind: 'del', oldIndex });
      oldIndex += 1;
    } else {
      ops.push({ kind: 'add', newIndex });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLength) {
    ops.push({ kind: 'del', oldIndex });
    oldIndex += 1;
  }
  while (newIndex < newLength) {
    ops.push({ kind: 'add', newIndex });
    newIndex += 1;
  }
  return ops;
};

/**
 * One contiguous run of edits. The old/new ranges are half-open index ranges
 * into the split line arrays; a pure insertion or deletion has an empty range
 * on the side it does not touch.
 */
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type
type ChangeBlock = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

const collectBlocks = (ops: readonly EditOp[]): ChangeBlock[] => {
  const blocks: ChangeBlock[] = [];
  let oldPos = 0;
  let newPos = 0;
  let block: ChangeBlock | undefined = undefined;
  for (const op of ops) {
    if (op.kind === 'context') {
      if (block !== undefined) {
        blocks.push(block);
        block = undefined;
      }
      oldPos += 1;
      newPos += 1;
    } else {
      block ??= { newEnd: newPos, newStart: newPos, oldEnd: oldPos, oldStart: oldPos };
      if (op.kind === 'del') {
        block.oldEnd = oldPos + 1;
        oldPos += 1;
      } else {
        block.newEnd = newPos + 1;
        newPos += 1;
      }
    }
  }
  if (block !== undefined) {
    blocks.push(block);
  }
  return blocks;
};

/**
 * Merge two blocks when their DIFF_CONTEXT_LINES-wide context runs touch or
 * overlap. Context runs are unclamped here; clamping happens when the hunk is
 * emitted, so a merge at a file boundary only ever draws extra context lines.
 */
const mergeBlocks = (blocks: readonly ChangeBlock[]): ChangeBlock[] => {
  const merged: ChangeBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous && block.oldStart - previous.oldEnd <= DIFF_CONTEXT_LINES * 2) {
      previous.oldEnd = Math.max(previous.oldEnd, block.oldEnd);
      previous.newEnd = Math.max(previous.newEnd, block.newEnd);
    } else {
      merged.push(block);
    }
  }
  return merged;
};

export const buildUnifiedScriptDiff = (oldScript: string, newScript: string): ScriptDiff => {
  if (oldScript === newScript) {
    return { kind: 'unchanged' };
  }
  const oldLines = splitScriptLines(oldScript);
  const newLines = splitScriptLines(newScript);
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return { kind: 'tooLarge' };
  }
  const ops = computeEditScript(oldLines, newLines);

  const emitHunk = (block: ChangeBlock): ScriptDiffHunk => {
    const oldStart = Math.max(0, block.oldStart - DIFF_CONTEXT_LINES);
    const oldEnd = Math.min(oldLines.length, block.oldEnd + DIFF_CONTEXT_LINES);
    const newStart = Math.max(0, block.newStart - DIFF_CONTEXT_LINES);
    const newEnd = Math.min(newLines.length, block.newEnd + DIFF_CONTEXT_LINES);

    /**
     * Git-style header: 1-based starts, counts covering the hunk's own lines,
     * a zero-length side printed as `-0,0` / `+0,0`.
     */
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    const oldPart = oldCount === 0 ? '0,0' : `${oldStart + 1},${oldCount}`;
    const newPart = newCount === 0 ? '0,0' : `${newStart + 1},${newCount}`;

    const lines: ScriptDiffLine[] = [];
    for (const op of ops) {
      if (op.kind === 'add') {
        if (op.newIndex >= newStart && op.newIndex < newEnd) {
          const text = newLines[op.newIndex];
          if (text !== undefined) {
            lines.push({ kind: 'add', text });
          }
        }
      } else if (op.oldIndex >= oldStart && op.oldIndex < oldEnd) {
        const text = oldLines[op.oldIndex];
        if (text !== undefined) {
          lines.push({ kind: op.kind, text });
        }
      }
    }

    return { header: `@@ -${oldPart} +${newPart} @@`, lines };
  };

  const hunks = mergeBlocks(collectBlocks(ops)).map(block => emitHunk(block));
  return { hunks, kind: 'hunks' };
};
