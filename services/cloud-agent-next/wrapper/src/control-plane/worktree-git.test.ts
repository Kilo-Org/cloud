import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import type {
  ControlPlaneWorktreeGitFrame,
  WorktreeBranchOperationResult,
} from '../../../src/shared/worktree-git-operations.js';
import { createControlPlaneWorktreeGit } from './worktree-git.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kilo-worktree-adapter-'));
  roots.push(root);
  return root;
}

function frame(
  directory: string,
  operation: 'sync' | 'restack' = 'sync'
): ControlPlaneWorktreeGitFrame {
  return {
    type: 'worktree.git',
    requestId: 'req-1',
    session: { sessionId: 'session_1', kiloSessionId: 'kilo_1', directory },
    payload: { operation },
  };
}

function result(): WorktreeBranchOperationResult {
  return {
    status: 'changed',
    operation: 'sync',
    branch: 'feature',
    baseBranch: null,
    baseSha: null,
    previousRemoteSha: null,
    remoteSha: null,
    headSha: 'a'.repeat(40),
  };
}

describe('control-plane worktree.git adapter', () => {
  it('refuses a native or sibling turn without running a rewrite', async () => {
    const dir = await directory();
    const frames: ControlPlaneWrapperFrame[] = [];
    let syncs = 0;
    let resumed = 0;
    const adapter = createControlPlaneWorktreeGit({
      emit: emitted => frames.push(emitted),
      isPrepared: () => true,
      gitContext: () => ({ directory: dir, env: { PATH: process.env.PATH } }),
      hasActiveTurnInDirectory: () => true,
      resumeDirectory: () => {
        resumed += 1;
      },
      runSync: async () => {
        syncs += 1;
        return result();
      },
      runRestack: async () => {
        syncs += 1;
        return result();
      },
    });

    await adapter.handle(frame(dir));

    expect(syncs).toBe(0);
    expect(resumed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'worktree.result',
      requestId: 'req-1',
      ok: true,
      result: { status: 'refused', operation: 'sync', reason: 'turn_running' },
    });
  });

  it('serializes same-directory operations and resumes prompt admission once', async () => {
    const dir = await directory();
    const frames: ControlPlaneWrapperFrame[] = [];
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    let resumed = 0;
    const adapter = createControlPlaneWorktreeGit({
      emit: emitted => frames.push(emitted),
      isPrepared: () => true,
      gitContext: () => ({ directory: dir, env: { PATH: process.env.PATH } }),
      hasActiveTurnInDirectory: () => false,
      resumeDirectory: () => {
        resumed += 1;
      },
      runSync: async () => {
        events.push('first');
        await gate.promise;
        return result();
      },
      runRestack: async () => {
        events.push('second');
        return result();
      },
    });

    const first = adapter.handle(frame(dir));
    const second = adapter.handle(frame(dir, 'restack'));

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(['first']);
    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first', 'second']);
    expect(resumed).toBe(1);
    expect(frames).toHaveLength(2);
    expect(frames.every(emitted => emitted.type === 'worktree.result' && emitted.ok)).toBe(true);
  });

  it('rejects a request for an unprepared route', async () => {
    const frames: ControlPlaneWrapperFrame[] = [];
    let syncs = 0;
    const adapter = createControlPlaneWorktreeGit({
      emit: emitted => frames.push(emitted),
      isPrepared: () => false,
      gitContext: () => null,
      hasActiveTurnInDirectory: () => false,
      runSync: async () => {
        syncs += 1;
        return result();
      },
    });

    await adapter.handle(frame('/tmp'));

    expect(syncs).toBe(0);
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-1',
        ok: false,
        error: {
          code: 'not_ready',
          message: 'Session directory is not attached',
          retryable: false,
        },
      },
    ]);
  });
});
