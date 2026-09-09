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

export function selectedLinesFromWorktreeReviewRange(
  range: WorktreeReviewRange
): SelectedLineRange {
  return { side: range.side, start: range.startLine, end: range.endLine };
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
    return selectedLinesFromWorktreeReviewRange(editor.anchor.range);
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
    const { side, startLine, endLine } = comment.anchor.range;
    for (let line = startLine; line <= endLine; line += 1) {
      selectors.push(
        side === 'deletions'
          ? `[data-line-type="change-deletion"][data-line="${line}"]`
          : `[data-line="${line}"]:not([data-line-type="change-deletion"])`
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
  return `${editor.anchor.range.side}:${editor.anchor.range.endLine}`;
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
    const { side, endLine } = comment.anchor.range;
    const key = `${side}:${endLine}`;
    const group = groups.get(key);
    const item: WorktreeReviewAnnotationItem = { kind: 'comment', comment };
    if (group) group.metadata.push(item);
    else groups.set(key, { side, lineNumber: endLine, metadata: [item] });
  }
  const editorSlot = worktreeReviewEditorSlot(editor, path, capture);
  if (editor && editorSlot) {
    const { side, endLine } = editor.anchor.range;
    const group = groups.get(editorSlot);
    if (group) group.metadata.push({ kind: 'editor' });
    else groups.set(editorSlot, { side, lineNumber: endLine, metadata: [{ kind: 'editor' }] });
  }
  return [...groups.values()];
}
