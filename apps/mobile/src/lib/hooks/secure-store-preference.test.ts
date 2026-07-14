import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecureStorePreference } from './secure-store-preference';

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

describe('createSecureStorePreference', () => {
  beforeEach(() => {
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    captureException.mockReset();
    toastError.mockReset();
  });

  it('logs to Sentry (not a toast) on a read failure and keeps the default value', async () => {
    getItemAsync.mockRejectedValue(new Error('disk error'));
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    expect(store.getHasLoaded()).toBe(true);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(toastError).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('shows a toast on a write failure while keeping the in-memory value', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.set(true);
    expect(store.get()).toBe(true);

    await flushMicrotasks();

    expect(toastError).toHaveBeenCalledWith('Could not save setting');
    expect(store.get()).toBe(true);
  });

  it('lets a set() before the initial load resolves win over the disk value', async () => {
    getItemAsync.mockResolvedValue('true');
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    const unsubscribe = store.subscribe(noopListener);
    store.set(false);
    await flushMicrotasks();

    expect(store.get()).toBe(false);
    unsubscribe();
  });
});
