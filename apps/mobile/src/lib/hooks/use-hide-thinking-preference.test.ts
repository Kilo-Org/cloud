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
      key: 'agent-hide-thinking-details',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    })
  );
}

describe('parseHideThinking', () => {
  it('defaults to off for a missing value (fresh install and unreadable read)', async () => {
    const { parseHideThinking } = await import('./use-hide-thinking-preference');
    expect(parseHideThinking(null)).toBe(false);
  });

  it("reads 'true' as on — the only value that turns the preference on", async () => {
    const { parseHideThinking } = await import('./use-hide-thinking-preference');
    expect(parseHideThinking('true')).toBe(true);
  });

  it("reads 'false' as off", async () => {
    const { parseHideThinking } = await import('./use-hide-thinking-preference');
    expect(parseHideThinking('false')).toBe(false);
  });

  it('treats any other stored string as off', async () => {
    const { parseHideThinking } = await import('./use-hide-thinking-preference');
    expect(parseHideThinking('')).toBe(false);
    expect(parseHideThinking('nonsense')).toBe(false);
  });
});

describe('hide-thinking store', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('defaults to off when SecureStore returns null', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it("turns on only for the stored string 'true'", async () => {
    getItemAsync.mockResolvedValue('true');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it('persists a set value and clears back to the default on sign-out', async () => {
    getItemAsync.mockResolvedValue(null);
    const store = await makeStore();

    store.set(true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('agent-hide-thinking-details', 'true');

    store.set(false);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('agent-hide-thinking-details', 'false');

    store.clear();
    await flushMicrotasks();
    expect(deleteItemAsync).toHaveBeenCalledWith('agent-hide-thinking-details');
    expect(store.get()).toBe(false);
  });
});
