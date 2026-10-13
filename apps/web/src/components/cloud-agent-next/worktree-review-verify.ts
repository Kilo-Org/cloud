import type {
  GetWorktreeFileOutput,
  WorktreeChangesSnapshot,
  WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  rebaseWorktreeReviewComment,
  sameWorktreeReviewCapture,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
} from './worktree-review';
import type { WorktreeReviewScope } from './worktree-review-state';
import { resolveWorktreeRenderedDiff } from './worktree-file-diff';

export type WorktreeReviewVerification =
  | { status: 'applied'; comment: WorktreeReviewComment }
  | { status: 'unapplied' }
  | { status: 'unverified' };

export function isWorktreeReviewFileAbsent(
  comment: WorktreeReviewComment,
  snapshot: WorktreeChangesSnapshot | null | undefined
): boolean {
  return Boolean(
    snapshot &&
    !snapshot.truncated &&
    snapshot.revision >= comment.anchor.capture.revision &&
    comment.anchor.capture.scope !== undefined &&
    !snapshot.files.some(
      file =>
        file.path === comment.anchor.path &&
        (file.scope === comment.anchor.capture.scope || file.scope === undefined)
    )
  );
}

export async function verifyWorktreeReviewComment({
  comment,
  scope,
  snapshot,
  fetchFile,
}: {
  comment: WorktreeReviewComment;
  scope: WorktreeReviewScope;
  snapshot: WorktreeChangesSnapshot | null | undefined;
  fetchFile: (input: {
    path: string;
    revision: number;
    scope?: WorktreeFileQuery['scope'];
  }) => Promise<GetWorktreeFileOutput>;
}): Promise<WorktreeReviewVerification> {
  if (!snapshot) return { status: 'unverified' };
  const source = comment.anchor.capture.sourceCloudAgentSessionId;
  const listed = snapshot.files.find(
    file => file.path === comment.anchor.path && file.scope === comment.anchor.capture.scope
  );
  if (!listed)
    return { status: isWorktreeReviewFileAbsent(comment, snapshot) ? 'unapplied' : 'unverified' };
  const capture: WorktreeReviewCapture = {
    ...scope,
    sourceCloudAgentSessionId: source,
    revision: listed.revision,
    scope: listed.scope,
    capturedAt: snapshot.capturedAt,
    comparison: snapshot.comparison,
  };
  if (sameWorktreeReviewCapture(comment.anchor.capture, capture)) {
    return { status: 'applied', comment };
  }
  let fileResult: GetWorktreeFileOutput;
  try {
    fileResult = await fetchFile({
      path: comment.anchor.path,
      revision: listed.revision,
      scope: listed.scope,
    });
  } catch {
    return { status: 'unverified' };
  }
  if (fileResult.status !== 'available' && fileResult.status !== 'omitted') {
    return { status: 'unverified' };
  }
  if (
    fileResult.file.path !== listed.path ||
    fileResult.file.scope !== listed.scope ||
    fileResult.file.revision !== listed.revision
  )
    return { status: 'unverified' };
  const diff = resolveWorktreeRenderedDiff(fileResult.file);
  if (!diff) return { status: 'unverified' };
  const rebased = rebaseWorktreeReviewComment(comment, capture, fileResult.file, diff);
  return rebased ? { status: 'applied', comment: rebased } : { status: 'unapplied' };
}
