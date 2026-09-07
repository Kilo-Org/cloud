import { describe, expect, it, vi } from 'vitest';
import type {
  WorktreeChangesCapture,
  WorktreeChangesCaptureRequest,
  WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { ResponseFrame } from '../shared/sandbox-control-protocol.js';
import { WORKTREE_CHANGED_EVENT } from '../shared/worktree-changes-wire.js';
import {
  createWorktreeChanges,
  worktreeChangesBaseRef,
  worktreeChangesContext,
  WORKTREE_CHANGES_KEY,
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

function setup(saved: unknown = oldSnapshot) {
  const values = new Map<string, unknown>([[WORKTREE_CHANGES_KEY, saved]]);
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: WorktreeChangesSnapshot) => {
      values.set(key, value);
    }),
  };
  const readContext = vi.fn<() => Promise<WorktreeChangesContext | null>>(async () => context);
  const requestCapture = vi.fn<
    (
      context: WorktreeChangesContext,
      payload: WorktreeChangesCaptureRequest
    ) => Promise<ResponseFrame>
  >(async (_context, payload) => response(captureResult(payload.revision)));
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
    expect(harness.storage.put).not.toHaveBeenCalled();
  });

  it('installs the in-flight promise synchronously and coalesces manual refreshes', async () => {
    const harness = setup();
    const held = holdCapture(harness);
    const first = harness.changes.refresh();
    const second = harness.changes.refresh();
    expect(second).toBe(first);
    expect(await held.started).toEqual({ revision: 9, baseRef: context.baseRef });
    expect(harness.changes.refresh()).toBe(first);
    held.finish(response(captureResult(9)));
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
    first.finish(response(captureResult(9)));
    expect((await second.started).revision).toBe(10);
    second.finish(response({ ...captureResult(10), files: [] }));
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
    first.finish(response(captureResult(9)));
    expect((await second.started).revision).toBe(10);
    second.finish(response({ ...captureResult(10), files: [] }));
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
    expect(harness.storage.put).toHaveBeenCalledTimes(1);
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
    second.finish(response(captureResult(10)));
    expect((await third.started).revision).toBe(11);
    third.finish(response(captureResult(11)));
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
    held.finish(response(captureResult(9)));
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    held.finish(response(captureResult(9)));
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
    held.finish(response(captureResult(9)));
    await expect(pending).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    first.finish(response(captureResult(9)));
    expect(await trailing.started).toEqual({ revision: 10, baseRef: replaced.baseRef });
    expect(harness.storage.put).not.toHaveBeenCalled();
    trailing.finish(
      response({
        ...captureResult(10),
        comparison: { ...captureResult(10).comparison, baseRef: replaced.baseRef },
      })
    );
    await expect(refreshed).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: 10, comparison: { baseRef: replaced.baseRef } },
    });
    expect(harness.storage.put).toHaveBeenCalledTimes(1);
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
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    held.finish(response(captureResult(9)));
    await expect(refreshed).resolves.toEqual({ status: 'failed', snapshot: oldSnapshot });
    await Promise.all(harness.background);
    expect(harness.requestCapture).toHaveBeenCalledTimes(1);
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    ['wrong revision', response(captureResult(10))],
    [
      'wrong comparison',
      response({
        ...captureResult(9),
        comparison: { ...captureResult(9).comparison, baseRef: 'HEAD' },
      }),
    ],
    [
      'oversized file list',
      response({
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
      expect(harness.storage.put).not.toHaveBeenCalled();
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
    harness.storage.put.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'failed',
      snapshot: oldSnapshot,
    });
    expect(harness.values.get(WORKTREE_CHANGES_KEY)).toEqual(oldSnapshot);
  });

  it('returns offline without capture when context is unavailable', async () => {
    const harness = setup();
    harness.readContext.mockResolvedValue(null);
    await expect(harness.changes.refresh()).resolves.toEqual({
      status: 'offline',
      snapshot: oldSnapshot,
    });
    expect(harness.requestCapture).not.toHaveBeenCalled();
    expect(harness.storage.put).not.toHaveBeenCalled();
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
    expect(harness.storage.put).not.toHaveBeenCalled();
  });

  it('replaces old files with a valid empty capture and resumes revisions from persisted data', async () => {
    const harness = setup();
    harness.requestCapture.mockImplementation(async (_context, payload) =>
      response({ ...captureResult(payload.revision), files: [] })
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
