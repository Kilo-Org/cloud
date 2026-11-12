import {
  MAX_WORKTREE_REVIEW_COMMENTS,
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  MAX_WORKTREE_REVIEW_PROMPT_LENGTH,
  MAX_WORKTREE_REVIEW_QUOTE_BYTES,
  MAX_WORKTREE_REVIEW_SELECTION_LINES,
  WORKTREE_REVIEW_PROMPT_INTRO,
  addWorktreeReviewComment,
  deriveWorktreeReviewRange,
  getWorktreeReviewAnchorError,
  getWorktreeReviewCaptureError,
  getWorktreeReviewCommentsError,
  removeWorktreeReviewComment,
  serializeWorktreeReview,
  sameWorktreeReviewCapture,
  sameWorktreeReviewScope,
  updateWorktreeReviewComment,
  type ParsedWorktreeReview,
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
  type WorktreeReviewContextStatus,
  type WorktreeReviewPayloadComment,
  type WorktreeReviewRange,
  type WorktreeReviewResult,
} from '@kilocode/app-shared/worktree-review';
import {
  worktreeChangesCapturedAtSchema,
  worktreeChangesComparisonSchema,
  worktreeChangesFileSchema,
  worktreeChangesRevisionSchema,
  worktreeChangesScopeSchema,
  type WorktreeFileRecord,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { iterateOverDiff } from '../../../node_modules/@pierre/diffs/dist/utils/iterateOverDiff.js';
import { z } from 'zod';

export {
  MAX_WORKTREE_REVIEW_COMMENTS,
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  MAX_WORKTREE_REVIEW_PROMPT_LENGTH,
  MAX_WORKTREE_REVIEW_QUOTE_BYTES,
  MAX_WORKTREE_REVIEW_SELECTION_LINES,
  WORKTREE_REVIEW_PROMPT_INTRO,
  addWorktreeReviewComment,
  deriveWorktreeReviewRange,
  getWorktreeReviewAnchorError,
  getWorktreeReviewCommentsError,
  removeWorktreeReviewComment,
  serializeWorktreeReview,
  sameWorktreeReviewCapture,
  sameWorktreeReviewScope,
  updateWorktreeReviewComment,
  type ParsedWorktreeReview,
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
  type WorktreeReviewContextStatus,
  type WorktreeReviewPayloadComment,
  type WorktreeReviewRange,
  type WorktreeReviewResult,
};

type UnifiedRow = {
  lineNumber: number;
  kind: 'addition' | 'deletion' | 'context';
  text: string;
  unifiedIndex: number;
  deletionLineNumber?: number;
  additionLineNumber?: number;
};

export type WorktreeReviewFreshness = 'current' | 'stale' | 'unknown';

const boundedIdentitySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(value => !value.includes('\0'));

const worktreeReviewCaptureSchema = z
  .object({
    userId: boundedIdentitySchema,
    organizationId: boundedIdentitySchema.optional(),
    workspaceScope: boundedIdentitySchema,
    sourceCloudAgentSessionId: boundedIdentitySchema,
    revision: worktreeChangesRevisionSchema,
    scope: worktreeChangesScopeSchema.optional(),
    capturedAt: worktreeChangesCapturedAtSchema,
    comparison: worktreeChangesComparisonSchema,
  })
  .strict();

const worktreeReviewRangeSchema = z
  .object({
    side: z.enum(['deletions', 'additions']),
    startLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    endLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const worktreeReviewQuoteLineSchema = z
  .object({
    lineNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['addition', 'deletion', 'context']),
    text: z.string().min(1),
  })
  .strict();

export const worktreeReviewAnchorSchema = z
  .object({
    capture: worktreeReviewCaptureSchema,
    path: worktreeChangesFileSchema.shape.path,
    range: worktreeReviewRangeSchema,
    quote: z
      .object({
        source: z.enum(['saved-patch', 'validated-expanded-diff']),
        lines: z.array(worktreeReviewQuoteLineSchema).max(MAX_WORKTREE_REVIEW_SELECTION_LINES),
      })
      .strict(),
  })
  .strict();

export const worktreeReviewCommentSchema = z
  .object({
    id: boundedIdentitySchema,
    anchor: worktreeReviewAnchorSchema,
    text: z.string().min(1).max(MAX_WORKTREE_REVIEW_COMMENT_LENGTH),
  })
  .strict();

const worktreeReviewPayloadCommentSchema = z
  .object({
    id: boundedIdentitySchema,
    contextStatus: z.enum(['current-saved-capture', 'older-or-unverified-capture']),
    anchor: worktreeReviewAnchorSchema,
    text: z.string().min(1).max(MAX_WORKTREE_REVIEW_COMMENT_LENGTH),
  })
  .strict();

const worktreeReviewPayloadSchema = z
  .object({
    version: z.literal(1),
    overall: z.string().max(MAX_WORKTREE_REVIEW_COMMENT_LENGTH).optional(),
    comments: z.array(worktreeReviewPayloadCommentSchema).min(1).max(MAX_WORKTREE_REVIEW_COMMENTS),
  })
  .strict();

export function getSelectionError(selection: SelectedLineRange): string | undefined {
  if (
    (selection.side !== 'deletions' && selection.side !== 'additions') ||
    (selection.endSide !== undefined &&
      selection.endSide !== 'deletions' &&
      selection.endSide !== 'additions')
  ) {
    return 'Select lines on one explicit side of the diff.';
  }
  if (
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start <= 0 ||
    selection.end <= 0
  ) {
    return 'Select a valid line range on one side of the diff.';
  }
  return undefined;
}

function getDiffLineText(lines: string[], lineIndex: number): string {
  if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) {
    throw new Error('Invalid diff line index');
  }
  const text = lines[lineIndex];
  if (text === undefined) throw new Error('Missing diff line text');
  return text;
}

function collectUnifiedRows(diff: FileDiffMetadata): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  iterateOverDiff({
    diff,
    diffStyle: 'unified',
    expandedHunks: true,
    callback(row) {
      if (row.type === 'change') {
        if (row.deletionLine) {
          rows.push({
            lineNumber: row.deletionLine.lineNumber,
            kind: 'deletion',
            text: getDiffLineText(diff.deletionLines, row.deletionLine.lineIndex),
            unifiedIndex: row.deletionLine.unifiedLineIndex,
            deletionLineNumber: row.deletionLine.lineNumber,
          });
        }
        if (row.additionLine) {
          rows.push({
            lineNumber: row.additionLine.lineNumber,
            kind: 'addition',
            text: getDiffLineText(diff.additionLines, row.additionLine.lineIndex),
            unifiedIndex: row.additionLine.unifiedLineIndex,
            additionLineNumber: row.additionLine.lineNumber,
          });
        }
        return false;
      }
      rows.push({
        lineNumber: row.additionLine.lineNumber,
        kind: 'context',
        text: getDiffLineText(diff.additionLines, row.additionLine.lineIndex),
        unifiedIndex: row.additionLine.unifiedLineIndex,
        deletionLineNumber: row.deletionLine.lineNumber,
        additionLineNumber: row.additionLine.lineNumber,
      });
      return false;
    },
  });
  return rows;
}

function unifiedRowsAreAdjacent(rows: readonly UnifiedRow[]): boolean {
  return rows.every((row, index) => {
    if (!Number.isSafeInteger(row.unifiedIndex)) return false;
    const previous = rows[index - 1];
    return (
      previous === undefined ||
      (Number.isSafeInteger(previous.unifiedIndex) &&
        row.unifiedIndex === previous.unifiedIndex + 1)
    );
  });
}

function quoteSourceForDiff(diff: FileDiffMetadata): WorktreeReviewAnchor['quote']['source'] {
  return diff.isPartial || diff.type === 'new' || diff.type === 'deleted'
    ? 'saved-patch'
    : 'validated-expanded-diff';
}

function fileDiffError(
  capture: WorktreeReviewCapture,
  file: WorktreeFileRecord,
  diff: FileDiffMetadata
): string | undefined {
  if (
    file.revision !== capture.revision ||
    file.scope !== capture.scope ||
    diff.name !== file.path ||
    diff.prevName !== undefined ||
    !worktreeChangesFileSchema.shape.path.safeParse(file.path).success
  ) {
    return 'The saved file does not match this review capture.';
  }
  if (
    file.diff.status !== 'available' ||
    (file.content.status === 'unavailable' && file.content.reason === 'binary') ||
    !['change', 'new', 'deleted'].includes(diff.type) ||
    diff.hunks.length === 0
  ) {
    return 'This saved file has no reviewable diff lines.';
  }
  return undefined;
}

function sliceCoversLossyEOF(
  rows: readonly UnifiedRow[],
  file: WorktreeFileRecord,
  diff: FileDiffMetadata
): boolean {
  if (file.diff.status !== 'available') return false;
  const patch = file.diff.patch;
  const checkSide = (
    side: 'deletions' | 'additions',
    pattern: RegExp,
    hasLine: (row: UnifiedRow) => boolean,
    getLine: (hunk: FileDiffMetadata['hunks'][number]) => number
  ): boolean => {
    if (!pattern.test(patch) || !rows.some(hasLine)) return false;
    const eofHunk = diff.hunks.findLast(hunk =>
      side === 'deletions' ? hunk.deletionCount > 0 : hunk.additionCount > 0
    );
    const eofLine = eofHunk === undefined ? undefined : getLine(eofHunk);
    if (
      eofLine === undefined ||
      !Number.isSafeInteger(eofLine) ||
      eofLine <= 0 ||
      rows.some(row =>
        side === 'deletions'
          ? row.deletionLineNumber === eofLine
          : row.additionLineNumber === eofLine
      )
    ) {
      return true;
    }
    return false;
  };
  return (
    checkSide(
      'deletions',
      /\n[- ][^\n]*\r\n\\ No newline at end of file\n/,
      row => row.kind === 'deletion',
      hunk => hunk.deletionStart + hunk.deletionCount - 1
    ) ||
    checkSide(
      'additions',
      /\n[+ ][^\n]*\r\n\\ No newline at end of file\n/,
      row => row.kind !== 'deletion',
      hunk => hunk.additionStart + hunk.additionCount - 1
    )
  );
}

function cloneAnchor(anchor: WorktreeReviewAnchor): WorktreeReviewAnchor {
  return {
    capture: { ...anchor.capture, comparison: { ...anchor.capture.comparison } },
    path: anchor.path,
    range: { ...anchor.range },
    quote: { source: anchor.quote.source, lines: anchor.quote.lines.map(line => ({ ...line })) },
  };
}

export function createWorktreeReviewAnchor({
  capture,
  file,
  diff,
  selection,
}: {
  capture: WorktreeReviewCapture;
  file: WorktreeFileRecord;
  diff: FileDiffMetadata;
  selection: SelectedLineRange;
}): WorktreeReviewResult<WorktreeReviewAnchor> {
  const error = getWorktreeReviewCaptureError(capture) ?? getSelectionError(selection);
  if (error) return { ok: false, error };
  const fileError = fileDiffError(capture, file, diff);
  if (fileError) return { ok: false, error: fileError };
  let rows: UnifiedRow[];
  try {
    rows = collectUnifiedRows(diff);
  } catch {
    return { ok: false, error: 'The selected lines cannot be read from this saved diff.' };
  }
  const startIndex = rows.findIndex(
    row =>
      (selection.side === 'deletions' ? row.deletionLineNumber : row.additionLineNumber) ===
      selection.start
  );
  const endSide = selection.endSide ?? selection.side;
  const endIndex = rows.findIndex(
    row =>
      (endSide === 'deletions' ? row.deletionLineNumber : row.additionLineNumber) === selection.end
  );
  if (startIndex < 0 || endIndex < 0) {
    return {
      ok: false,
      error: 'The selected lines are not fully available in this saved diff.',
    };
  }
  const selectedRows = rows.slice(
    Math.min(startIndex, endIndex),
    Math.max(startIndex, endIndex) + 1
  );
  if (!unifiedRowsAreAdjacent(selectedRows)) {
    return {
      ok: false,
      error: 'The selected lines are not fully available in this saved diff.',
    };
  }
  if (sliceCoversLossyEOF(selectedRows, file, diff)) {
    return {
      ok: false,
      error: 'The selected lines cannot be quoted exactly from this saved diff.',
    };
  }
  const lines: WorktreeReviewAnchor['quote']['lines'] = selectedRows.map(row => ({
    lineNumber: row.lineNumber,
    kind: row.kind,
    text: row.text,
  }));
  const range = deriveWorktreeReviewRange(lines);
  if (!range) {
    return { ok: false, error: 'The selected lines are not fully available in this saved diff.' };
  }
  const anchor: WorktreeReviewAnchor = {
    capture,
    path: file.path,
    range,
    quote: {
      source: quoteSourceForDiff(diff),
      lines,
    },
  };
  const anchorError = getWorktreeReviewAnchorError(anchor);
  return anchorError ? { ok: false, error: anchorError } : { ok: true, value: cloneAnchor(anchor) };
}

export function getWorktreeReviewFreshness(
  review: WorktreeReviewComment | WorktreeReviewCapture,
  currentCapture: WorktreeReviewCapture | null
): WorktreeReviewFreshness {
  const capture = 'anchor' in review ? review.anchor.capture : review;
  if (
    !currentCapture ||
    !sameWorktreeReviewScope(capture, currentCapture) ||
    capture.sourceCloudAgentSessionId !== currentCapture.sourceCloudAgentSessionId
  ) {
    return 'unknown';
  }
  return sameWorktreeReviewCapture(capture, currentCapture) ? 'current' : 'stale';
}

function normalizeReviewQuoteText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function rebaseWorktreeReviewComment(
  comment: WorktreeReviewComment,
  capture: WorktreeReviewCapture,
  file: WorktreeFileRecord,
  diff: FileDiffMetadata
): WorktreeReviewComment | null {
  if (comment.anchor.path !== file.path || comment.anchor.capture.scope !== capture.scope)
    return comment;
  if (sameWorktreeReviewCapture(comment.anchor.capture, capture)) return comment;
  if (getWorktreeReviewCaptureError(capture)) return null;
  const fileError = fileDiffError(capture, file, diff);
  if (fileError) return null;
  let rows: UnifiedRow[];
  try {
    rows = collectUnifiedRows(diff);
  } catch {
    return null;
  }
  const savedLines = comment.anchor.quote.lines;
  let matchStart = -1;
  let matchCount = 0;
  for (let start = 0; start <= rows.length - savedLines.length; start += 1) {
    const candidate = rows.slice(start, start + savedLines.length);
    if (
      candidate.every(
        (row, index) =>
          normalizeReviewQuoteText(row.text) ===
          normalizeReviewQuoteText(savedLines[index]?.text ?? '')
      )
    ) {
      matchStart = start;
      matchCount += 1;
    }
  }
  if (matchCount !== 1) return null;
  const matchedRows = rows.slice(matchStart, matchStart + savedLines.length);
  if (!unifiedRowsAreAdjacent(matchedRows)) return null;
  const lines: WorktreeReviewAnchor['quote']['lines'] = matchedRows.map((row, index) => ({
    lineNumber: row.lineNumber,
    kind: row.kind,
    // Keep the captured text so rebase cannot reintroduce renderer lossiness.
    text: savedLines[index]?.text ?? '',
  }));
  const range = deriveWorktreeReviewRange(lines);
  if (!range) return null;
  const anchor: WorktreeReviewAnchor = {
    capture,
    path: file.path,
    range,
    quote: { source: quoteSourceForDiff(diff), lines },
  };
  if (getWorktreeReviewAnchorError(anchor)) return null;
  return { ...comment, anchor: cloneAnchor(anchor) };
}

export function rebaseWorktreeReviewCommentsForFile(
  comments: readonly WorktreeReviewComment[],
  capture: WorktreeReviewCapture,
  file: WorktreeFileRecord,
  diff: FileDiffMetadata | null
): WorktreeReviewComment[] {
  return comments.flatMap(comment => {
    if (comment.anchor.path !== file.path || comment.anchor.capture.scope !== capture.scope)
      return [comment];
    if (comment.anchor.capture.sourceCloudAgentSessionId !== capture.sourceCloudAgentSessionId) {
      return [comment];
    }
    if (!diff) return [comment];
    const next = rebaseWorktreeReviewComment(comment, capture, file, diff);
    return next ? [next] : [comment];
  });
}

export function parseWorktreeReviewMessage(text: string): ParsedWorktreeReview | null {
  if (!text.startsWith(`${WORKTREE_REVIEW_PROMPT_INTRO}\n\n`)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(WORKTREE_REVIEW_PROMPT_INTRO.length + 2));
  } catch {
    return null;
  }
  const parsed = worktreeReviewPayloadSchema.safeParse(value);
  if (!parsed.success) return null;
  const comments = parsed.data.comments.map(comment => ({
    id: comment.id,
    anchor: {
      ...comment.anchor,
      capture: {
        ...comment.anchor.capture,
        organizationId: comment.anchor.capture.organizationId,
      },
    },
    text: comment.text,
  }));
  if (getWorktreeReviewCommentsError(comments)) return null;
  const overall = parsed.data.overall?.trim() || undefined;
  return { overall, comments };
}
