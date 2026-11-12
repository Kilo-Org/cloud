import { describe, expect, it } from 'vitest';

import {
  addSessionChangesComment,
  buildSessionChangesReviewPrompt,
  EMPTY_SESSION_CHANGES_DRAFT,
  getSessionChangesReviewBlock,
  removeSessionChangesComment,
  sessionChangesAnchorForLine,
  sessionChangesCaptureForFile,
  sessionChangesCommentsForFile,
  sessionChangesFileKey,
  sessionChangesFilePatch,
  type SessionChangesSnapshot,
  sessionChangesStaleCommentIds,
  updateSessionChangesComment,
} from '@/lib/session-changes-review';

const PATCH = ['@@ -1,2 +1,3 @@', ' one', '-two', '+three', ' four', ''].join('\n');

const snapshot: SessionChangesSnapshot = {
  schemaVersion: 2,
  capturedAt: '2026-11-12T10:00:00.000Z',
  revision: 4,
  comparison: { baseRef: 'main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
  truncated: false,
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      tracked: true,
      binary: false,
      countsComplete: true,
      revision: 4,
    },
  ],
};

const file = { path: 'src/app.ts', scope: undefined };

function capture() {
  const value = sessionChangesCaptureForFile({
    userId: 'user-one',
    organizationId: undefined,
    cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
    worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
    snapshot,
    file,
  });
  if (value === null) {
    throw new Error('expected a capture');
  }
  return value;
}

function anchor() {
  const result = sessionChangesAnchorForLine({
    capture: capture(),
    path: file.path,
    patch: PATCH,
    line: { side: 'additions', lineNumber: 2 },
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.anchor;
}

describe('sessionChangesCaptureForFile', () => {
  it('takes the listed revision and comparison into the capture', () => {
    const value = capture();
    expect(value).toEqual({
      userId: 'user-one',
      organizationId: undefined,
      workspaceScope: 'worktree:worktree_11111111-1111-4111-8111-111111111111',
      sourceCloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
      revision: 4,
      capturedAt: '2026-11-12T10:00:00.000Z',
      comparison: snapshot.comparison,
    });
  });

  it('returns null for a file the snapshot does not list', () => {
    expect(
      sessionChangesCaptureForFile({
        userId: 'user-one',
        organizationId: 'org-one',
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
        worktreeId: null,
        snapshot,
        file: { path: 'src/gone.ts', scope: undefined },
      })
    ).toBeNull();
  });
});

describe('session changes draft', () => {
  it('adds a comment and finds it by file', () => {
    const added = addSessionChangesComment(EMPTY_SESSION_CHANGES_DRAFT, {
      id: 'comment-one',
      anchor: anchor(),
      text: 'rename this',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    expect(sessionChangesCommentsForFile(added.draft, file)).toHaveLength(1);
    expect(sessionChangesCommentsForFile(added.draft, { path: 'other.ts' })).toHaveLength(0);
  });

  it('updates and removes a comment', () => {
    const added = addSessionChangesComment(EMPTY_SESSION_CHANGES_DRAFT, {
      id: 'comment-one',
      anchor: anchor(),
      text: 'first',
    });
    if (!added.ok) {
      throw new Error(added.error);
    }
    const updated = updateSessionChangesComment(added.draft, 'comment-one', 'second');
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    expect(updated.draft.comments[0]?.text).toBe('second');
    expect(removeSessionChangesComment(updated.draft, 'comment-one')).toEqual(
      EMPTY_SESSION_CHANGES_DRAFT
    );
  });

  it('refuses an empty review', () => {
    expect(buildSessionChangesReviewPrompt(EMPTY_SESSION_CHANGES_DRAFT)).toEqual({
      ok: false,
      error: 'Add a comment before sending the review.',
    });
  });

  it('builds the one message from every comment', () => {
    const added = addSessionChangesComment(EMPTY_SESSION_CHANGES_DRAFT, {
      id: 'comment-one',
      anchor: anchor(),
      text: 'rename this',
    });
    if (!added.ok) {
      throw new Error(added.error);
    }
    const built = buildSessionChangesReviewPrompt(added.draft);
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.prompt).toContain('"id": "comment-one"');
    expect(built.prompt).toContain('"contextStatus": "current-saved-capture"');
  });
});

describe('getSessionChangesReviewBlock', () => {
  it('reports a session with no Cloud Agent as read-only', () => {
    expect(
      getSessionChangesReviewBlock({ cloudAgentSessionId: null, mode: 'code', model: 'kilo/x' })
    ).toEqual({ kind: 'read-only' });
  });

  it('reports a session with no agent and model', () => {
    expect(
      getSessionChangesReviewBlock({
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
        mode: undefined,
        model: 'kilo/x',
      })
    ).toEqual({ kind: 'no-agent-model' });
  });

  it('allows a send when the session has an agent and model', () => {
    expect(
      getSessionChangesReviewBlock({
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
        mode: 'code',
        model: 'kilo/x',
      })
    ).toBeUndefined();
  });
});

describe('sessionChangesStaleCommentIds', () => {
  const draft = () => {
    const added = addSessionChangesComment(EMPTY_SESSION_CHANGES_DRAFT, {
      id: 'comment-1',
      anchor: anchor(),
      text: 'Keep this line.',
    });
    if (!added.ok) {
      throw new Error(added.error);
    }
    return added.draft;
  };

  const staleFor = (snapshotValue: SessionChangesSnapshot) =>
    sessionChangesStaleCommentIds({
      draft: draft(),
      snapshot: snapshotValue,
      userId: 'user-one',
      organizationId: undefined,
      cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
      worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
    });

  it('keeps comments current when a refresh only moves the capture time', () => {
    // A refresh that changes no file moves capturedAt alone; the web re-anchors
    // such a comment onto the new capture instead of refusing it.
    const refreshed: SessionChangesSnapshot = {
      ...snapshot,
      capturedAt: '2026-11-12T11:30:00.000Z',
    };
    expect(staleFor(refreshed).size).toBe(0);
  });

  it('marks a comment stale when its file moved to a new revision', () => {
    const bumped: SessionChangesSnapshot = {
      ...snapshot,
      revision: 5,
      capturedAt: '2026-11-12T11:30:00.000Z',
      files: snapshot.files.map(listed => ({ ...listed, revision: 5 })),
    };
    expect([...staleFor(bumped)]).toEqual(['comment-1']);
  });

  it('marks a comment stale when its file is no longer listed', () => {
    const removed: SessionChangesSnapshot = {
      ...snapshot,
      revision: 5,
      files: [],
    };
    expect([...staleFor(removed)]).toEqual(['comment-1']);
  });

  it('leaves every comment current while the session is still loading', () => {
    expect(
      sessionChangesStaleCommentIds({
        draft: draft(),
        snapshot: null,
        userId: 'user-one',
        organizationId: undefined,
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000000',
        worktreeId: null,
      }).size
    ).toBe(0);
  });
});

describe('session changes file presentation', () => {
  it('keeps a scoped file distinct from its unscoped twin', () => {
    expect(sessionChangesFileKey({ path: 'a.ts' })).toBe('a.ts');
    expect(sessionChangesFileKey({ path: 'a.ts', scope: 'uncommitted' })).toBe('uncommitted\0a.ts');
  });

  it('maps each file result to its patch state', () => {
    const record = {
      schemaVersion: 1 as const,
      revision: 4,
      path: 'src/app.ts',
      diff: { status: 'available' as const, patch: PATCH },
      content: { status: 'unavailable' as const, reason: 'too_large' as const },
    };
    expect(sessionChangesFilePatch(undefined)).toBeNull();
    expect(
      sessionChangesFilePatch({
        status: 'available',
        file: record,
        capturedAt: '2026-11-12T10:00:00.000Z',
        comparison: snapshot.comparison,
      })
    ).toEqual({ status: 'available', patch: PATCH });
    expect(sessionChangesFilePatch({ status: 'stale', currentRevision: 5 })).toEqual({
      status: 'stale',
    });
    expect(sessionChangesFilePatch({ status: 'not_captured' })).toEqual({
      status: 'not-captured',
    });
    expect(sessionChangesFilePatch({ status: 'no_longer_listed', currentRevision: 6 })).toEqual({
      status: 'no-longer-listed',
    });
  });
});
