import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as SecureStore from 'expo-secure-store';

import {
  _resetPendingExternalAuthForTests,
  clearPendingExternalAuth,
  PENDING_EXTERNAL_AUTH_TTL_MS,
  readPendingExternalAuth,
  writePendingExternalAuth,
} from '@/lib/auth/pending-external-auth';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

const record = {
  deviceCode: 'device-secret',
  userCode: 'UC-1234',
  verificationUrl: 'https://example.com/device-auth?code=UC-1234',
  startedAt: Date.now(),
};

beforeEach(() => {
  vi.mocked(SecureStore.getItemAsync).mockReset();
  vi.mocked(SecureStore.setItemAsync).mockReset();
  vi.mocked(SecureStore.deleteItemAsync).mockReset();
  _resetPendingExternalAuthForTests();
});

describe('pending-external-auth', () => {
  it('round-trips a live record through SecureStore', async () => {
    await writePendingExternalAuth(record);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'pending-external-auth',
      JSON.stringify(record)
    );

    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(record));
    await expect(readPendingExternalAuth()).resolves.toEqual({ kind: 'valid', record });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns none for an absent record without deleting', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await expect(readPendingExternalAuth()).resolves.toEqual({ kind: 'none' });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns stale for a record past the TTL without deleting', async () => {
    const expired = { ...record, startedAt: Date.now() - PENDING_EXTERNAL_AUTH_TTL_MS - 1000 };
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(expired));
    await expect(readPendingExternalAuth()).resolves.toEqual({ kind: 'stale' });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns stale for a record that fails to parse without deleting', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('not-json');
    await expect(readPendingExternalAuth()).resolves.toEqual({ kind: 'stale' });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('returns stale for a record with a wrong shape without deleting', async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify({ deviceCode: 'x' }));
    await expect(readPendingExternalAuth()).resolves.toEqual({ kind: 'stale' });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('clears the record', async () => {
    await clearPendingExternalAuth();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('pending-external-auth');
  });

  it('serializes a write then a clear in FIFO order', async () => {
    const setGate = deferred();
    vi.mocked(SecureStore.setItemAsync).mockReturnValue(setGate.promise);

    const writePromise = writePendingExternalAuth(record);
    const clearPromise = clearPendingExternalAuth();

    // Wait until the write op has started and is held open.
    await vi.waitFor(() => {
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });
    // The clear is chained behind the held write — it must not land first.
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    setGate.resolve();
    await writePromise;
    await clearPromise;

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolveFn?.();
    },
  };
}
