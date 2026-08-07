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

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// eslint-disable-next-line no-empty-function -- listener body is irrelevant, only subscribe()'s side effect (starting the load) is under test
function noopListener(): void {}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function makeStore() {
  // Re-import lazily so the mock wiring above is in effect.
  return import('./secure-store-preference').then(({ createSecureStorePreference }) =>
    createSecureStorePreference<boolean>({
      key: 'keep-session-screen-on',
      defaultValue: true,
      parse: raw => raw !== 'false',
      serialize: value => (value ? 'true' : 'false'),
    })
  );
}

describe('parseKeepScreenOn', () => {
  it('defaults to on for a missing value (fresh install and unreadable read)', async () => {
    const { parseKeepScreenOn } = await import('./use-keep-screen-on-preference');
    expect(parseKeepScreenOn(null)).toBe(true);
  });

  it("reads 'true' as on", async () => {
    const { parseKeepScreenOn } = await import('./use-keep-screen-on-preference');
    expect(parseKeepScreenOn('true')).toBe(true);
  });

  it("reads 'false' as off — the only value that turns the preference off", async () => {
    const { parseKeepScreenOn } = await import('./use-keep-screen-on-preference');
    expect(parseKeepScreenOn('false')).toBe(false);
  });

  it('treats any other stored string as on', async () => {
    const { parseKeepScreenOn } = await import('./use-keep-screen-on-preference');
    expect(parseKeepScreenOn('')).toBe(true);
    expect(parseKeepScreenOn('nonsense')).toBe(true);
  });
});

describe('keep-screen-on store', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('defaults to on when SecureStore returns null', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it("turns off only for the stored string 'false'", async () => {
    getItemAsync.mockResolvedValue('false');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it('persists a set value and clears back to the default on sign-out', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    store.set(false);
    expect(setItemAsync).toHaveBeenCalledWith('keep-session-screen-on', 'false');

    store.set(true);
    expect(setItemAsync).toHaveBeenCalledWith('keep-session-screen-on', 'true');

    store.clear();
    expect(deleteItemAsync).toHaveBeenCalledWith('keep-session-screen-on');
    expect(store.get()).toBe(true);
  });
});
