import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mirrors React Native's Appearance: an app-level override shadows the device
// scheme. React Native keeps two caches: the native `_currentColorScheme`
// (`nativeCache`, returned by NativeAppearance.getColorScheme()) refreshes only
// when the window's trait change is delivered, and the JS `state.appearance`
// (`jsCache`, returned by Appearance.getColorScheme()) is updated synchronously
// for an explicit override and by the async `appearanceChanged` event
// otherwise.
const { setColorScheme, getColorScheme, addChangeListener, appearanceState, listeners } =
  vi.hoisted(() => {
    const changeListeners = new Set<() => void>();
    return {
      appearanceState: {
        device: 'dark' as 'light' | 'dark',
        override: null as 'light' | 'dark' | null,
        nativeCache: 'dark' as 'light' | 'dark',
        jsCache: 'dark' as 'light' | 'dark',
      },
      listeners: changeListeners,
      setColorScheme: vi.fn(),
      getColorScheme: vi.fn(),
      addChangeListener: vi.fn((listener: () => void) => {
        changeListeners.add(listener);
        return {
          remove: () => {
            changeListeners.delete(listener);
          },
        };
      }),
    };
  });
vi.mock('react-native', () => ({
  Appearance: { setColorScheme, getColorScheme, addChangeListener },
}));

const { setCssColorScheme } = vi.hoisted(() => ({ setCssColorScheme: vi.fn() }));
vi.mock('react-native-css', () => ({
  colorScheme: { get: vi.fn(), set: setCssColorScheme },
}));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

/**
 * Runs the republish to completion: advances past the re-assert/clear spacing,
 * then flushes the native `appearanceChanged` event the clear triggers.
 */
async function settleRepublish(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
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
    // Only fake the timer used to space the re-assert from the clear; the
    // native `appearanceChanged` delivery stays a real setImmediate so
    // flushMicrotasks still exercises the async event.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
    setCssColorScheme.mockReset();
    getColorScheme.mockReset();
    setColorScheme.mockReset();
    addChangeListener.mockClear();
    listeners.clear();
    appearanceState.device = 'dark';
    appearanceState.override = null;
    appearanceState.nativeCache = 'dark';
    appearanceState.jsCache = 'dark';
    getColorScheme.mockImplementation(() => appearanceState.jsCache);
    setColorScheme.mockImplementation((scheme: 'light' | 'dark' | 'unspecified') => {
      const before = appearanceState.override ?? appearanceState.device;
      if (scheme === 'unspecified') {
        appearanceState.override = null;
        // React Native reads the native scheme synchronously, which on iOS is
        // still the stale `_currentColorScheme` until the trait change lands.
        appearanceState.jsCache = appearanceState.nativeCache;
      } else {
        appearanceState.override = scheme;
        appearanceState.jsCache = scheme;
      }
      if ((appearanceState.override ?? appearanceState.device) === before) {
        return;
      }
      // The window trait changed; the native module reports it to JS on a later
      // turn, refreshing the native cache before notifying listeners.
      setImmediate(() => {
        const next = appearanceState.override ?? appearanceState.device;
        if (appearanceState.nativeCache === next) {
          return;
        }
        appearanceState.nativeCache = next;
        appearanceState.jsCache = next;
        for (const listener of listeners) {
          listener();
        }
      });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'dark');
    expect(setColorScheme).toHaveBeenCalledWith('dark');
    expect(setCssColorScheme).toHaveBeenLastCalledWith('dark');

    setThemePreference('light');
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'light');
    expect(setColorScheme).toHaveBeenCalledWith('light');
    expect(setCssColorScheme).toHaveBeenLastCalledWith('light');

    setThemePreference('system');
    await flushMicrotasks();
    await settleRepublish();
    expect(setItemAsync).toHaveBeenCalledWith('theme-preference', 'system');
    expect(setColorScheme).toHaveBeenCalledWith('unspecified');
    expect(setCssColorScheme).toHaveBeenLastCalledWith('dark');
  });

  it("switching to 'system' follows the device, not the override it replaces", async () => {
    getItemAsync.mockResolvedValue(null);
    const { setThemePreference } = await import('./use-theme-preference');

    setThemePreference('light');
    await flushMicrotasks();
    expect(setCssColorScheme).toHaveBeenLastCalledWith('light');

    setThemePreference('system');
    await flushMicrotasks();
    await settleRepublish();
    expect(setColorScheme).toHaveBeenLastCalledWith('unspecified');
    expect(setCssColorScheme).toHaveBeenLastCalledWith('dark');
  });

  it('refreshes a stale scheme cache so system follows the device dark mode', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setThemePreference } = await import('./use-theme-preference');

    // Reset the module's tracked override, then model iOS caching 'light'
    // before the device's dark style reaches the window: clearing an already
    // unset override emits no trait-change event, so nothing would republish
    // the device scheme without the re-assert.
    setThemePreference('system');
    await flushMicrotasks();
    appearanceState.device = 'dark';
    appearanceState.override = null;
    appearanceState.nativeCache = 'light';
    appearanceState.jsCache = 'light';
    setColorScheme.mockClear();
    setCssColorScheme.mockClear();

    setThemePreference('system');
    await settleRepublish();

    expect(setColorScheme).toHaveBeenCalledWith('light');
    expect(setColorScheme).toHaveBeenLastCalledWith('unspecified');
    // The republish hands the real device scheme back to Appearance, and the
    // change listener paints react-native-css from that settled scheme rather
    // than the stale light cache, so the next layout pass is already dark.
    expect(getColorScheme()).toBe('dark');
    expect(setCssColorScheme).toHaveBeenLastCalledWith('dark');
  });

  it('never paints the stale device-cache scheme while the republish settles', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setThemePreference } = await import('./use-theme-preference');

    setThemePreference('system');
    await flushMicrotasks();

    // The device turned dark but the JS Appearance cache still holds light.
    appearanceState.device = 'dark';
    appearanceState.override = null;
    appearanceState.nativeCache = 'light';
    appearanceState.jsCache = 'light';
    setCssColorScheme.mockClear();

    setThemePreference('system');

    // Before the trait-change event is delivered, react-native-css must not
    // receive the stale light: that is the paint that ignored the device dark
    // mode. The settled dark arrives after the event below.
    expect(setCssColorScheme).not.toHaveBeenCalled();

    await settleRepublish();
    expect(setCssColorScheme).toHaveBeenCalledTimes(1);
    expect(setCssColorScheme).toHaveBeenLastCalledWith('dark');
  });
});

describe('resolveColorScheme', () => {
  it('returns the explicit preference for light and dark', async () => {
    const { resolveColorScheme } = await import('./use-theme-preference');
    expect(resolveColorScheme('light', 'dark')).toBe('light');
    expect(resolveColorScheme('dark', 'light')).toBe('dark');
  });

  it('follows the device for system', async () => {
    const { resolveColorScheme } = await import('./use-theme-preference');
    expect(resolveColorScheme('system', 'dark')).toBe('dark');
    expect(resolveColorScheme('system', 'light')).toBe('light');
  });

  it('returns null while the device scheme is unknown', async () => {
    const { resolveColorScheme } = await import('./use-theme-preference');
    expect(resolveColorScheme('system', null)).toBeNull();
    expect(resolveColorScheme('system', undefined)).toBeNull();
    expect(resolveColorScheme('system', 'unspecified')).toBeNull();
  });
});
