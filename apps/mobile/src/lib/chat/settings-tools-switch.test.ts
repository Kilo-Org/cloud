import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_TOOLS_ENABLED_KEY } from '@/lib/storage-keys';

import {
  clearSettingsToolsEnabled,
  isSettingsToolsEnabled,
  setSettingsToolsEnabled,
  subscribeSettingsToolsEnabled,
} from './settings-tools-switch';

// A fake disk behind the expo-secure-store mock. A test waits on the persisted
// value it holds, so no test waits a fixed number of event-loop turns.
const secureStore = vi.hoisted(() => {
  const disk = new Map<string, string>();

  return {
    disk,
    getItemAsync: vi.fn((key: string) => Promise.resolve(disk.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      disk.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      disk.delete(key);
      return Promise.resolve();
    }),
  };
});
vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
  deleteItemAsync: secureStore.deleteItemAsync,
}));

const { disk } = secureStore;

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

beforeEach(() => {
  disk.clear();
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
  secureStore.deleteItemAsync.mockClear();
  captureException.mockClear();
  toastError.mockClear();
  // The clear below queues a delete for the key, and the per-key save chain
  // keeps writes FIFO, so every write a test makes lands after that delete.
  clearSettingsToolsEnabled();
});

describe('settings tools group switch', () => {
  it('is on by default', () => {
    expect(isSettingsToolsEnabled()).toBe(true);
  });

  it('writes a change to the account-scoped key', async () => {
    setSettingsToolsEnabled(false);

    expect(isSettingsToolsEnabled()).toBe(false);

    await vi.waitFor(() => {
      expect(disk.get(SETTINGS_TOOLS_ENABLED_KEY)).toBe('false');
    });
    expect(secureStore.setItemAsync).toHaveBeenLastCalledWith(SETTINGS_TOOLS_ENABLED_KEY, 'false');
  });

  it('notifies subscribers once the change is stored', async () => {
    const seen: (string | undefined)[] = [];
    const listener = vi.fn<() => void>(() => {
      seen.push(disk.get(SETTINGS_TOOLS_ENABLED_KEY));
    });
    const unsubscribe = subscribeSettingsToolsEnabled(listener);

    setSettingsToolsEnabled(false);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });
    // The listener ran after the write landed, so the app never shows the new
    // choice while the disk still holds the old one.
    expect(seen).toEqual(['false']);

    unsubscribe();
    setSettingsToolsEnabled(true);
    await vi.waitFor(() => {
      expect(disk.get(SETTINGS_TOOLS_ENABLED_KEY)).toBe('true');
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resets to the default on clear', async () => {
    setSettingsToolsEnabled(false);
    // Wait for this write before the clear. The beforeEach delete runs first in
    // the per-key chain, so the key is present only once this test's write
    // lands, and only the clear that follows can remove it.
    await vi.waitFor(() => {
      expect(disk.get(SETTINGS_TOOLS_ENABLED_KEY)).toBe('false');
    });

    clearSettingsToolsEnabled();

    expect(isSettingsToolsEnabled()).toBe(true);

    await vi.waitFor(() => {
      expect(disk.has(SETTINGS_TOOLS_ENABLED_KEY)).toBe(false);
    });
  });
});
