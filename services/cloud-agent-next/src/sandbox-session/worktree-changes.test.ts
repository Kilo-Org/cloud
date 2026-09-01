import { describe, expect, it, vi } from 'vitest';
import type {
  WorktreeChangesCapture,
  WorktreeChangesCaptureRequest,
  WorktreeChangesSnapshot,
  WorktreeFileRecord,
  WorktreeSnapshotCapture,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { ResponseFrame } from '../shared/sandbox-control-protocol.js';
import { WORKTREE_CHANGED_EVENT } from '../shared/worktree-changes-wire.js';
import {
  createWorktreeChanges,
  worktreeChangesBaseRef,
  worktreeChangesContext,
  WORKTREE_CHANGES_KEY,
  WORKTREE_FILE_PREFIX,
  type WorktreeChangesContext,
} from './worktree-changes.js';

const context: WorktreeChangesContext = {
  session: {
    sessionId: 'workspace_test',
    kiloSessionId: 'kilo_root',
    directory: '/workspace/test',
  },
  ownerId: 'user_test',
  sandboxId: 'usr-abc123',
  provider: 'cloudflare',
  repository: { type: 'github', source: 'acme/demo' },
  baseRef: 'refs/remotes/origin/main',
};

function captureResult(revision: number): WorktreeChangesCapture {
  return {
    revision,
    comparison: {
      baseRef: 'refs/remotes/origin/main',
      mergeBase: 'a'.repeat(40),
      head: 'b'.repeat(40),
    },
    files: [
      {
        path: 'src/changed.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        tracked: true,
        binary: false,
        countsComplete: true,
      },
    ],
    truncated: false,
  };
}

const oldSnapshot: WorktreeChangesSnapshot = {
  ...captureResult(8),
  schemaVersion: 1,
  capturedAt: '2026-08-20T10:00:00.000Z',
};

function response(result: unknown): ResponseFrame {
  return { type: 'response', requestId: 'test', ok: true, result };
}

function fileRecord(revision: number, path = 'src/changed.ts'): WorktreeFileRecord {
  return {
    schemaVersion: 1,
    revision,
    path,
    diff: {
      status: 'available',
      patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    },
    content: { status: 'available', source: 'current', text: 'new\n' },
  };
}

function snapshotResponse(summary: WorktreeChangesCapture): ResponseFrame {
  return response({
    summary,
    files: summary.files.map(file => fileRecord(summary.revision, file.path)),
  } satisfies WorktreeSnapshotCapture);
}

function setup(saved: unknown = oldSnapshot) {
  const values = new Map<string, unknown>([
    [WORKTREE_CHANGES_KEY, saved],
    [`${WORKTREE_FILE_PREFIX}src/changed.ts`, fileRecord(8)],
  ]);
  const storage = {
    kv: {
      get: vi.fn((key: string) => values.get(key)),
      put: vi.fn((key: string, value: WorktreeChangesSnapshot | WorktreeFileRecord) => {
        values.set(key, value);
      }),
      delete: vi.fn((key: string) => values.delete(key)),
      list: vi.fn(({ prefix }: { prefix: string }) =>
        [...values].filter(([key]) => key.startsWith(prefix))
      ),
    },
    transactionSync<T>(callback: () => T): T {
      const before = new Map(values);
      try {
        return callback();
      } catch (error) {
        values.clear();
        for (const [key, value] of before) values.set(key, value);
        throw error;
      }
    },
  };
  const readContext = vi.fn<() => Promise<WorktreeChangesContext | null>>(async () => context);
  const requestCapture = vi.fn<
    (
      context: WorktreeChangesContext,
      payload: WorktreeChangesCaptureRequest,
      operation: 'session.git.snapshot' | 'session.git.summary'
    ) => Promise<ResponseFrame>
  >(async (_context, payload) => snapshotResponse(captureResult(payload.revision)));
  const background: Promise<unknown>[] = [];
  const deps = {
    storage,
    readContext,
    requestCapture,
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  };
  return {
    values,
    storage,
    readContext,
    requestCapture,
    background,
    deps,
    changes: createWorktreeChanges(deps),
  };
}

function holdCapture(harness: ReturnType<typeof setup>) {
  const started = Promise.withResolvers<WorktreeChangesCaptureRequest>();
  const finished = Promise.withResolvers<ResponseFrame>();
  harness.requestCapture.mockImplementationOnce(async (_context, payload) => {
    started.resolve(payload);
    return finished.promise;
  });
  return { started: started.promise, finish: finished.resolve, fail: finished.reject };
}

function terminal(harness: ReturnType<typeof setup>, currentContext = context): void {
  harness.changes.onEvent(currentContext, 'kilo_root', 'session.turn.close', {});
}

describe('worktree comparison context', () => {
  it.each([
    [undefined, undefined],
    ['main', 'refs/remotes/origin/main'],
    ['feature/a', 'refs/remotes/origin/feature/a'],
    ['refs/heads/release', 'refs/remotes/origin/refs/heads/release'],
    ['origin/release', 'refs/remotes/origin/origin/release'],
    ['remotes/origin/release', 'refs/remotes/origin/remotes/origin/release'],
    ['refs/remotes/upstream/release', 'refs/remotes/origin/refs/remotes/upstream/release'],
    ['refs/tags/v1', 'refs/remotes/origin/refs/tags/v1'],
  ])('maps the literal branch %s to %s', (branch, expected) => {
    expect(worktreeChangesBaseRef(branch)).toBe(expected);
  });

  it('uses selected upstream metadata and never the moving workspace branch or credentials', () => {
    const metadata = {
      metadataSchemaVersion: 2,
      identity: { sessionId: 'workspace_test', userId: 'user_test' },
      auth: { kiloSessionId: 'kilo_root', kilocodeToken: 'private-test-token' },
      repository: {
        type: 'github',
        repo: 'acme/demo',
        upstreamBranch: 'main',
        token: 'private-git-token',
      },
      workspace: { sandboxId: 'usr-abc123', branchName: 'moving-branch' },
      lifecycle: { version: 1, timestamp: 1 },
    } as SessionMetadata;
    expect(worktreeChangesContext(metadata, '/workspace/test')).toEqual(context);
    expect(
      worktreeChangesContext(
        {
          ...metadata,
          repository: { type: 'github', repo: 'acme/demo', upstreamBranch: 'origin/release' },
        },
        '/workspace/test'
      )
    ).toEqual({ ...context, baseRef: 'refs/remotes/origin/origin/release' });
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    expect(
      worktreeChangesContext(
        { ...metadata, workspace: { ...metadata.workspace, worktreeId } },
        '/workspace/shared'
      )
    ).toEqual({
      ...context,
      worktreeId,
      session: { ...context.session, directory: '/workspace/shared' },
    });
    expect(
      worktreeChangesContext({ ...metadata, repository: undefined }, '/workspace/test')
    ).toBeNull();
    expect(worktreeChangesContext({ ...metadata, auth: {} }, '/workspace/test')).toBeNull();
    expect(worktreeChangesContext({ ...metadata, workspace: {} }, '/workspace/test')).toBeNull();
    expect(
      worktreeChangesContext(
        { ...metadata, repository: { type: 'github', repo: 'acme/demo' } },
        '/workspace/test'
      )?.baseRef
    ).toBeUndefined();
  });
});

describe('worktree changes capture coordination', () => {
  it('reads only persisted, validated storage without resolving runtime context', async () => {
    const harness = setup();
    await expect(harness.changes.get()).resolves.toEqual({ snapshot: oldSnapshot });
    harness.values.set(WORKTREE_CHANGES_KEY, { ...oldSnapshot, schemaVersion: 2 });
    await expect(harness.changes.get()).resolves.toEqual({ snapshot: null });
    expect(harness.readContext).not.toHaveBeenCalled();
    expect(harness.requestCapture).not.toHaveBeenCalled();
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
  });

  it('reads a selected saved file atomically without loading other bodies or runtime context', () => {
    const harness = setup();
    const transaction = vi.spyOn(harness.storage, 'transactionSync');
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'available',
      file: fileRecord(8),
      capturedAt: oldSnapshot.capturedAt,
      comparison: oldSnapshot.comparison,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(harness.storage.kv.get.mock.calls.map(([key]) => key)).toEqual([
      WORKTREE_CHANGES_KEY,
      `${WORKTREE_FILE_PREFIX}src/changed.ts`,
    ]);
    expect(harness.storage.kv.list).not.toHaveBeenCalled();
    expect(harness.readContext).not.toHaveBeenCalled();
    expect(harness.requestCapture).not.toHaveBeenCalled();
  });

  it('distinguishes stale, no-longer-listed, and uncaptured files without returning old bodies', () => {
    const harness = setup();
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 7 })).toEqual({
      status: 'stale',
      currentRevision: 8,
    });
    expect(harness.changes.getFile({ path: 'gone.ts', expectedRevision: 8 })).toEqual({
      status: 'no_longer_listed',
      currentRevision: 8,
    });
    harness.values.delete(`${WORKTREE_FILE_PREFIX}src/changed.ts`);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'not_captured',
    });
    harness.values.delete(WORKTREE_CHANGES_KEY);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'not_captured',
    });
    expect(harness.requestCapture).not.toHaveBeenCalled();
  });

  it.each([
    { ...fileRecord(8), revision: 7 },
    { ...fileRecord(8), path: 'other.ts' },
    { ...fileRecord(8), schemaVersion: 2 },
    { ...fileRecord(8), content: { status: 'available', source: 'deleted-original', text: 'old' } },
    { ...fileRecord(8), diff: { status: 'available', patch: 'x'.repeat(512 * 1024) } },
  ])('does not expose an invalid persisted file record', invalid => {
    const harness = setup();
    harness.values.set(`${WORKTREE_FILE_PREFIX}src/changed.ts`, invalid);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'not_captured',
    });
  });

  it('returns omissions and empty complete text as distinct saved states', () => {
    const harness = setup();
    const omitted: WorktreeFileRecord = {
      ...fileRecord(8),
      diff: { status: 'omitted', reason: 'too_large' },
      content: { status: 'unavailable', reason: 'too_large' },
    };
    harness.values.set(`${WORKTREE_FILE_PREFIX}src/changed.ts`, omitted);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toMatchObject({
      status: 'omitted',
      file: omitted,
    });
    const empty: WorktreeFileRecord = {
      ...fileRecord(8),
      content: { status: 'available', source: 'current', text: '' },
    };
    harness.values.set(`${WORKTREE_FILE_PREFIX}src/changed.ts`, empty);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toMatchObject({
      status: 'available',
      file: empty,
    });
  });

  it.each([
    null,
    { path: '../secret', expectedRevision: 8 },
    { path: '/secret', expectedRevision: 8 },
    { path: 'src/changed.ts', expectedRevision: 0 },
    { path: 'src/changed.ts', expectedRevision: 1.5 },
    { path: 'src/changed.ts', expectedRevision: 8, directory: '/secret' },
  ])('rejects an invalid saved query before storage access', query => {
    const harness = setup();
    expect(() => harness.changes.getFile(query)).toThrow('Invalid worktree file query');
    expect(harness.storage.kv.get).not.toHaveBeenCalled();
    expect(harness.storage.kv.list).not.toHaveBeenCalled();
  });

  it('returns the original content only for a deleted summary entry', () => {
    const harness = setup();
    harness.values.set(WORKTREE_CHANGES_KEY, {
      ...oldSnapshot,
      files: oldSnapshot.files.map(file => ({ ...file, status: 'deleted' })),
    });
    const deleted: WorktreeFileRecord = {
      ...fileRecord(8),
      content: { status: 'available', source: 'deleted-original', text: 'original\n' },
    };
    harness.values.set(`${WORKTREE_FILE_PREFIX}src/changed.ts`, deleted);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toMatchObject({
      status: 'available',
      file: deleted,
    });
  });

  it('fails closed on a malformed manifest and on suppressed saved reads', () => {
    const harness = setup();
    harness.values.set(WORKTREE_CHANGES_KEY, {
      ...oldSnapshot,
      files: [...oldSnapshot.files, ...oldSnapshot.files],
    });
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'not_captured',
    });
    harness.values.set(WORKTREE_CHANGES_KEY, oldSnapshot);
    harness.changes.suppress();
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toEqual({
      status: 'not_captured',
    });
    expect(harness.readContext).not.toHaveBeenCalled();
    expect(harness.requestCapture).not.toHaveBeenCalled();
  });

  it('installs the in-flight promise synchronously and coalesces manual refreshes', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const first = harness.changes.refresh();
    const second = harness.changes.refresh();
    expect(second).toBe(first);
    expect(await held.started).toEqual({ revision: 9, baseRef: context.baseRef });
    expect(harness.changes.refresh()).toBe(first);
    held.finish(snapshotResponse(captureResult(9)));
    const result = await first;
    expect(result.status).toBe('refreshed');
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    expect(harness.values.get(WORKTREE_CHANGES_KEY)).toEqual(result.snapshot);
    expect(result.snapshot?.capturedAt).not.toBe(oldSnapshot.capturedAt);
  });

  it('keeps one trailing capture for lifecycle events arriving during manual capture', async () => {
    const harness = setup();
    const first = holdCapture(harness);
    const second = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await first.started;
    terminal(harness);
    terminal(harness);
    terminal(harness);
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    first.finish(snapshotResponse(captureResult(9)));
    expect((await second.started).revision).toBe(10);
    second.finish(snapshotResponse({ ...captureResult(10), files: [] }));
    await expect(refreshed).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 10, files: [] },
    });
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
  });

  it('captures dirty hints immediately and retains one trailing capture during a scan', async () => {
    const harness = setup();
    const first = holdCapture(harness);
    const second = holdCapture(harness);
    harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    expect(harness.background).toHaveLength(1);
    expect((await first.started).revision).toBe(9);
    for (let hint = 0; hint < 3; hint++) {
      harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    }
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    first.finish(snapshotResponse(captureResult(9)));
    expect((await second.started).revision).toBe(10);
    second.finish(snapshotResponse({ ...captureResult(10), files: [] }));
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    await expect(harness.changes.get()).resolves.toMatchObject({
      snapshot: { revision: 10, files: [] },
    });
  });

  it.each(['session.idle', 'session.status'])(
    'preserves pending interruption settlement on %s after a dirty capture',
    async type => {
      const harness = setup();
      harness.changes.markInterrupted(context);
      harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
      await Promise.all(harness.background);
      expect(harness.requestCapture).toHaveBeenCalledTimes(1);
      harness.changes.onEvent(context, 'kilo_root', type, { status: { type: 'idle' } });
      await Promise.all(harness.background);
      expect(harness.requestCapture).toHaveBeenCalledTimes(2);
      harness.changes.onEvent(context, 'kilo_root', type, { status: { type: 'idle' } });
      await Promise.all(harness.background);
      expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    }
  );

  it('recaptures dirty changes at turn close and after finalization', async () => {
    const harness = setup();
    harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    terminal(harness);
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    harness.changes.onEvent(context, 'kilo_root', 'session.message.outcome', {
      messageId: 'msg_completed',
      status: 'completed',
    });
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(3);
    await expect(harness.changes.get()).resolves.toMatchObject({ snapshot: { revision: 11 } });
  });

  it('captures again after finalization when the turn-close capture races a HEAD change', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    terminal(harness);
    await held.started;
    harness.changes.onEvent(context, 'kilo_root', 'session.message.outcome', {
      messageId: 'msg_completed',
      status: 'completed',
    });
    held.finish({
      type: 'response',
      requestId: 'turn-close',
      ok: false,
      error: { code: 'capture_failed', message: 'HEAD changed', retryable: true },
    });
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    expect(harness.storage.kv.put).toHaveBeenCalledWith(
      WORKTREE_CHANGES_KEY,
      expect.objectContaining({ revision: 10 })
    );
    await expect(harness.changes.get()).resolves.toMatchObject({ snapshot: { revision: 10 } });
  });

  it('allows the pending lifecycle slot to refill during a trailing capture without retrying failures', async () => {
    const harness = setup();
    const first = holdCapture(harness);
    const second = holdCapture(harness);
    const third = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await first.started;
    terminal(harness);
    first.fail(new Error('capture timeout'));
    expect((await second.started).revision).toBe(10);
    terminal(harness);
    terminal(harness);
    second.finish(snapshotResponse(captureResult(10)));
    expect((await third.started).revision).toBe(11);
    third.finish(snapshotResponse(captureResult(11)));
    await expect(refreshed).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 11 },
    });
    expect(harness.requestCapture).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['directory', { ...context, session: { ...context.session, directory: '/other' } }],
    ['root', { ...context, session: { ...context.session, kiloSessionId: 'other_root' } }],
    ['session', { ...context, session: { ...context.session, sessionId: 'workspace_other' } }],
    ['sandbox', { ...context, sandboxId: 'usr-other' }],
    [
      'worktree',
      { ...context, worktreeId: 'worktree_11111111-1111-4111-8111-111111111111' as const },
    ],
    ['provider', { ...context, provider: 'vercel' as const }],
    ['repository', { ...context, repository: { type: 'github', source: 'acme/other' } }],
    ['base', { ...context, baseRef: 'refs/remotes/origin/other' }],
    ['owner', { ...context, ownerId: 'other_owner' }],
    ['deleted metadata', null],
  ])('discards a result after %s changes during capture', async (_name, nextContext) => {
    const harness = setup();
    const held = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await held.started;
    harness.readContext.mockResolvedValue(nextContext);
    held.finish(snapshotResponse(captureResult(9)));
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
    await expect(harness.changes.get()).resolves.toEqual({ snapshot: oldSnapshot });
  });

  it('fences preparation even when replacement metadata is identical and captures after the latest attach', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await held.started;
    const oldGeneration = harness.changes.beginPreparation();
    const currentGeneration = harness.changes.beginPreparation();
    harness.changes.attached(oldGeneration, context);
    expect(harness.background).toHaveLength(0);
    held.finish(snapshotResponse(captureResult(9)));
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    harness.changes.attached(currentGeneration, context);
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    await expect(harness.changes.get()).resolves.toMatchObject({ snapshot: { revision: 10 } });
  });

  it('cleans up only the current preparation without exposing a newer unfinished workspace', async () => {
    const harness = setup();
    const obsolete = harness.changes.beginPreparation();
    const current = harness.changes.beginPreparation();
    harness.changes.finishPreparation(obsolete);
    terminal(harness);
    harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    expect(harness.requestCapture).not.toHaveBeenCalled();
    expect(harness.background).toHaveLength(0);

    harness.changes.finishPreparation(current);
    expect(harness.background).toHaveLength(0);
    await expect(harness.changes.refresh()).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 9 },
    });
    terminal(harness);
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
  });

  it('does not restore an obsolete capture fence when preparation ends unsuccessfully', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const pending = harness.changes.refresh();
    await held.started;
    const generation = harness.changes.beginPreparation();
    harness.changes.finishPreparation(generation);
    held.finish(snapshotResponse(captureResult(9)));
    await expect(pending).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
    await expect(harness.changes.refresh()).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 10 },
    });
  });

  it('does not override deletion suppression when preparation ends', async () => {
    const harness = setup();
    const generation = harness.changes.beginPreparation();
    harness.changes.suppress();
    harness.changes.finishPreparation(generation);
    terminal(harness);
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    expect(harness.requestCapture).not.toHaveBeenCalled();
    expect(harness.background).toHaveLength(0);
  });

  it('uses the latest attached context for a trailing capture after replacement', async () => {
    const harness = setup();
    const first = holdCapture(harness);
    const trailing = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await first.started;
    const replaced = { ...context, sandboxId: 'usr-other', baseRef: 'refs/remotes/origin/release' };
    const generation = harness.changes.beginPreparation();
    harness.readContext.mockResolvedValue(replaced);
    harness.changes.attached(generation, replaced);
    terminal(harness, replaced);
    first.finish(snapshotResponse(captureResult(9)));
    expect(await trailing.started).toEqual({ revision: 10, baseRef: replaced.baseRef });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
    trailing.finish(
      snapshotResponse({
        ...captureResult(10),
        comparison: { ...captureResult(10).comparison, baseRef: replaced.baseRef },
      })
    );
    await expect(refreshed).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 10, comparison: { baseRef: replaced.baseRef } },
    });
    expect(harness.values.get(`${WORKTREE_FILE_PREFIX}src/changed.ts`)).toEqual(fileRecord(10));
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
  });

  it('reports a superseded offline response as failed without overwriting storage', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await held.started;
    harness.changes.beginPreparation();
    held.finish({
      type: 'response',
      requestId: 'test',
      ok: false,
      error: { code: 'not_ready', message: 'offline', retryable: false },
    });
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
  });

  it('rechecks generation after the final metadata read and immediately before writing', async () => {
    const harness = setup();
    harness.readContext.mockResolvedValueOnce(context).mockImplementationOnce(async () => {
      harness.changes.beginPreparation();
      return context;
    });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
  });

  it('suppresses capture before deletion interrupt and never recreates deleted storage', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const refreshed = harness.changes.refresh();
    await held.started;
    terminal(harness);
    harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    harness.changes.suppress();
    harness.changes.markInterrupted(context);
    terminal(harness);
    harness.changes.onEvent(context, 'kilo_root', WORKTREE_CHANGED_EVENT, {});
    harness.changes.onEvent(context, 'kilo_root', 'session.idle', {});
    harness.values.clear();
    held.finish(snapshotResponse(captureResult(9)));
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
    await expect(harness.changes.get()).resolves.toEqual({ snapshot: null });
    await expect(harness.changes.refresh()).resolves.toEqual({ status: 'offline', snapshot: null });
  });

  it.each([
    [
      'Git failure',
      {
        type: 'response',
        requestId: 'test',
        ok: false,
        error: { code: 'git_failed', message: 'failed', retryable: false },
      },
    ],
    ['malformed data', response({ files: [] })],
    ['wrong revision', snapshotResponse(captureResult(10))],
    [
      'wrong comparison',
      snapshotResponse({
        ...captureResult(9),
        comparison: { ...captureResult(9).comparison, baseRef: 'HEAD' },
      }),
    ],
    [
      'oversized file list',
      snapshotResponse({
        ...captureResult(9),
        files: Array.from({ length: 1001 }, () => captureResult(9).files[0]),
      }),
    ],
  ] satisfies [string, ResponseFrame][])(
    'preserves the exact old snapshot on %s',
    async (_name, failed) => {
      const harness = setup();
      harness.requestCapture.mockResolvedValue(failed);
      await expect(harness.changes.refresh()).resolves.toEqual({
        status: 'failed',
        snapshot: oldSnapshot,
      });
      expect(harness.values.get(WORKTREE_CHANGES_KEY)).toEqual(oldSnapshot);
      expect(harness.storage.kv.put).not.toHaveBeenCalled();
      expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves saved data on timeout and persistence failure', async () => {
    const harness = setup();
    harness.requestCapture.mockRejectedValueOnce(new Error('timeout'));
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    harness.storage.kv.put.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    expect(harness.values.get(WORKTREE_CHANGES_KEY)).toEqual(oldSnapshot);
  });

  it('replaces the complete snapshot and removes superseded records in the same transaction', async () => {
    const harness = setup();
    const summary = captureResult(9);
    summary.files = summary.files.map(file => ({ ...file, path: 'new.ts' }));
    harness.requestCapture.mockResolvedValueOnce(snapshotResponse(summary));
    const result = await harness.changes.refresh();
    expect(result).toMatchObject({ status: 'refreshed', snapshot: { revision: 9 } });
    expect(harness.values.get(WORKTREE_CHANGES_KEY)).toEqual(result.snapshot);
    expect(harness.values.has(`${WORKTREE_FILE_PREFIX}src/changed.ts`)).toBe(false);
    expect(harness.values.get(`${WORKTREE_FILE_PREFIX}new.ts`)).toEqual(fileRecord(9, 'new.ts'));
  });

  it('does not pair a newly omitted diff with old complete content for the same path', async () => {
    const harness = setup();
    const omitted: WorktreeFileRecord = {
      ...fileRecord(9),
      diff: { status: 'omitted', reason: 'budget_exhausted' },
      content: { status: 'unavailable', reason: 'budget_exhausted' },
    };
    harness.requestCapture.mockResolvedValueOnce(
      response({ summary: captureResult(9), files: [omitted] })
    );
    await expect(harness.changes.refresh()).resolves.toMatchObject({ status: 'refreshed' });
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 9 })).toMatchObject({
      status: 'omitted',
      file: omitted,
    });
    expect(harness.values.get(`${WORKTREE_FILE_PREFIX}src/changed.ts`)).toEqual(omitted);
  });

  it('rolls back body writes and deletions if the manifest cannot be replaced', async () => {
    const harness = setup();
    const before = new Map(harness.values);
    const summary = captureResult(9);
    summary.files = summary.files.map(file => ({ ...file, path: 'new.ts' }));
    harness.requestCapture.mockResolvedValueOnce(snapshotResponse(summary));
    harness.storage.kv.put.mockImplementation((key, value) => {
      if (key === WORKTREE_CHANGES_KEY) throw new Error('manifest write failed');
      harness.values.set(key, value);
    });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    expect(harness.values).toEqual(before);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 8 })).toMatchObject({
      status: 'available',
      file: fileRecord(8),
    });
  });

  it('falls back once only for unknown_operation and clears bodies after legacy success', async () => {
    const harness = setup();
    harness.requestCapture
      .mockResolvedValueOnce({
        type: 'response',
        requestId: 'snapshot',
        ok: false,
        error: { code: 'unknown_operation', message: 'Unknown operation', retryable: false },
      })
      .mockResolvedValueOnce(response(captureResult(9)));
    await expect(harness.changes.refresh()).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 9 },
    });
    expect(harness.requestCapture.mock.calls.map(([, , operation]) => operation)).toEqual([
      'session.git.snapshot',
      'session.git.summary',
    ]);
    expect(harness.values.has(`${WORKTREE_FILE_PREFIX}src/changed.ts`)).toBe(false);
    expect(harness.changes.getFile({ path: 'src/changed.ts', expectedRevision: 9 })).toEqual({
      status: 'not_captured',
    });
  });

  it('does not retry an unknown legacy operation or discard the previous snapshot', async () => {
    const harness = setup();
    const before = new Map(harness.values);
    harness.requestCapture.mockResolvedValue({
      type: 'response',
      requestId: 'unknown',
      ok: false,
      error: { code: 'unknown_operation', message: 'Unknown operation', retryable: false },
    });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    expect(harness.requestCapture).toHaveBeenCalledTimes(2);
    expect(harness.values).toEqual(before);
  });

  it('does not attempt legacy fallback after the capture generation changes', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const pending = harness.changes.refresh();
    await held.started;
    harness.changes.beginPreparation();
    held.finish({
      type: 'response',
      requestId: 'unknown',
      ok: false,
      error: { code: 'unknown_operation', message: 'Unknown operation', retryable: false },
    });
    await expect(pending).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
  });

  it.each(
    [
      [],
      [fileRecord(9), fileRecord(9)],
      [fileRecord(9, 'other.ts')],
      [fileRecord(8)],
      [{ ...fileRecord(9), path: '../secret' }],
      [
        {
          ...fileRecord(9),
          content: { status: 'available', source: 'current', text: 'x'.repeat(100 * 1024) },
        },
      ],
      [{ ...fileRecord(9), diff: { status: 'available', patch: '+line\n'.repeat(10001) } }],
    ].map(files => ({ files }))
  )(
    'rejects invalid snapshot membership, revision, or body limits before saving',
    async ({ files }) => {
      const harness = setup();
      const before = new Map(harness.values);
      harness.requestCapture.mockResolvedValueOnce(response({ summary: captureResult(9), files }));
      await expect(harness.changes.refresh()).resolves.toEqual({
        status: 'failed',
        snapshot: oldSnapshot,
      });
      expect(harness.requestCapture).toHaveBeenCalledTimes(1);
      expect(harness.values).toEqual(before);
    }
  );

  it('returns offline without capture when context is unavailable', async () => {
    const harness = setup();
    harness.readContext.mockResolvedValue(null);
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    expect(harness.requestCapture).not.toHaveBeenCalled();
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
  });

  it('preserves saved data when the ready-only transport is unavailable', async () => {
    const harness = setup();
    harness.requestCapture.mockResolvedValue({
      type: 'response',
      requestId: 'test',
      ok: false,
      error: { code: 'not_ready', message: 'offline', retryable: false },
    });
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    expect(harness.storage.kv.put).not.toHaveBeenCalled();
  });

  it('replaces old files with a valid empty capture and resumes revisions from persisted data', async () => {
    const harness = setup();
    harness.requestCapture.mockImplementation(async (_context, payload) =>
      snapshotResponse({ ...captureResult(payload.revision), files: [] })
    );
    const refreshed = await harness.changes.refresh();
    expect(refreshed).toMatchObject({ status: 'refreshed', snapshot: { files: [], revision: 9 } });
    const restarted = createWorktreeChanges(harness.deps);
    await expect(restarted.get()).resolves.toEqual({ snapshot: refreshed.snapshot });
    await expect(restarted.refresh()).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { files: [], revision: 10 },
    });
  });

  it.each(['session.turn.close', 'session.error', WORKTREE_CHANGED_EVENT])(
    'captures only positively identified root %s events',
    async type => {
      const harness = setup();
      harness.changes.onEvent(context, 'kilo_child', type, {});
      harness.changes.onEvent(context, undefined, type, {});
      expect(harness.background).toHaveLength(0);
      harness.changes.onEvent(context, 'kilo_root', type, {});
      await Promise.all(harness.background);
      expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['session.idle', 'session.status'])(
    'waits for confirmed root %s after interruption',
    async type => {
      const harness = setup();
      harness.changes.onEvent(context, 'kilo_root', type, { status: { type: 'idle' } });
      expect(harness.background).toHaveLength(0);
      harness.changes.markInterrupted(context);
      harness.changes.onEvent(context, 'kilo_child', type, { status: { type: 'idle' } });
      harness.changes.onEvent(context, 'kilo_root', 'session.status', { status: { type: 'busy' } });
      harness.changes.onEvent(context, 'kilo_root', 'session.status', { status: 'idle' });
      expect(harness.background).toHaveLength(0);
      harness.changes.onEvent(context, 'kilo_root', type, { status: { type: 'idle' } });
      await Promise.all(harness.background);
      harness.changes.onEvent(context, 'kilo_root', 'session.idle', {});
      expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    }
  );

  it('does not transfer pending interruption settlement into a changed workspace', () => {
    const harness = setup();
    harness.changes.markInterrupted(context);
    harness.changes.onEvent(
      { ...context, sandboxId: 'usr-other' },
      'kilo_root',
      'session.idle',
      {}
    );
    harness.changes.beginPreparation();
    harness.changes.onEvent(context, 'kilo_root', 'session.idle', {});
    expect(harness.background).toHaveLength(0);
  });
});
