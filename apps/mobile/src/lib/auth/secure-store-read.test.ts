import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getItemAsync = vi.hoisted(() =>
  vi.fn<(key: string, options?: unknown) => Promise<string | null>>()
);

vi.mock('expo-secure-store', () => ({
  getItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

// The fault window is off for every case except the one that proves it: the
// constant is read from the bundle-time config, so that case reloads the
// module with its own mock.
vi.mock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 0 }));

/** A read that rejects, built without `Promise.reject` so the promise rule
 *  stays satisfied. */
// eslint-disable-next-line require-await -- an async throw is the rejected promise under test
async function rejectedRead(message: string): Promise<string | null> {
  throw new Error(message);
}

async function loadHelper() {
  const mod = await import('./secure-store-read');
  return mod.readStoredValueWithRetry;
}

describe('readStoredValueWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value on a healthy first read without waiting', async () => {
    getItemAsync.mockResolvedValue('stored-token');
    const readStoredValueWithRetry = await loadHelper();

    await expect(readStoredValueWithRetry('auth-token')).resolves.toBe('stored-token');
    expect(getItemAsync).toHaveBeenCalledTimes(1);
    expect(getItemAsync).toHaveBeenCalledWith('auth-token', undefined);
  });

  it('passes a null resolution straight through and never retries it', async () => {
    getItemAsync.mockResolvedValue(null);
    const readStoredValueWithRetry = await loadHelper();

    await expect(readStoredValueWithRetry('auth-token')).resolves.toBeNull();
    expect(getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('recovers after transient rejections', async () => {
    getItemAsync
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockResolvedValue('stored-token');
    const readStoredValueWithRetry = await loadHelper();

    const read = readStoredValueWithRetry('auth-token');
    await vi.advanceTimersByTimeAsync(2000);

    await expect(read).resolves.toBe('stored-token');
    expect(getItemAsync).toHaveBeenCalledTimes(3);
  });

  it('backs off 250/500/1000 ms and exhausts four attempts before throwing', async () => {
    getItemAsync.mockRejectedValue(new Error('keychain unavailable'));
    const readStoredValueWithRetry = await loadHelper();

    // The assertion is attached before the timers run so the rejection is
    // never momentarily unobserved.
    const settled = expect(readStoredValueWithRetry('auth-token')).rejects.toThrow(
      'keychain unavailable'
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(getItemAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(getItemAsync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(getItemAsync).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getItemAsync).toHaveBeenCalledTimes(4);

    // Four attempts is the whole budget: the last error is the answer.
    await settled;
    await vi.advanceTimersByTimeAsync(5000);
    expect(getItemAsync).toHaveBeenCalledTimes(4);
  });

  it('uses the handed-over first attempt and issues fresh reads for the retries', async () => {
    getItemAsync.mockResolvedValue('fresh-token');
    const readStoredValueWithRetry = await loadHelper();

    await expect(
      readStoredValueWithRetry('auth-token', undefined, Promise.resolve('preloaded-token'))
    ).resolves.toBe('preloaded-token');
    expect(getItemAsync).not.toHaveBeenCalled();
  });

  it('retries a rejected first attempt with a fresh read', async () => {
    getItemAsync.mockResolvedValue('fresh-token');
    const readStoredValueWithRetry = await loadHelper();

    const read = readStoredValueWithRetry(
      'auth-token',
      undefined,
      rejectedRead('keychain unavailable')
    );
    await vi.advanceTimersByTimeAsync(2000);

    await expect(read).resolves.toBe('fresh-token');
    expect(getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('forwards the SecureStore options to every read', async () => {
    getItemAsync.mockRejectedValueOnce(new Error('keychain unavailable')).mockResolvedValue('v');
    const readStoredValueWithRetry = await loadHelper();

    const read = readStoredValueWithRetry('auth-token', {
      keychainService: 'kilo',
    });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(read).resolves.toBe('v');
    expect(getItemAsync).toHaveBeenNthCalledWith(2, 'auth-token', { keychainService: 'kilo' });
  });

  it('rejects every read while the E2E fault window is open', async () => {
    vi.resetModules();
    vi.doMock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 60_000 }));
    getItemAsync.mockResolvedValue('stored-token');
    const readStoredValueWithRetry = await loadHelper();

    const settled = expect(readStoredValueWithRetry('auth-token')).rejects.toThrow(
      'E2E secure-store fault window is open: read of auth-token rejected'
    );
    await vi.advanceTimersByTimeAsync(2000);

    await settled;
    // The fault is the reason: the real store is never asked.
    expect(getItemAsync).not.toHaveBeenCalled();

    vi.doUnmock('@/lib/config');
    vi.resetModules();
  });

  it('reads normally once the E2E fault window has elapsed', async () => {
    vi.resetModules();
    vi.doMock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 1000 }));
    getItemAsync.mockResolvedValue('stored-token');
    const readStoredValueWithRetry = await loadHelper();

    // The window opens at module load; the 250 ms backoff alone is not enough
    // to leave it, the 500 ms one is.
    const read = readStoredValueWithRetry('auth-token');
    await vi.advanceTimersByTimeAsync(2000);

    await expect(read).resolves.toBe('stored-token');

    vi.doUnmock('@/lib/config');
    vi.resetModules();
  });
});
