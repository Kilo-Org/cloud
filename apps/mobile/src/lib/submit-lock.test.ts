import { describe, expect, it } from 'vitest';

import { createSubmitLock } from '@/lib/submit-lock';

describe('createSubmitLock', () => {
  it('reports not locked initially, locked after acquire, and not locked after release', () => {
    const lock = createSubmitLock();
    expect(lock.isLocked()).toBe(false);
    lock.acquire();
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('acquires on first call and rejects a second synchronous acquire', () => {
    const lock = createSubmitLock();
    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(false);
  });

  it('releases so the next acquire succeeds', () => {
    const lock = createSubmitLock();
    expect(lock.acquire()).toBe(true);
    lock.release();
    expect(lock.acquire()).toBe(true);
  });

  it('blocks a concurrent async attempt while the first is in flight', async () => {
    const lock = createSubmitLock();
    const outcomes: string[] = [];

    async function attempt(label: string) {
      if (!lock.acquire()) {
        outcomes.push(`${label}:busy`);
        return;
      }
      try {
        outcomes.push(`${label}:acquired`);
        await Promise.resolve();
        await Promise.resolve();
      } finally {
        lock.release();
      }
    }

    await Promise.all([attempt('first'), attempt('second')]);
    expect(outcomes).toEqual(['first:acquired', 'second:busy']);
  });

  it('releases on callback failure so a manual retry can re-acquire', async () => {
    const lock = createSubmitLock();

    async function attemptThatThrows() {
      if (!lock.acquire()) {
        throw new Error('should not be busy');
      }
      try {
        await Promise.resolve();
        throw new Error('boom');
      } finally {
        lock.release();
      }
    }

    await expect(attemptThatThrows()).rejects.toThrow('boom');
    expect(lock.acquire()).toBe(true);
  });
});
