import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertProtectedDataAvailable,
  isProtectedDataAvailable,
  ProtectedDataUnavailableError,
  setProtectedDataAvailable,
  whenProtectedDataAvailable,
  whenProtectedDataAvailableWithin,
} from '@/lib/protected-data';

afterEach(() => {
  setProtectedDataAvailable(true);
});

describe('protected data gate', () => {
  it('is available until a native source reports a lock', () => {
    expect(isProtectedDataAvailable()).toBe(true);
    expect(() => {
      assertProtectedDataAvailable();
    }).not.toThrow();
  });

  it('throws the typed error while the device is locked', () => {
    setProtectedDataAvailable(false);

    expect(isProtectedDataAvailable()).toBe(false);
    expect(() => {
      assertProtectedDataAvailable();
    }).toThrow(ProtectedDataUnavailableError);
  });

  it('resolves a wait at once while available', async () => {
    await expect(whenProtectedDataAvailable()).resolves.toBeUndefined();
  });

  it('holds every wait until unlock, then releases them all', async () => {
    setProtectedDataAvailable(false);
    const released: number[] = [];
    const waitFor = async (id: number): Promise<void> => {
      await whenProtectedDataAvailable();
      released.push(id);
    };
    const first = waitFor(1);
    const second = waitFor(2);

    // A repeated lock report keeps the waits pending.
    setProtectedDataAvailable(false);
    await Promise.resolve();
    expect(released).toEqual([]);

    setProtectedDataAvailable(true);
    await Promise.all([first, second]);
    expect(released).toEqual([1, 2]);
  });

  it('resolves a bounded wait on unlock before its deadline and leaves no timer', async () => {
    vi.useFakeTimers();
    try {
      setProtectedDataAvailable(false);
      const wait = whenProtectedDataAvailableWithin(60_000);
      await vi.advanceTimersByTimeAsync(1_000);
      setProtectedDataAvailable(true);
      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a bounded wait at its deadline and leaves no timer or waiter behind', async () => {
    vi.useFakeTimers();
    try {
      setProtectedDataAvailable(false);
      const wait = whenProtectedDataAvailableWithin(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      // A later unlock has nothing left to release: the deadline already
      // removed this wait from the waiter set.
      setProtectedDataAvailable(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
