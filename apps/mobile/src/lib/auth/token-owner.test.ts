import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

/* eslint-disable import/first */
import * as SecureStore from 'expo-secure-store';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';
import { bumpAuthEpoch } from './auth-epoch';
import {
  clearActiveToken,
  type ActiveTokenSnapshot,
  getActiveToken,
  getActiveTokenSnapshot,
  getAuthTokenForRequest,
  publishActiveTokenExpiry,
  setActiveToken,
  setSignOutTeardownActive,
} from './token-owner';
/* eslint-enable import/first */

function currentSnapshot(): ActiveTokenSnapshot {
  const snapshot = getActiveTokenSnapshot();
  if (!snapshot) {
    throw new Error('expected an active token snapshot');
  }
  return snapshot;
}

describe('token-owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    clearActiveToken();
    setSignOutTeardownActive(false);
  });

  it('returns null when no token is held', () => {
    expect(getActiveToken()).toBeNull();
  });

  it('returns the held token and expiry while the epoch is current', () => {
    setActiveToken('token-a', 1234);
    expect(getActiveToken()).toEqual({ token: 'token-a', expiresAtMs: 1234 });
  });

  it('returns null when the epoch moved after setActiveToken', () => {
    setActiveToken('token-a', 1234);
    bumpAuthEpoch();
    expect(getActiveToken()).toBeNull();
  });

  it('clearActiveToken clears the held token', () => {
    setActiveToken('token-a', 1234);
    clearActiveToken();
    expect(getActiveToken()).toBeNull();
  });

  describe('getAuthTokenForRequest', () => {
    it('returns the in-memory token with zero SecureStore reads on a fresh hit', async () => {
      setActiveToken('mem-token', 1234);
      await expect(getAuthTokenForRequest()).resolves.toBe('mem-token');
      expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    });

    it('returns null when nothing is stored', async () => {
      await expect(getAuthTokenForRequest()).resolves.toBeNull();
    });

    it('reads SecureStore once on the cold path and returns the stored token', async () => {
      store.set(AUTH_TOKEN_KEY, 'stored-token');
      await expect(getAuthTokenForRequest()).resolves.toBe('stored-token');
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
    });

    it('warms the owner on a cold read so the next read is in-memory', async () => {
      store.set(AUTH_TOKEN_KEY, 'stored-token');
      await getAuthTokenForRequest();
      expect(getActiveToken()).toEqual({ token: 'stored-token', expiresAtMs: null });

      await getAuthTokenForRequest();
      // One SecureStore read for the first (cold) call, none for the warm hit.
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
    });

    it('does not warm the owner when the epoch changes mid-read', async () => {
      store.set(AUTH_TOKEN_KEY, 'stored-token');
      const pending = getAuthTokenForRequest();
      bumpAuthEpoch();
      await expect(pending).resolves.toBe('stored-token');
      expect(getActiveToken()).toBeNull();
    });

    it('returns a newer owner published while the cold read was in flight and keeps it', async () => {
      store.set(AUTH_TOKEN_KEY, 'stale-stored');
      let releaseRead = undefined as (() => void) | undefined;
      const readGate = new Promise<void>(resolve => {
        releaseRead = resolve;
      });
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async () => {
        await readGate;
        await Promise.resolve();
        return store.get(AUTH_TOKEN_KEY) ?? null;
      });

      const pending = getAuthTokenForRequest();
      // Publish a newer owner while the cold read is held open, then release
      // the read so it resolves with the stale stored token.
      setActiveToken('newer-token', 9999);
      releaseRead?.();

      await expect(pending).resolves.toBe('newer-token');
      // The stale read did not overwrite the newer owner or erase its expiry.
      expect(getActiveToken()).toEqual({ token: 'newer-token', expiresAtMs: 9999 });
    });

    it('keeps serving the in-memory token during sign-out teardown (remote cleanup auth)', async () => {
      setActiveToken('mem-token', 1234);
      setSignOutTeardownActive(true);
      await expect(getAuthTokenForRequest()).resolves.toBe('mem-token');
      expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    });

    it('returns no token and does not warm the owner when sign-out teardown is active', async () => {
      store.set(AUTH_TOKEN_KEY, 'stored-token');
      setSignOutTeardownActive(true);

      await expect(getAuthTokenForRequest()).resolves.toBeNull();
      // The cold read never rewarmed the owner from credentials that are
      // scheduled for deletion.
      expect(getActiveToken()).toBeNull();
    });

    it('returns no token and does not warm the owner when sign-out teardown starts mid-read', async () => {
      store.set(AUTH_TOKEN_KEY, 'stored-token');
      let releaseRead = undefined as (() => void) | undefined;
      const readGate = new Promise<void>(resolve => {
        releaseRead = resolve;
      });
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async () => {
        await readGate;
        await Promise.resolve();
        return store.get(AUTH_TOKEN_KEY) ?? null;
      });

      const pending = getAuthTokenForRequest();
      // Sign-out begins while the cold read is in flight (the epoch has not
      // bumped yet, so only the teardown guard can stop the warm).
      setSignOutTeardownActive(true);
      releaseRead?.();

      await expect(pending).resolves.toBeNull();
      expect(getActiveToken()).toBeNull();
    });
  });

  describe('publishActiveTokenExpiry', () => {
    it('stores the resolved expiry in the current owner', () => {
      setActiveToken('token-a', null);
      publishActiveTokenExpiry(currentSnapshot(), 1234);
      expect(getActiveToken()).toEqual({ token: 'token-a', expiresAtMs: 1234 });
    });

    it('does not overwrite a newer owner that holds a different token', () => {
      setActiveToken('token-a', null);
      const snapshot = currentSnapshot();
      setActiveToken('token-b', 5678);
      publishActiveTokenExpiry(snapshot, 1234);
      expect(getActiveToken()).toEqual({ token: 'token-b', expiresAtMs: 5678 });
    });

    it('does nothing when no owner is held', () => {
      publishActiveTokenExpiry({ token: 'token-a', expiresAtMs: null, epoch: 0 }, 1234);
      expect(getActiveToken()).toBeNull();
    });

    it('does nothing when the epoch moved', () => {
      setActiveToken('token-a', null);
      const snapshot = currentSnapshot();
      bumpAuthEpoch();
      publishActiveTokenExpiry(snapshot, 1234);
      expect(getActiveToken()).toBeNull();
    });
  });
});
