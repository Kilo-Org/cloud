import { afterEach, describe, expect, test } from 'bun:test';
import type {
  ControlPlaneWorktreeDeletionRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import type { WorktreeKiloCleanupClient } from '../control/delete-worktree.js';
import { resetSessionDirectoryState } from '../control/session-directories.js';
import { resetDirectoryOperationState } from '../control/worktree-operations.js';
import {
  createControlPlaneWorktreeDeletion,
  type ControlPlaneWorktreeDeletionDeps,
} from './worktree-deletion.js';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const directory = `/workspace/oauth-user/worktrees/${worktreeId}`;
const sessionId = (index: number) => `ses_${String(index).padStart(26, '0')}`;

function deletionRequest(
  type: 'worktree.prepareDeletion' | 'worktree.delete',
  requestId: string,
  sessionIds: string[] = [sessionId(0)]
): ControlPlaneWorktreeDeletionRequestFrame {
  return { type, requestId, payload: { worktreeId, directory, sessionIds } };
}

afterEach(() => {
  resetDirectoryOperationState();
  resetSessionDirectoryState();
});

function fixture() {
  const sessions = new Map<string, { id: string; directory: string }>();
  const retired: string[] = [];
  const client: WorktreeKiloCleanupClient = {
    listSessionIds: async dir =>
      [...sessions.values()]
        .filter(session => session.directory === dir)
        .map(session => session.id),
    getSession: async (_dir, id) => sessions.get(id) ?? null,
    children: async () => [],
    abortSession: async () => undefined,
    stopSessionProcesses: async () => undefined,
    deleteSession: async (_dir, id) => {
      sessions.delete(id);
    },
    closeTerminals: async () => undefined,
    disposeDirectory: async () => undefined,
  };
  return { sessions, retired, client };
}

function harness(overrides: Partial<ControlPlaneWorktreeDeletionDeps> = {}) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const f = fixture();
  const adapter = createControlPlaneWorktreeDeletion({
    emit: frame => frames.push(frame),
    clients: () => [f.client],
    retireDirectory: async dir => {
      f.retired.push(dir);
    },
    ...overrides,
  });
  return { adapter, frames, fixture: f };
}

describe('control-plane wrapper worktree deletion (R2)', () => {
  test('answers a prepareDeletion with the discovered session manifest', async () => {
    const { adapter, frames, fixture: f } = harness();
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });
    f.sessions.set(sessionId(1), { id: sessionId(1), directory });

    await adapter.handle(deletionRequest('worktree.prepareDeletion', 'req-prep', [sessionId(0)]));

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-prep',
        ok: true,
        result: { prepared: true, sessionIds: [sessionId(0), sessionId(1)] },
      },
    ]);
  });

  test('answers a delete with the confirmed manifest and retires the runtime', async () => {
    const { adapter, frames, fixture: f } = harness();
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });

    await adapter.handle(deletionRequest('worktree.delete', 'req-del'));

    expect(f.retired).toEqual([directory]);
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-del',
        ok: true,
        result: { deleted: true, sessionIds: [sessionId(0)] },
      },
    ]);
  });

  test('suppresses capture around a destructive delete and completes after removal', async () => {
    const events: string[] = [];
    const { adapter, fixture: f } = harness({
      onDeletionBegin: dir => events.push(`begin:${dir}`),
      onDeletionComplete: dir => events.push(`complete:${dir}`),
      onDeletionFailed: dir => events.push(`failed:${dir}`),
    });
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });

    await adapter.handle(deletionRequest('worktree.delete', 'req-hooks'));

    expect(events).toEqual([`begin:${directory}`, `complete:${directory}`]);
  });

  test('does not suppress capture for a non-destructive prepareDeletion', async () => {
    const events: string[] = [];
    const { adapter } = harness({
      onDeletionBegin: () => events.push('begin'),
      onDeletionComplete: () => events.push('complete'),
      onDeletionFailed: () => events.push('failed'),
    });

    await adapter.handle(deletionRequest('worktree.prepareDeletion', 'req-prep-hooks'));

    expect(events).toEqual([]);
  });

  test('resumes capture when a destructive delete fails', async () => {
    const events: string[] = [];
    const { adapter } = harness({
      clients: () => {
        throw new Error('Kilo cleanup is unavailable');
      },
      onDeletionBegin: () => events.push('begin'),
      onDeletionComplete: () => events.push('complete'),
      onDeletionFailed: () => events.push('failed'),
    });

    await adapter.handle(deletionRequest('worktree.delete', 'req-fail-hooks'));

    expect(events).toEqual(['begin', 'failed']);
  });

  test('detaches directory terminals before deleting', async () => {
    const detached: string[] = [];
    const { adapter, fixture: f } = harness({
      detachTerminals: async dir => {
        detached.push(dir);
      },
    });
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });

    await adapter.handle(deletionRequest('worktree.delete', 'req-terms'));

    expect(detached).toEqual([directory]);
  });

  test('reports a failed cleanup as a retryable not_ready result', async () => {
    const { adapter, frames } = harness({
      clients: () => {
        throw new Error('Kilo cleanup is unavailable');
      },
    });

    await adapter.handle(deletionRequest('worktree.delete', 'req-fail'));

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-fail',
        ok: false,
        error: { code: 'not_ready', message: 'Kilo cleanup is unavailable', retryable: true },
      },
    ]);
  });

  test('rejects an invalid worktree directory without touching Kilo', async () => {
    const { adapter, frames } = harness();

    await adapter.handle({
      type: 'worktree.prepareDeletion',
      requestId: 'req-invalid',
      payload: { worktreeId, directory: '/etc', sessionIds: [sessionId(0)] },
    });

    expect(frames).toMatchObject([
      { type: 'worktree.result', requestId: 'req-invalid', ok: false, error: { retryable: true } },
    ]);
  });
});
