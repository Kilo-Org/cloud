import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setWidgetStoreDefaultClassForTests,
  WIDGET_STORE_UNLOCK_CANARY,
} from '@/lib/auth/secure-store-gated';
import { LIVE_ACTIVITY_KEY } from '@/lib/storage-keys';

import { readStoredLiveActivityEnabled } from './live-activity-preference-store';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

// The refusal iOS answers for a default-class write while the device is locked
// (`errSecInteractionNotAllowed`); its fixed message is what marks it.
const REFUSED =
  "Calling the 'setValueWithKeyAsync' function has failed: User interaction is not allowed.";

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  // A keychain that answers: a read returns what is stored and a write lands.
  getItemAsync.mockImplementation(async (key: string) => {
    await Promise.resolve();
    return stored.get(key) ?? null;
  });
  setItemAsync.mockImplementation(async (key: string, value: string) => {
    await Promise.resolve();
    stored.set(key, value);
  });
  deleteItemAsync.mockImplementation(async (key: string) => {
    await Promise.resolve();
    stored.delete(key);
  });
  // The canary resolves the native module lazily, which Node cannot load, so
  // the suite hands the same fake store to that path.
  _setWidgetStoreDefaultClassForTests({ getItemAsync, setItemAsync });
});

afterEach(() => {
  _setWidgetStoreDefaultClassForTests(null);
});

describe('stored Live Activity preference read', () => {
  it("reads the stored string 'false' as off without asking the keychain to prove itself", async () => {
    stored.set(LIVE_ACTIVITY_KEY, 'false');

    await expect(readStoredLiveActivityEnabled()).resolves.toBe(false);
    expect(getItemAsync).toHaveBeenCalledWith(LIVE_ACTIVITY_KEY);
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it('reads an absent key as the shipped default on when the canary write lands', async () => {
    await expect(readStoredLiveActivityEnabled()).resolves.toBe(true);
    expect(setItemAsync).toHaveBeenCalledWith(
      WIDGET_STORE_UNLOCK_CANARY.key,
      WIDGET_STORE_UNLOCK_CANARY.value
    );
  });

  it('leaves the preference unknown when the read is null and the keychain refuses a write', async () => {
    setItemAsync.mockImplementation(async () => {
      await Promise.resolve();
      throw new Error(REFUSED);
    });

    // A locked keychain answers `null` for an item it will not hand over, so
    // the shipped default on is not consent: the answer is "no answer".
    await expect(readStoredLiveActivityEnabled()).resolves.toBeNull();
  });

  it('retries a spoofed null before reading the stored switch', async () => {
    vi.useFakeTimers();
    try {
      // Two nulls, then the real value: the retry budget must not accept the
      // first null as an absence even though the canary write would land.
      getItemAsync
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue('false');

      const read = readStoredLiveActivityEnabled();
      await vi.advanceTimersByTimeAsync(2000);

      await expect(read).resolves.toBe(false);
      expect(getItemAsync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the preference unknown when every read attempt rejects', async () => {
    getItemAsync.mockRejectedValue(new Error(REFUSED));

    await expect(readStoredLiveActivityEnabled()).resolves.toBeNull();
    expect(getItemAsync).toHaveBeenCalledTimes(4);
    expect(setItemAsync).not.toHaveBeenCalled();
  });
});
