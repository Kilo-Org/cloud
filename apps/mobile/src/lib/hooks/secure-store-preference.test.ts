import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

import { createSecureStorePreference } from './secure-store-preference';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

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
    toastError.mockReset();
    setTelemetrySink(null);
  });

  it('reports a read failure once and keeps the default value', async () => {
    getItemAsync.mockRejectedValue(new Error('disk error'));
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
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
    // One total read: the failure is reported once by the shared helper, not
    // retried and not captured a second time here.
    expect(getItemAsync).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'read',
    });
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'read']);
    expect(toastError).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('applies the value from a successful read', async () => {
    getItemAsync.mockResolvedValue('true');
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    const unsubscribe = store.subscribe(noopListener);
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    expect(store.getHasLoaded()).toBe(true);
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

  it('keeps the default when clear() runs during an in-flight initial load', async () => {
    const pendingReads: ((raw: string | null) => void)[] = [];
    getItemAsync.mockReturnValue(
      new Promise<string | null>(resolve => {
        pendingReads.push(resolve);
      })
    );
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    const unsubscribe = store.subscribe(noopListener);
    store.clear();
    pendingReads[0]?.('true');
    await flushMicrotasks();

    expect(deleteItemAsync).toHaveBeenCalled();
    expect(store.get()).toBe(false);
    unsubscribe();
  });

  it('preload() starts the disk read once and a following subscribe() does not start a second read', async () => {
    const pendingReads: ((raw: string | null) => void)[] = [];
    getItemAsync.mockReturnValue(
      new Promise<string | null>(resolve => {
        pendingReads.push(resolve);
      })
    );
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.preload();
    // preload() alone must start the read; otherwise this fails and the
    // subscribe() below would be the only thing starting it.
    expect(getItemAsync).toHaveBeenCalledTimes(1);

    const unsubscribe = store.subscribe(noopListener);
    // subscribe() must not start a second read.
    expect(getItemAsync).toHaveBeenCalledTimes(1);

    pendingReads[0]?.('true');
    await flushMicrotasks();

    expect(store.get()).toBe(true);
    unsubscribe();
  });
});
