import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecureStorePreference } from './secure-store-preference';

// The persist-then-apply write path and its sign-out fence. The sibling suite
// covers the queued `set()` path and the initial load; this one drives one
// persist-then-apply write against a clear() that lands mid-flight.

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// The retrying read imports @/lib/config, whose real module needs the app's
// baked build `extra` and cannot load under Vitest. The stub answers the whole
// surface, so every value reads as unset and the read never retries.
const configStub = vi.hoisted(() => new Proxy({}, { get: () => undefined, has: () => true }));
vi.mock('@/lib/config', () => configStub);

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

function booleanStore() {
  return createSecureStorePreference<boolean>({
    key: 'k',
    defaultValue: false,
    parse: raw => raw === 'true',
    serialize: value => (value ? 'true' : 'false'),
  });
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  toastError.mockReset();
});

describe('createSecureStorePreference setAsync', () => {
  it('leaves the cleared value in place when clear() runs during its write', async () => {
    getItemAsync.mockResolvedValue(null);
    const writeGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementation(async () => {
      await writeGate.promise;
    });
    const store = booleanStore();

    const applying = store.setAsync(true);
    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledTimes(1);

    store.clear();
    writeGate.resolve(undefined);

    // The write landed, but clear() reset the preference while it was on its
    // way to disk, so the choice is not applied and the caller learns it.
    await expect(applying).resolves.toBe(false);
    expect(store.get()).toBe(false);
    expect(store.getRequested()).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('skips the disk write when clear() runs while it waits for a pending write', async () => {
    getItemAsync.mockResolvedValue(null);
    const firstWriteGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementationOnce(async () => {
      await firstWriteGate.promise;
    });
    const store = booleanStore();

    store.set(true);
    const applying = store.setAsync(false);
    store.clear();
    firstWriteGate.resolve(undefined);

    await expect(applying).resolves.toBe(false);
    // Only the superseded set() reached disk; the choice that waited behind it
    // belongs to the account the clear() reset.
    expect(setItemAsync).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(false);
  });

  it('does not toast when a clear superseded a write that then failed', async () => {
    getItemAsync.mockResolvedValue(null);
    const writeGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementation(async () => {
      await writeGate.promise;
      throw new Error('disk full');
    });
    const store = booleanStore();

    const applying = store.setAsync(true);
    await flushMicrotasks();
    store.clear();
    writeGate.resolve(undefined);

    // The reset explains the lost value, so the save-failure toast would blame
    // a write the sign-out already discarded.
    await expect(applying).resolves.toBe(false);
    expect(toastError).not.toHaveBeenCalled();
    expect(store.get()).toBe(false);
  });

  it('keeps its choice when a merge-on-load reconcile repaints the store', async () => {
    const pendingRead = Promise.withResolvers<string | null>();
    getItemAsync.mockReturnValueOnce(pendingRead.promise).mockResolvedValue(null);
    const store = createSecureStorePreference<string[]>({
      key: 'k',
      defaultValue: [],
      parse: raw => (raw ? (JSON.parse(raw) as string[]) : []),
      serialize: value => JSON.stringify(value),
      mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
    });

    const unsubscribe = store.subscribe(() => undefined);
    // A choice made before the read resolves, then a persist-then-apply write
    // that must survive the reconcile: a reconcile repaints the value but is
    // not the reset that discards a choice.
    store.set(['local']);
    const applying = store.setAsync(['next']);
    pendingRead.resolve('["disk"]');

    await expect(applying).resolves.toBe(true);
    expect(store.get()).toEqual(['next']);
    unsubscribe();
  });
});
