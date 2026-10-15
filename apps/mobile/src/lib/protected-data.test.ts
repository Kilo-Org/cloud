import { afterEach, describe, expect, it } from 'vitest';

import {
  assertProtectedDataAvailable,
  isProtectedDataAvailable,
  ProtectedDataUnavailableError,
  setProtectedDataAvailable,
  whenProtectedDataAvailable,
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
});
