import { afterEach, describe, expect, it } from 'bun:test';
import {
  isDirectoryRewriteActive,
  resetDirectoryOperationState,
  runDirectoryRewrite,
} from './worktree-operations.js';

afterEach(() => resetDirectoryOperationState());

describe('per-directory rewrite lock', () => {
  it('serializes rewrites and keeps the directory blocked across the queue', async () => {
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = runDirectoryRewrite('/worktree', async () => {
      events.push('first-start');
      await gate.promise;
      events.push('first-end');
      return 1;
    });
    const second = runDirectoryRewrite('/worktree', async () => {
      events.push('second');
      return 2;
    });

    expect(isDirectoryRewriteActive('/worktree')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['first-start']);

    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
    expect(isDirectoryRewriteActive('/worktree')).toBe(false);
  });

  it('releases the directory when the rewrite fails', async () => {
    const failed = runDirectoryRewrite('/worktree', async () => {
      throw new Error('rewrite failed');
    });

    let failure: unknown;
    try {
      await failed;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(isDirectoryRewriteActive('/worktree')).toBe(false);
  });
});
