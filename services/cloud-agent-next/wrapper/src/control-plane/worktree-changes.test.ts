import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import type {
  SessionGitSummaryPayload,
  SessionGitSummaryResult,
  WorktreeSnapshotCapture,
} from '../../../src/shared/worktree-changes-wire.js';
import {
  createControlPlaneWorktreeChanges,
  type ControlPlaneWorktreeChangesDeps,
} from './worktree-changes.js';
import { WorktreeGitError } from '../control/worktree-git-operations.js';

const session = {
  sessionId: 'workspace_x',
  kiloSessionId: 'kilo_x',
  directory: '/workspace/x',
};

const SUMMARY = {
  revision: 1,
  comparison: { baseRef: 'main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
  files: [],
  truncated: false,
};
const SNAPSHOT = { summary: SUMMARY, files: [] } as unknown as WorktreeSnapshotCapture;

function harness(
  overrides: Partial<
    Pick<
      ControlPlaneWorktreeChangesDeps,
      'captureSnapshot' | 'captureChanges' | 'isPrepared' | 'gitContext' | 'refreshRemotes'
    >
  > = {}
) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const adapter = createControlPlaneWorktreeChanges({
    emit: frame => frames.push(frame),
    isPrepared: () => true,
    ...overrides,
  });
  return { adapter, frames };
}

describe('control-plane wrapper worktree changes', () => {
  it('refuses a capture for a route that is not prepared', async () => {
    let captured = 0;
    const { adapter, frames } = harness({
      isPrepared: () => false,
      captureSnapshot: async () => {
        captured += 1;
        return SNAPSHOT;
      },
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-guard',
      session,
      payload: { revision: 1 },
    });

    expect(captured).toBe(0);
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-guard',
        ok: false,
        error: {
          code: 'not_ready',
          message: 'Session directory is not attached',
          retryable: false,
        },
      },
    ]);
  });

  it('runs a full snapshot and emits its validated result', async () => {
    const calls: [string, SessionGitSummaryPayload][] = [];
    const { adapter, frames } = harness({
      captureSnapshot: async (directory, payload) => {
        calls.push([directory, payload]);
        return SNAPSHOT;
      },
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-1',
      session,
      payload: { revision: 1 },
    });

    expect(calls).toEqual([['/workspace/x', { revision: 1 }]]);
    expect(frames).toEqual([
      { type: 'worktree.result', requestId: 'req-1', ok: true, result: SNAPSHOT },
    ]);
  });

  it('runs a summary capture', async () => {
    const { adapter, frames } = harness({
      captureChanges: async () => ({ ...SUMMARY, revision: 2 }) as SessionGitSummaryResult,
    });

    await adapter.handle({
      type: 'worktree.summary',
      requestId: 'req-2',
      session,
      payload: { revision: 2 },
    });

    expect(frames).toMatchObject([{ type: 'worktree.result', requestId: 'req-2', ok: true }]);
  });

  it('rejects a result whose revision does not match the request', async () => {
    const { adapter, frames } = harness({
      captureSnapshot: async () => SNAPSHOT,
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-stale',
      session,
      payload: { revision: 99 },
    });

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-stale',
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid worktree result', retryable: false },
      },
    ]);
  });

  it('reports a retryable capture failure', async () => {
    const { adapter, frames } = harness({
      captureSnapshot: async () => {
        throw new Error('git failed');
      },
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-3',
      session,
      payload: { revision: 1 },
    });

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-3',
        ok: false,
        error: { code: 'capture_failed', message: 'git failed', retryable: true },
      },
    ]);
  });

  it('refreshes the base with the prepared environment and adds its fallback', async () => {
    const calls: Array<{
      payload: SessionGitSummaryPayload;
      environment: unknown;
    }> = [];
    const { adapter, frames } = harness({
      gitContext: () => ({ directory: '/workspace/x', env: { HOME: '/home/x' } }),
      refreshRemotes: async (_executor, request) => ({
        request: { ...request, baseRef: 'refs/remotes/origin/main' },
        baseRefFallback: {
          requested: 'refs/remotes/origin/gone',
          used: 'refs/remotes/origin/main',
        },
      }),
      captureSnapshot: async (_directory, payload, environment) => {
        calls.push({ payload, environment });
        return {
          summary: {
            ...SUMMARY,
            comparison: { ...SUMMARY.comparison, baseRef: 'refs/remotes/origin/main' },
          },
          files: [],
        };
      },
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-refresh',
      session,
      payload: { revision: 1, baseRef: 'refs/remotes/origin/gone' },
    });

    expect(calls[0]?.payload.baseRef).toBe('refs/remotes/origin/main');
    expect(calls[0]?.environment).toEqual({ env: { HOME: '/home/x' } });
    expect(frames).toMatchObject([
      {
        type: 'worktree.result',
        requestId: 'req-refresh',
        ok: true,
        result: {
          summary: {
            comparison: {
              baseRef: 'refs/remotes/origin/main',
              baseRefFallback: {
                requested: 'refs/remotes/origin/gone',
                used: 'refs/remotes/origin/main',
              },
            },
          },
        },
      },
    ]);
  });

  it('reports a retryable error instead of capturing when the refresh fetch fails', async () => {
    let captured = 0;
    const { adapter, frames } = harness({
      gitContext: () => ({ directory: '/workspace/x', env: { HOME: '/home/x' } }),
      refreshRemotes: async () => {
        throw new WorktreeGitError('fetch failed', 'git_network_failed', true);
      },
      captureSnapshot: async () => {
        captured += 1;
        return SNAPSHOT;
      },
    });

    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req-network',
      session,
      payload: { revision: 1 },
    });

    expect(captured).toBe(0);
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-network',
        ok: false,
        error: { code: 'git_network_failed', message: 'fetch failed', retryable: true },
      },
    ]);
  });
});
