import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSettingsToolsEnabled,
  isSettingsToolsEnabled,
  setSettingsToolsEnabled,
  subscribeSettingsToolsEnabled,
} from './settings-tools-switch';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  captureException.mockReset();
  toastError.mockReset();
  clearSettingsToolsEnabled();
});

describe('settings tools group switch', () => {
  it('is on by default', () => {
    expect(isSettingsToolsEnabled()).toBe(true);
  });

  it('writes a change to the account-scoped key', async () => {
    setSettingsToolsEnabled(false);

    expect(isSettingsToolsEnabled()).toBe(false);

    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('settings-tools-enabled', 'false');
  });

  it('notifies subscribers when the switch flips', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeSettingsToolsEnabled(listener);

    setSettingsToolsEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setSettingsToolsEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resets to the default on clear', async () => {
    setSettingsToolsEnabled(false);
    await flushMicrotasks();

    clearSettingsToolsEnabled();

    expect(isSettingsToolsEnabled()).toBe(true);

    await flushMicrotasks();
    expect(deleteItemAsync).toHaveBeenCalledWith('settings-tools-enabled');
  });
});
