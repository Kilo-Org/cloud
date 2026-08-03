import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withProcessLockAsync } from './process-lock';

test('serializes async work on the same lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-process-lock-'));
  const events: string[] = [];
  try {
    const first = withProcessLockAsync(path.join(root, 'lock'), 'test lock', async () => {
      events.push('first:start');
      await new Promise(resolve => setTimeout(resolve, 50));
      events.push('first:end');
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = withProcessLockAsync(
      path.join(root, 'lock'),
      'test lock',
      async () => {
        events.push('second');
      },
      1000
    );
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('throws when the lock is held and no wait timeout is given', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-process-lock-'));
  const lockPath = path.join(root, 'lock');
  try {
    await withProcessLockAsync(lockPath, 'test lock', async () => {
      let contentionError: Error | undefined;
      try {
        await withProcessLockAsync(lockPath, 'test lock', async () => {});
      } catch (error) {
        contentionError = error instanceof Error ? error : new Error(String(error));
      }
      assert.ok(contentionError, 'contending lock acquisition must fail');
      assert.match(contentionError.message, /locked by another live process/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
