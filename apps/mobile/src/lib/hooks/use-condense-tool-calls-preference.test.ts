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
      key: 'condense-tool-calls',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    })
  );
}

describe('parseCondenseToolCalls', () => {
  it('defaults to off for a missing value (fresh install and unreadable read)', async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls(null)).toBe(false);
  });

  it("reads 'true' as on", async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('true')).toBe(true);
  });

  it("reads 'false' as off", async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('false')).toBe(false);
  });

  it('treats any other stored string as off', async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('')).toBe(false);
    expect(parseCondenseToolCalls('nonsense')).toBe(false);
  });
});

describe('condense-tool-calls store', () => {
  beforeEach(() => {
    vi.resetModules();
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

  it("reads the stored string 'true' as on", async () => {
    getItemAsync.mockResolvedValue('true');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    unsubscribe();
  });

  it('setCondenseToolCalls persists true and false under condense-tool-calls', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setCondenseToolCalls } = await import('./use-condense-tool-calls-preference');

    setCondenseToolCalls(true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('condense-tool-calls', 'true');

    setCondenseToolCalls(false);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith('condense-tool-calls', 'false');
  });

  it('clearCondenseToolCallsPreference deletes the key', async () => {
    getItemAsync.mockResolvedValue(null);
    const { clearCondenseToolCallsPreference } =
      await import('./use-condense-tool-calls-preference');

    clearCondenseToolCallsPreference();
    await flushMicrotasks();

    expect(deleteItemAsync).toHaveBeenCalledWith('condense-tool-calls');
  });

  it('clear() resets the in-memory value to off and deletes the key', async () => {
    getItemAsync.mockResolvedValue('true');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();
    expect(store.get()).toBe(true);

    store.clear();
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    expect(deleteItemAsync).toHaveBeenCalledWith('condense-tool-calls');
    unsubscribe();
  });

  it('keeps the in-memory value and toasts common.couldNotSaveSetting when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const store = await makeStore();

    store.set(true);
    expect(store.get()).toBe(true);

    await flushMicrotasks();

    expect(toastError).toHaveBeenCalledWith('Could not save setting');
    expect(store.get()).toBe(true);
  });

  it('toasts common.couldNotSaveSetting when the real preference write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const { setCondenseToolCalls } = await import('./use-condense-tool-calls-preference');

    setCondenseToolCalls(true);
    await flushMicrotasks();

    expect(toastError).toHaveBeenCalledWith('Could not save setting');
  });
});
