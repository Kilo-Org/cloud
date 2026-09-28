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

/** Holds a SecureStore read open until the test body releases it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

async function makeStore() {
  // Re-import lazily so the mock wiring above is in effect, and read the real
  // parse function so the store cases exercise the shipped contract.
  const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
  const { createSecureStorePreference } = await import('./secure-store-preference');
  return createSecureStorePreference<string[]>({
    key: 'collapsed-connect-ctas',
    defaultValue: [],
    parse: parseCollapsedConnectCtas,
    serialize: value => JSON.stringify(value),
    mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
  });
}

describe('parseCollapsedConnectCtas', () => {
  it('defaults to nothing collapsed for a missing value (fresh install and unreadable read)', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas(null)).toEqual([]);
  });

  it('reads a stored platform list', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('["github"]')).toEqual(['github']);
  });

  it('reads an empty stored list as nothing collapsed', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('[]')).toEqual([]);
  });

  it('drops a malformed stored value', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('not json')).toEqual([]);
  });

  it('drops a stored value that is not an array', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('{"github":true}')).toEqual([]);
  });

  it('drops unknown platforms and de-duplicates the rest, keeping input order', async () => {
    const { parseCollapsedConnectCtas } = await import('./use-collapsed-connect-ctas-preference');
    expect(parseCollapsedConnectCtas('["gitlab","gitlab","sourcehut"]')).toEqual(['gitlab']);
  });
});

describe('collapsed-connect-ctas store', () => {
  beforeEach(() => {
    vi.resetModules();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('reports the stored platforms and hasLoaded only once the read settles', async () => {
    getItemAsync.mockResolvedValue('["github"]');
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    expect(store.getHasLoaded()).toBe(false);
    await flushMicrotasks();

    expect(store.get()).toEqual(['github']);
    expect(store.getHasLoaded()).toBe(true);
    unsubscribe();
  });

  it('persists each collapse and expand as the exact serialized list', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setConnectCtaCollapsed } = await import('./use-collapsed-connect-ctas-preference');

    setConnectCtaCollapsed('github', true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github"]');

    setConnectCtaCollapsed('gitlab', true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github","gitlab"]');

    setConnectCtaCollapsed('github', false);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["gitlab"]');
  });

  it('merges a pending write with the persisted list the read returns', async () => {
    const readGate = deferred();
    getItemAsync.mockImplementation(async () => {
      await readGate.promise;
      return '["github"]';
    });
    const store = await makeStore();

    const unsubscribe = store.subscribe(noopListener);
    // The write races the initial disk read: both platforms must survive.
    store.set(['gitlab']);

    readGate.resolve();
    await flushMicrotasks();

    expect(store.get()).toEqual(['github', 'gitlab']);
    unsubscribe();
  });

  it('keeps the in-memory value and toasts Could not save setting when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const { setConnectCtaCollapsed } = await import('./use-collapsed-connect-ctas-preference');

    setConnectCtaCollapsed('github', true);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(toastError).toHaveBeenCalledWith('Could not save setting');
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '["github"]');

    // The failed write still changed the session value: un-collapsing it now
    // builds the empty list instead of returning early on unchanged membership.
    setItemAsync.mockClear();
    setConnectCtaCollapsed('github', false);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('collapsed-connect-ctas', '[]');
  });

  it('clearCollapsedConnectCtasPreference deletes the key', async () => {
    getItemAsync.mockResolvedValue(null);
    const { clearCollapsedConnectCtasPreference } =
      await import('./use-collapsed-connect-ctas-preference');

    clearCollapsedConnectCtasPreference();
    await flushMicrotasks();

    expect(deleteItemAsync).toHaveBeenCalledWith('collapsed-connect-ctas');
  });
});
