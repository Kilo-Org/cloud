import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LANGUAGE_RETURN_TARGET_KEY } from '@/lib/storage-keys';

import { readLanguageReturnTarget, writeLanguageReturnTarget } from './return-target';

/**
 * The one-shot return target, and the disarm that follows its read.
 *
 * What is worth proving is that a launch acts on the marker once: the target
 * read from the keychain is returned whatever the disarm does, a refused delete
 * still leaves a marker no later launch can act on, and only a keychain that
 * refuses both the delete and the overwrite can leave the target behind.
 */

const stored = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failingDeletes: 0,
  failingWrites: 0,
}));

vi.mock('@/lib/auth/secure-store', () => ({
  getItemAsync: async (key: string) => {
    await Promise.resolve();
    return stored.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    await Promise.resolve();
    if (stored.failingWrites > 0) {
      stored.failingWrites -= 1;
      throw new Error('keychain unavailable');
    }
    stored.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    await Promise.resolve();
    if (stored.failingDeletes > 0) {
      stored.failingDeletes -= 1;
      throw new Error('keychain unavailable');
    }
    stored.values.delete(key);
  },
}));

// The total helpers this module disarms through. They are the wrapper's own
// `*Safe` pair, so the fake keeps their policy: report nothing, return false.
vi.mock('@/lib/auth/secure-store-value', () => ({
  deleteStoredValueSafe: async (key: string) => {
    await Promise.resolve();
    if (stored.failingDeletes > 0) {
      stored.failingDeletes -= 1;
      return false;
    }
    stored.values.delete(key);
    return true;
  },
  writeStoredValueSafe: async (key: string, value: string) => {
    await Promise.resolve();
    if (stored.failingWrites > 0) {
      stored.failingWrites -= 1;
      return false;
    }
    stored.values.set(key, value);
    return true;
  },
}));

beforeEach(() => {
  stored.values.clear();
  stored.failingDeletes = 0;
  stored.failingWrites = 0;
});

describe('a stored return target', () => {
  it('reopens the screen once and leaves no marker behind', async () => {
    await writeLanguageReturnTarget('login');

    await expect(readLanguageReturnTarget()).resolves.toBe('login');
    expect(stored.values.has(LANGUAGE_RETURN_TARGET_KEY)).toBe(false);
    await expect(readLanguageReturnTarget()).resolves.toBeNull();
  });

  it('is still returned when the keychain refuses the delete, and disarms the marker anyway', async () => {
    await writeLanguageReturnTarget('profile');
    stored.failingDeletes = 1;

    await expect(readLanguageReturnTarget()).resolves.toBe('profile');
    await expect(readLanguageReturnTarget()).resolves.toBeNull();
  });

  it('is returned without rejecting when both the delete and the overwrite are refused', async () => {
    await writeLanguageReturnTarget('preferences');
    stored.failingDeletes = 1;
    stored.failingWrites = 1;

    await expect(readLanguageReturnTarget()).resolves.toBe('preferences');
    expect(stored.values.get(LANGUAGE_RETURN_TARGET_KEY)).toBe('preferences');
  });

  it('reads as no target when the stored value names no screen, and is consumed all the same', async () => {
    stored.values.set(LANGUAGE_RETURN_TARGET_KEY, 'a-screen-that-was-renamed');

    await expect(readLanguageReturnTarget()).resolves.toBeNull();
    expect(stored.values.has(LANGUAGE_RETURN_TARGET_KEY)).toBe(false);
    await expect(readLanguageReturnTarget()).resolves.toBeNull();
  });

  it('reads as no target when the keychain holds nothing', async () => {
    await expect(readLanguageReturnTarget()).resolves.toBeNull();
  });
});
