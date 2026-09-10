import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import {
  sameWorktreeReviewCapture,
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
  type WorktreeReviewRange,
} from './worktree-review';

export type WorktreeReviewEditor = {
  commentId?: string;
  anchor: WorktreeReviewAnchor;
  text: string;
};

export type WorktreeReviewAnnotationItem =
  | { kind: 'comment'; comment: WorktreeReviewComment }
  | { kind: 'editor' };

export type WorktreeFileReviewBindings = {
  comments: readonly WorktreeReviewComment[];
  editor: WorktreeReviewEditor | null;
  disabledReason?: string;
  error?: string;
  onEditorChange: (editor: WorktreeReviewEditor | null) => void;
  onSaveEditor: () => void;
  onRemoveComment: (id: string) => void;
  onReplacePathComments?: (path: string, comments: readonly WorktreeReviewComment[]) => void;
};

export function formatWorktreeReviewRange(range: WorktreeReviewRange): string {
  return range.startLine === range.endLine
    ? `Line ${range.startLine}`
    : `Lines ${range.startLine}–${range.endLine}`;
}

function sideOf(line: WorktreeReviewAnchor['quote']['lines'][number]) {
  return line.kind === 'deletion' ? 'deletions' : 'additions';
}

export function selectedLinesFromWorktreeReviewQuote(
  lines: WorktreeReviewAnchor['quote']['lines']
): SelectedLineRange | null {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return null;
  const side = sideOf(first);
  const endSide = sideOf(last);
  return {
    side,
    start: first.lineNumber,
    end: last.lineNumber,
    ...(endSide === side ? {} : { endSide }),
  };
}

export function getWorktreeReviewSelectedLines(
  capture: WorktreeReviewCapture,
  path: string,
  editor?: WorktreeReviewEditor | null,
  dragged?: SelectedLineRange | null
): SelectedLineRange | null {
  if (
    editor &&
    editor.anchor.path === path &&
    sameWorktreeReviewCapture(editor.anchor.capture, capture)
  ) {
    return selectedLinesFromWorktreeReviewQuote(editor.anchor.quote.lines);
  }
  return dragged ?? null;
}

export function worktreeReviewRangeHighlightCSS(
  comments: readonly WorktreeReviewComment[],
  capture: WorktreeReviewCapture,
  path: string
): string {
  const selectors: string[] = [];
  for (const comment of comments) {
    if (
      comment.anchor.path !== path ||
      !sameWorktreeReviewCapture(comment.anchor.capture, capture)
    ) {
      continue;
    }
    for (const line of comment.anchor.quote.lines) {
      selectors.push(
        line.kind === 'deletion'
          ? `[data-line-type="change-deletion"][data-line="${line.lineNumber}"]`
          : `[data-line="${line.lineNumber}"]:not([data-line-type="change-deletion"])`
      );
    }
  }
  if (selectors.length === 0) return '';
  return `${selectors.join(',')} { background-color: color-mix(in srgb, var(--diffs-modified-base, #69b1ff) 22%, transparent); }`;
}

export function worktreeReviewEditorSlot(
  editor: WorktreeReviewEditor | null | undefined,
  path: string,
  capture: WorktreeReviewCapture
): string | undefined {
  if (
    !editor ||
    editor.anchor.path !== path ||
    !sameWorktreeReviewCapture(editor.anchor.capture, capture)
  )
    return undefined;
  return quoteSlotKey(editor.anchor.quote.lines);
}

function quoteSlotKey(lines: WorktreeReviewAnchor['quote']['lines']): string | undefined {
  const last = lines.at(-1);
  return last ? `${sideOf(last)}:${last.lineNumber}` : undefined;
}

export function getWorktreeReviewAnnotations(
  comments: readonly WorktreeReviewComment[],
  capture: WorktreeReviewCapture,
  path: string,
  editor?: WorktreeReviewEditor | null
): DiffLineAnnotation<WorktreeReviewAnnotationItem[]>[] {
  const groups = new Map<string, DiffLineAnnotation<WorktreeReviewAnnotationItem[]>>();
  for (const comment of comments) {
    if (
      editor?.commentId === comment.id ||
      comment.anchor.path !== path ||
      !sameWorktreeReviewCapture(comment.anchor.capture, capture)
    ) {
      continue;
    }
    const last = comment.anchor.quote.lines.at(-1);
    const key = quoteSlotKey(comment.anchor.quote.lines);
    if (!last || !key) continue;
    const group = groups.get(key);
    const item: WorktreeReviewAnnotationItem = { kind: 'comment', comment };
    if (group) group.metadata.push(item);
    else groups.set(key, { side: sideOf(last), lineNumber: last.lineNumber, metadata: [item] });
  }
  const editorSlot = worktreeReviewEditorSlot(editor, path, capture);
  if (editor && editorSlot) {
    const last = editor.anchor.quote.lines.at(-1);
    if (!last) return [...groups.values()];
    const group = groups.get(editorSlot);
    if (group) group.metadata.push({ kind: 'editor' });
    else
      groups.set(editorSlot, {
        side: sideOf(last),
        lineNumber: last.lineNumber,
        metadata: [{ kind: 'editor' }],
      });
  }
  return [...groups.values()];
}
