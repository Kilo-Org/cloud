import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SecureStorePreferenceModule from './secure-store-preference';

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

const { setColorScheme, notifySchemeCounts } = vi.hoisted(() => ({
  setColorScheme: vi.fn(),
  notifySchemeCounts: [] as number[],
}));
vi.mock('react-native', () => ({ Appearance: { setColorScheme } }));

// The theme module builds its store at import time. Wrap the shipped factory so
// the test sees the order of the Appearance write and the store notification.
vi.mock('./secure-store-preference', async importOriginal => {
  const actual = await importOriginal<typeof SecureStorePreferenceModule>();
  return {
    ...actual,
    createSecureStorePreference: (
      options: Parameters<typeof actual.createSecureStorePreference>[0]
    ) => {
      const store = actual.createSecureStorePreference(options);
      return {
        ...store,
        // Record how many Appearance writes had run when the notification
        // fires. A notification that runs before Appearance moves records 0.
        set: (next: unknown): void => {
          notifySchemeCounts.push(setColorScheme.mock.calls.length);
          store.set(next);
        },
      };
    },
  };
});

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('colorSchemeForPreference', () => {
  it("returns null for 'system' so Appearance falls back to the OS scheme", async () => {
    const { colorSchemeForPreference } = await import('./use-theme-preference');
    expect(colorSchemeForPreference('system')).toBeNull();
  });

  it("returns 'light' for 'light' and 'dark' for 'dark'", async () => {
    const { colorSchemeForPreference } = await import('./use-theme-preference');
    expect(colorSchemeForPreference('light')).toBe('light');
    expect(colorSchemeForPreference('dark')).toBe('dark');
  });
});

// The theme module builds its store when it loads, so every case imports it
// after vi.resetModules() to read the shipped configuration and wiring with a
// fresh store. A static import would share one store across cases.
describe('useThemePreference store', () => {
  beforeEach(() => {
    vi.resetModules();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
    setColorScheme.mockReset();
    notifySchemeCounts.length = 0;
  });

  it("defaults to 'system' when SecureStore returns null", async () => {
    getItemAsync.mockResolvedValue(null);
    const { getThemePreference, preloadThemePreference } = await import('./use-theme-preference');

    preloadThemePreference();
    await vi.waitFor(() => {
      expect(getItemAsync).toHaveBeenCalledWith('theme-preference');
    });
    await flushMicrotasks();

    expect(getThemePreference()).toBe('system');
  });

  it("falls back to 'system' for an unrecognized stored value", async () => {
    getItemAsync.mockResolvedValue('high-contrast');
    const { getThemePreference, preloadThemePreference } = await import('./use-theme-preference');

    preloadThemePreference();
    await vi.waitFor(() => {
      expect(getItemAsync).toHaveBeenCalledWith('theme-preference');
    });
    await flushMicrotasks();

    expect(getThemePreference()).toBe('system');
  });

  it("loads a persisted 'light' value through the preload", async () => {
    getItemAsync.mockResolvedValue('light');
    const { getThemePreference, preloadThemePreference } = await import('./use-theme-preference');

    // Before the read settles the store shows its default.
    expect(getThemePreference()).toBe('system');

    preloadThemePreference();
    await vi.waitFor(() => {
      expect(getThemePreference()).toBe('light');
    });
  });

  it('setThemePreference persists the serialized value and applies the mapped scheme synchronously', async () => {
    const { setThemePreference } = await import('./use-theme-preference');

    setThemePreference('dark');
    expect(setColorScheme).toHaveBeenCalledWith('dark');
    // Appearance must move before the store notification: a subscriber that
    // mounts from that notification would otherwise see useColorScheme update
    // mid-mount (LogBox over the tab bar). The wrapper mock records 0 here when
    // the store notified first.
    expect(notifySchemeCounts[0]).toBeGreaterThan(0);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'dark');

    setThemePreference('light');
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'light');
    expect(setColorScheme).toHaveBeenCalledWith('light');

    setThemePreference('system');
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'system');
    expect(setColorScheme).toHaveBeenCalledWith('unspecified');
  });
});
