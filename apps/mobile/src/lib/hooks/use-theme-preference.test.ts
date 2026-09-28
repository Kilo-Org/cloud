import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { setColorScheme } = vi.hoisted(() => ({ setColorScheme: vi.fn() }));
vi.mock('react-native', () => ({ Appearance: { setColorScheme } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// eslint-disable-next-line no-empty-function -- listener body is irrelevant, only subscribe()'s side effect (starting the load) is under test
function noopListener(): void {}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function makeThemeStore() {
  // Re-import lazily so the mock wiring above is in effect.
  return import('./secure-store-preference').then(({ createSecureStorePreference }) =>
    createSecureStorePreference<'system' | 'light' | 'dark'>({
      key: 'theme-preference',
      defaultValue: 'system',
      parse: raw => {
        if (raw === 'light' || raw === 'dark' || raw === 'system') {
          return raw;
        }
        return 'system';
      },
      serialize: value => value,
    })
  );
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

describe('useThemePreference store', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
    setColorScheme.mockReset();
  });

  it("defaults to 'system' when SecureStore returns null", async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeThemeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe('system');
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it("falls back to 'system' for an unrecognized stored value", async () => {
    getItemAsync.mockResolvedValue('high-contrast');
    const store = await makeThemeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe('system');
    unsubscribe();
  });

  it('persists a persisted value on subscribe and reflects it via get() after the load resolves', async () => {
    getItemAsync.mockResolvedValue('light');
    const store = await makeThemeStore();

    expect(store.get()).toBe('system');
    expect(store.getHasLoaded()).toBe(false);

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe('light');
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it('setThemePreference persists the serialized value and applies the mapped scheme synchronously', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setThemePreference } = await import('./use-theme-preference');

    setThemePreference('dark');
    // Appearance must move before the store emit: a subscriber that mounts
    // from that emit would otherwise see useColorScheme update mid-mount
    // (LogBox over the tab bar).
    expect(setColorScheme).toHaveBeenCalledWith('dark');
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'dark');
    const appearanceAt = setColorScheme.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const persistAt = setItemAsync.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(appearanceAt).toBeLessThan(persistAt);

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
