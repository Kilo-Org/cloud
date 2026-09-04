import type { DiffLineAnnotation } from '@pierre/diffs';
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

export type WorktreeFileReviewBindings = {
  comments: readonly WorktreeReviewComment[];
  editor: WorktreeReviewEditor | null;
  disabledReason?: string;
  error?: string;
  onEditorChange: (editor: WorktreeReviewEditor | null) => void;
  onSaveEditor: () => void;
  onRemoveComment: (id: string) => void;
};

export function formatWorktreeReviewRange(range: WorktreeReviewRange): string {
  const side = range.side === 'deletions' ? 'Old' : 'New';
  return range.startLine === range.endLine
    ? `${side} line ${range.startLine}`
    : `${side} lines ${range.startLine}–${range.endLine}`;
}

export function getWorktreeReviewAnnotations(
  comments: readonly WorktreeReviewComment[],
  capture: WorktreeReviewCapture,
  path: string
): DiffLineAnnotation<WorktreeReviewComment[]>[] {
  const groups = new Map<string, DiffLineAnnotation<WorktreeReviewComment[]>>();
  for (const comment of comments) {
    if (
      comment.anchor.path !== path ||
      !sameWorktreeReviewCapture(comment.anchor.capture, capture)
    ) {
      continue;
    }
    const { side, endLine } = comment.anchor.range;
    const key = `${side}:${endLine}`;
    const group = groups.get(key);
    if (group) group.metadata.push(comment);
    else groups.set(key, { side, lineNumber: endLine, metadata: [comment] });
  }
  return [...groups.values()];
}
