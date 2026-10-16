import { describe, expect, it } from 'vitest';
import {
  worktreeFileIdentity,
  type WorktreeChangesFile,
  type WorktreeFileRecord,
  type WorktreeRecovery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  createWorktreeChanges,
  WORKTREE_CHANGES_KEY,
  WORKTREE_FILE_PREFIX,
  WORKTREE_RECOVERY_KEY,
  type WorktreeChangesContext,
} from './worktree-changes.js';

const context: WorktreeChangesContext = {
  session: { sessionId: 'workspace_test', kiloSessionId: 'kilo_test', directory: '/app' },
  ownerId: 'user_test',
  sandboxId: 'sandbox_test',
  provider: 'cloudflare',
  repository: { type: 'github', source: 'test/repo' },
  baseRef: 'refs/remotes/origin/main',
};
const comparison = { baseRef: context.baseRef, head: 'b'.repeat(40), mergeBase: 'a'.repeat(40) };

function file(scope?: WorktreeChangesFile['scope'], path = 'same.txt'): WorktreeChangesFile {
  return {
    path,
    ...(scope === undefined ? {} : { scope }),
    status: 'modified',
    additions: 1,
    deletions: 1,
    tracked: true,
    binary: false,
    countsComplete: true,
  };
}

function record(summary: WorktreeChangesFile, revision: number, text: string): WorktreeFileRecord {
  return {
    schemaVersion: 1,
    revision,
    path: summary.path,
    ...(summary.scope === undefined ? {} : { scope: summary.scope }),
    diff: { status: 'available', patch: text },
    content: { status: 'available', source: 'current', text },
  };
}

function fixture() {
  const values = new Map<string, unknown>();
  let summaries = [file('uncommitted'), file('against-base-branch')];
  let texts = ['working', 'committed'];
  let invalidRecords = false;
  let recovery: WorktreeRecovery | undefined;
  const manager = createWorktreeChanges({
    storage: {
      kv: {
        get: key => values.get(key),
        put: (key, value) => {
          values.set(key, value);
        },
        delete: key => values.delete(key),
        list: ({ prefix }) => [...values].filter(([key]) => key.startsWith(prefix)),
      },
      transactionSync: callback => callback(),
    },
    readContext: async () => context,
    requestCapture: async (_context, { revision }) => ({
      ok: true,
      result: {
        summary: { revision, comparison, files: summaries, truncated: false },
        files: summaries.map((summary, index) =>
          record(invalidRecords ? file(undefined, summary.path) : summary, revision, texts[index])
        ),
        ...(recovery === undefined ? {} : { recovery }),
      },
    }),
    waitUntil: () => undefined,
  });
  return {
    manager,
    values,
    setRecovery: (next: WorktreeRecovery | undefined) => {
      recovery = next;
    },
    update: (files: WorktreeChangesFile[], content: string[], invalid = false) => {
      summaries = files;
      texts = content;
      invalidRecords = invalid;
    },
  };
}

describe('scoped worktree snapshot persistence', () => {
  it('persists and reads each scope independently and reuses only its unchanged revision', async () => {
    const { manager, values, update } = fixture();
    const initial = await manager.refresh();
    expect(initial.status).toBe('refreshed');
    expect(initial.snapshot?.files.map(file => file.revision)).toEqual([1, 1]);
    expect(values.size).toBe(3);
    for (const [scope, text] of [
      ['uncommitted', 'working'],
      ['against-base-branch', 'committed'],
    ] as const) {
      expect(manager.getFile({ path: 'same.txt', scope, expectedRevision: 1 })).toMatchObject({
        status: 'available',
        file: { scope, content: { text } },
      });
    }
    expect(manager.getFile({ path: 'same.txt', expectedRevision: 1 })).toEqual({
      status: 'no_longer_listed',
      currentRevision: 1,
    });
    update([file('uncommitted'), file('against-base-branch')], ['changed working', 'committed']);
    const refreshed = await manager.refresh();
    expect(refreshed.snapshot?.files.map(file => file.revision)).toEqual([2, 1]);
    expect(
      manager.getFile({ path: 'same.txt', scope: 'uncommitted', expectedRevision: 1 })
    ).toEqual({
      status: 'stale',
      currentRevision: 2,
    });
    expect(
      manager.getFile({ path: 'same.txt', scope: 'against-base-branch', expectedRevision: 1 })
        .status
    ).toBe('available');
    update([file('against-base-branch')], ['committed']);
    await manager.refresh();
    expect(
      manager.getFile({ path: 'same.txt', scope: 'uncommitted', expectedRevision: 2 })
    ).toEqual({
      status: 'no_longer_listed',
      currentRevision: 3,
    });
    expect(values.has(`${WORKTREE_FILE_PREFIX}${worktreeFileIdentity(file('uncommitted'))}`)).toBe(
      false
    );
    expect(values.size).toBe(2);
  });

  it('retains absent-scope records without falling back for an explicit scoped read or reusing their revision', async () => {
    const { manager, values, update } = fixture();
    update([file()], ['combined']);
    await manager.refresh();
    expect(values.has(`${WORKTREE_FILE_PREFIX}same.txt`)).toBe(true);
    expect(manager.getFile({ path: 'same.txt', expectedRevision: 1 }).status).toBe('available');
    for (const scope of ['uncommitted', 'against-base-branch']) {
      expect(manager.getFile({ path: 'same.txt', scope, expectedRevision: 1 })).toEqual({
        status: 'no_longer_listed',
        currentRevision: 1,
      });
    }
    update([file('uncommitted')], ['combined']);
    const refreshed = await manager.refresh();
    expect(refreshed.snapshot?.files[0].revision).toBe(2);
    expect(values.has(`${WORKTREE_FILE_PREFIX}same.txt`)).toBe(false);
  });

  it('rejects a stored record with a mismatched scope even at the requested path and revision', async () => {
    const { manager, values } = fixture();
    await manager.refresh();
    values.set(
      `${WORKTREE_FILE_PREFIX}${worktreeFileIdentity(file('uncommitted'))}`,
      record(file(), 1, 'combined')
    );
    expect(
      manager.getFile({ path: 'same.txt', scope: 'uncommitted', expectedRevision: 1 })
    ).toEqual({
      status: 'not_captured',
    });
  });

  it('rejects duplicate scoped summaries and mismatched captures without replacing the saved snapshot', async () => {
    const { manager, values, update } = fixture();
    const initial = await manager.refresh();
    const previous = new Map(values);
    update([file('uncommitted'), file('uncommitted')], ['first', 'second']);
    expect(await manager.refresh()).toEqual({ status: 'failed', snapshot: initial.snapshot });
    expect(values).toEqual(previous);
    update([file('uncommitted')], ['first'], true);
    expect(await manager.refresh()).toEqual({ status: 'failed', snapshot: initial.snapshot });
    expect(values).toEqual(previous);
  });

  it('does not derive partial layered recovery from scoped snapshots without net recovery', async () => {
    const { manager } = fixture();
    await manager.refresh();
    expect(manager.recovery()).toBeUndefined();
  });

  it('persists bounded net recovery independently from display records and binds it to the saved revision', async () => {
    const { manager, values, setRecovery } = fixture();
    const recovery: WorktreeRecovery = {
      files: [{ path: 'same.txt', status: 'modified', patch: 'A to C'.repeat(20_000) }],
    };
    setRecovery(recovery);
    await manager.refresh();
    expect(manager.recovery()).toEqual(recovery);
    expect(values.get(WORKTREE_RECOVERY_KEY)).toEqual({ revision: 1, recovery });
    values.set(WORKTREE_RECOVERY_KEY, { revision: 2, recovery });
    expect(manager.recovery()).toBeUndefined();
    await manager.refresh();
    expect(manager.recovery()).toEqual(recovery);
    setRecovery(undefined);
    await manager.refresh();
    expect(values.has(WORKTREE_RECOVERY_KEY)).toBe(false);
    expect(manager.recovery()).toBeUndefined();
  });

  it('returns no recovery for cancelling edits with an empty saved net so remote checkout still uses ingest fallback', async () => {
    const { manager, values, setRecovery } = fixture();
    setRecovery({ files: [] });
    await manager.refresh();
    expect((await manager.get()).snapshot?.files).toHaveLength(2);
    expect(values.get(WORKTREE_RECOVERY_KEY)).toEqual({ revision: 1, recovery: { files: [] } });
    expect(manager.recovery()).toBeUndefined();
  });

  it('retains net recovery after a failed capture and deletes it when purged', async () => {
    const { manager, values, setRecovery, update } = fixture();
    const recovery: WorktreeRecovery = {
      files: [{ path: 'same.txt', status: 'modified', patch: 'net' }],
    };
    setRecovery(recovery);
    await manager.refresh();
    update([file('uncommitted')], ['invalid'], true);
    expect((await manager.refresh()).status).toBe('failed');
    expect(manager.recovery()).toEqual(recovery);
    manager.purge();
    expect(values.size).toBe(0);
  });

  it('cannot collide scoped storage keys with legal legacy file paths', async () => {
    const { manager, values, update } = fixture();
    const scoped = file('uncommitted');
    const legacy = file(undefined, 'uncommitted:same.txt');
    update([scoped, legacy], ['scoped', 'legacy']);
    await manager.refresh();
    expect(values.size).toBe(3);
    expect(manager.getFile({ path: legacy.path, expectedRevision: 1 })).toMatchObject({
      file: { content: { text: 'legacy' } },
    });
    expect(
      manager.getFile({ path: scoped.path, scope: scoped.scope, expectedRevision: 1 })
    ).toMatchObject({ file: { content: { text: 'scoped' } } });
    expect(values.has(WORKTREE_CHANGES_KEY)).toBe(true);
  });
});
