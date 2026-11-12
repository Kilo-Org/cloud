// The session changes screen's review draft and the anchor it quotes from a
// saved worktree patch. Pure — no React, no Expo — so the draft rules and the
// message format are testable in plain Node and match the web's review exactly
// through `@kilocode/app-shared/worktree-review`.

import {
  addWorktreeReviewComment,
  createWorktreeReviewAnchorFromPatch,
  removeWorktreeReviewComment,
  sameWorktreeReviewContent,
  serializeWorktreeReview,
  updateWorktreeReviewComment,
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
} from '@kilocode/app-shared/worktree-review';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type WorktreeChangesOutput =
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['getWorktreeChanges'];
export type SessionChangesSnapshot = NonNullable<WorktreeChangesOutput['snapshot']>;
export type SessionChangesFile = SessionChangesSnapshot['files'][number];
export type SessionChangesFileResult =
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['getWorktreeFile'];

export type SessionChangesDraft = { comments: WorktreeReviewComment[] };

export const EMPTY_SESSION_CHANGES_DRAFT: SessionChangesDraft = { comments: [] };

/** A file's identity inside one snapshot: the same path may be listed twice, once per scope. */
export function sessionChangesFileKey(file: { path: string; scope?: string }): string {
  return file.scope === undefined ? file.path : `${file.scope}\0${file.path}`;
}

/**
 * Why review comments are not offered. `read-only` is a session with no Cloud
 * Agent (nothing to send to); `no-agent-model` means the session has no agent
 * and model that could receive the review.
 */
export type SessionChangesReviewBlock = { kind: 'read-only' } | { kind: 'no-agent-model' };

export function getSessionChangesReviewBlock({
  cloudAgentSessionId,
  mode,
  model,
}: {
  cloudAgentSessionId: string | null;
  mode: string | undefined;
  model: string | undefined;
}): SessionChangesReviewBlock | undefined {
  if (cloudAgentSessionId === null) {
    return { kind: 'read-only' };
  }
  if (!mode || !model) {
    return { kind: 'no-agent-model' };
  }
  return undefined;
}

/**
 * The capture a review comment records: the snapshot's revision and comparison
 * for the listed file, plus the account and workspace the session belongs to.
 */
export function sessionChangesCaptureForFile({
  userId,
  organizationId,
  cloudAgentSessionId,
  worktreeId,
  snapshot,
  file,
}: {
  userId: string;
  organizationId: string | undefined;
  cloudAgentSessionId: string;
  worktreeId: string | null | undefined;
  snapshot: SessionChangesSnapshot;
  file: { path: string; scope?: SessionChangesFile['scope'] };
}): WorktreeReviewCapture | null {
  const listed = snapshot.files.find(
    entry => entry.path === file.path && entry.scope === file.scope
  );
  if (listed === undefined) {
    return null;
  }
  return {
    userId,
    organizationId,
    workspaceScope: worktreeId ? `worktree:${worktreeId}` : `session:${cloudAgentSessionId}`,
    sourceCloudAgentSessionId: cloudAgentSessionId,
    revision: listed.revision,
    ...(listed.scope === undefined ? {} : { scope: listed.scope }),
    capturedAt: snapshot.capturedAt,
    comparison: snapshot.comparison,
  };
}

/**
 * Comments whose saved capture no longer matches the session's current one: the
 * capture moved since they were written, so the quote and line number the agent
 * would receive are no longer provably current. The review cannot be sent until
 * those comments are re-anchored by adding them again on the current diff.
 *
 * A refresh that changes no file moves `capturedAt` only, which is still
 * current: the comparison is `sameWorktreeReviewContent`, the same identity the
 * web applies without rebasing a comment.
 */
export function sessionChangesStaleCommentIds({
  draft,
  snapshot,
  userId,
  organizationId,
  cloudAgentSessionId,
  worktreeId,
}: {
  draft: SessionChangesDraft;
  snapshot: SessionChangesSnapshot | null;
  userId: string | undefined;
  organizationId: string | undefined;
  cloudAgentSessionId: string | null;
  worktreeId: string | null | undefined;
}): ReadonlySet<string> {
  const stale = new Set<string>();
  if (snapshot === null || cloudAgentSessionId === null || userId === undefined) {
    return stale;
  }
  for (const comment of draft.comments) {
    const scope = comment.anchor.capture.scope;
    const current = sessionChangesCaptureForFile({
      userId,
      organizationId,
      cloudAgentSessionId,
      worktreeId,
      snapshot,
      file: { path: comment.anchor.path, ...(scope === undefined ? {} : { scope }) },
    });
    if (current === null || !sameWorktreeReviewContent(comment.anchor.capture, current)) {
      stale.add(comment.id);
    }
  }
  return stale;
}

export function sessionChangesAnchorForLine({
  capture,
  path,
  patch,
  line,
}: {
  capture: WorktreeReviewCapture;
  path: string;
  patch: string;
  line: { side: 'deletions' | 'additions'; lineNumber: number };
}): { ok: true; anchor: WorktreeReviewAnchor } | { ok: false; error: string } {
  const result = createWorktreeReviewAnchorFromPatch({ capture, path, patch, line });
  return result.ok ? { ok: true, anchor: result.value } : result;
}

export function addSessionChangesComment(
  draft: SessionChangesDraft,
  comment: WorktreeReviewComment
): { ok: true; draft: SessionChangesDraft } | { ok: false; error: string } {
  const result = addWorktreeReviewComment(draft.comments, comment);
  return result.ok ? { ok: true, draft: { comments: result.value } } : result;
}

export function updateSessionChangesComment(
  draft: SessionChangesDraft,
  id: string,
  text: string
): { ok: true; draft: SessionChangesDraft } | { ok: false; error: string } {
  const result = updateWorktreeReviewComment(draft.comments, id, text);
  return result.ok ? { ok: true, draft: { comments: result.value } } : result;
}

export function removeSessionChangesComment(
  draft: SessionChangesDraft,
  id: string
): SessionChangesDraft {
  return { comments: removeWorktreeReviewComment(draft.comments, id) };
}

export function sessionChangesCommentsForFile(
  draft: SessionChangesDraft,
  file: { path: string; scope?: SessionChangesFile['scope'] }
): WorktreeReviewComment[] {
  return draft.comments.filter(
    comment => comment.anchor.path === file.path && comment.anchor.capture.scope === file.scope
  );
}

/** The one message a whole draft becomes, formatted by the shared serializer. */
export function buildSessionChangesReviewPrompt(
  draft: SessionChangesDraft,
  options: { overall?: string } = {}
): { ok: true; prompt: string } | { ok: false; error: string } {
  const result = serializeWorktreeReview(draft.comments, options);
  return result.ok ? { ok: true, prompt: result.value } : result;
}

/**
 * The patch a file result carries, or why it cannot be shown. A `stale` result
 * means the session produced a newer snapshot, so the file must be fetched
 * again against the revision the list now shows.
 */
export type SessionChangesFilePatch =
  | { status: 'available'; patch: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'stale' }
  | { status: 'not-captured' }
  | { status: 'no-longer-listed' };

export function sessionChangesFilePatch(
  result: SessionChangesFileResult | undefined
): SessionChangesFilePatch | null {
  if (result === undefined) {
    return null;
  }
  if (result.status === 'available' || result.status === 'omitted') {
    return result.file.diff.status === 'available'
      ? { status: 'available', patch: result.file.diff.patch }
      : { status: 'unavailable', reason: result.file.diff.reason };
  }
  if (result.status === 'stale') {
    return { status: 'stale' };
  }
  if (result.status === 'not_captured') {
    return { status: 'not-captured' };
  }
  return { status: 'no-longer-listed' };
}
