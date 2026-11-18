import { describe, expect, it } from 'vitest';
import {
  createWorktreeChanges,
  WORKTREE_CHANGES_KEY,
  WORKTREE_FILE_PREFIX,
} from './worktree-changes.js';
import { MAX_WORKTREE_CHANGES_BYTES } from '../shared/worktree-changes-wire.js';

function fixture(patches: string[]) {
  const values = new Map<string, unknown>();
  const files = patches.map((patch, index) => {
    const path = `file-${index}.txt`;
    values.set(`${WORKTREE_FILE_PREFIX}${path}`, {
      schemaVersion: 1,
      revision: 1,
      path,
      diff: { status: 'available', patch },
      content: { status: 'available', source: 'current', text: 'saved' },
    });
    return {
      path,
      status: 'modified',
      additions: 1,
      deletions: 1,
      tracked: true,
      binary: false,
      countsComplete: true,
      revision: 1,
    };
  });
  values.set(WORKTREE_CHANGES_KEY, {
    schemaVersion: 2,
    revision: 1,
    capturedAt: new Date().toISOString(),
    comparison: {
      baseRef: 'refs/remotes/origin/main',
      mergeBase: 'a'.repeat(40),
      head: 'b'.repeat(40),
    },
    files,
    truncated: false,
  });
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
    readContext: async () => null,
    requestCapture: async () => ({
      ok: false,
      code: 'not_ready',
      message: 'offline',
      retryable: true,
    }),
    waitUntil: () => undefined,
  });
  return { manager, values };
}

describe('saved worktree recovery transport', () => {
  it('retains stored records while preparing and ignores mismatched file revisions', () => {
    const { manager, values } = fixture(['saved patch', 'stale patch']);
    values.set(`${WORKTREE_FILE_PREFIX}file-1.txt`, {
      schemaVersion: 1,
      revision: 2,
      path: 'file-1.txt',
      diff: { status: 'available', patch: 'stale patch' },
      content: { status: 'unavailable', reason: 'capture_failed' },
    });
    manager.beginPreparation();
    expect(manager.recovery()).toEqual({
      files: [
        { path: 'file-0.txt', status: 'modified', patch: 'saved patch' },
        { path: 'file-1.txt', status: 'modified' },
      ],
    });
    expect(values.size).toBe(3);
  });

  it('bounds transport size without dropping paths for omitted patches', () => {
    const { manager } = fixture(['x'.repeat(200_000), 'y'.repeat(200_000)]);
    const recovery = manager.recovery();
    expect(recovery?.files).toHaveLength(2);
    expect(recovery?.files[0].patch).toHaveLength(200_000);
    expect(recovery?.files[1].patch).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(recovery)).byteLength).toBeLessThanOrEqual(
      MAX_WORKTREE_CHANGES_BYTES
    );
  });
});
