/* oxlint-disable max-lines -- one suite for the SecureStore-backed preference store: the initial read, the write drain, and what a failed read reports all drive the same mocked keychain */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSecureStorePreference } from './secure-store-preference';
import {
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';

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

// The retrying read imports @/lib/config, whose real module needs the app's
// baked build `extra` and cannot load under Vitest. Vitest also rejects a mock
// factory that omits an export the importer reads, so this stub answers the
// whole surface: every value reads as unset, which keeps the retry helper's
// fault window closed and leaves the failure to the SecureStore mock.
const configStub = vi.hoisted(() => new Proxy({}, { get: () => undefined, has: () => true }));
vi.mock('@/lib/config', () => configStub);

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

  it('keeps the default value and files no second event on a read failure', async () => {
    // Every attempt rejects, so the retry policy gives up and the SecureStore
    // read path reports the failure once. The store must not add a record of
    // its own for the same rejection.
    getItemAsync.mockRejectedValue(new Error('disk error'));
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });

    vi.useFakeTimers();
    try {
      // Fake timers stay on, so the backoff must still fire. The wait is on the
      // store's own completion signal, not on a copied delay budget.
      const loading = store.whenLoaded();
      await vi.runAllTimersAsync();
      await loading;

      expect(store.get()).toBe(false);
      expect(store.getHasLoaded()).toBe(true);
      expect(events.map(event => event.fingerprint)).toEqual([['secure-store-failure', 'read']]);
      expect(captureException).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      setTelemetrySink(null);
      vi.useRealTimers();
    }
  });

  it('files no event for a keychain refusal while the device is locked', async () => {
    // iOS rejects every read with this message until unlock; the store keeps
    // its default and the refusal leaves a breadcrumb instead of an event.
    getItemAsync.mockRejectedValue(new Error('User interaction is not allowed'));
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });
    const events: TelemetryEvent[] = [];
    const breadcrumbs: TelemetryBreadcrumb[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    setBreadcrumbSink(breadcrumb => {
      breadcrumbs.push(breadcrumb);
    });

    vi.useFakeTimers();
    try {
      const loading = store.whenLoaded();
      await vi.runAllTimersAsync();
      await loading;

      expect(store.get()).toBe(false);
      expect(store.getHasLoaded()).toBe(true);
      expect(events).toHaveLength(0);
      expect(breadcrumbs.map(breadcrumb => breadcrumb.message)).toEqual([
        'keychain refused a call while the device was locked',
      ]);
      expect(captureException).not.toHaveBeenCalled();
    } finally {
      setTelemetrySink(null);
      setBreadcrumbSink(null);
      vi.useRealTimers();
    }
  });

  it('retries a rejected read and applies the value from the retry', async () => {
    getItemAsync
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockResolvedValueOnce('true');
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    vi.useFakeTimers();
    try {
      // The first read rejects; the retry timer must fire before the second
      // attempt can apply the stored value.
      const loading = store.whenLoaded();
      await vi.runAllTimersAsync();
      await loading;

      expect(store.get()).toBe(true);
      expect(store.getHasLoaded()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a toast and keeps the last stored value when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.set(true);
    // The choice is not stored, so the app does not claim it.
    expect(store.get()).toBe(false);

    await store.whenPersisted();

    expect(toastError).toHaveBeenCalledWith('Could not save setting');
    expect(store.get()).toBe(false);
  });

  it('applies a choice only once its write lands', async () => {
    getItemAsync.mockResolvedValue(null);
    const writeGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementation(async () => {
      await writeGate.promise;
    });
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.set(true);
    // In flight: the newest choice is what the next press builds on, but the
    // rendered value is still the stored one.
    expect(store.getRequested()).toBe(true);
    expect(store.get()).toBe(false);

    writeGate.resolve(undefined);
    await store.whenPersisted();

    expect(store.get()).toBe(true);
    expect(setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('writes the newest choice, not every choice, when several land during one write', async () => {
    getItemAsync.mockResolvedValue(null);
    const firstWriteGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementationOnce(async () => {
      await firstWriteGate.promise;
    });
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.set(true);
    store.set(false);
    store.set(true);
    store.set(false);

    firstWriteGate.resolve(undefined);
    await store.whenPersisted();

    // The first write was already on its way; every later choice collapsed into
    // the newest one, which therefore lands after it.
    expect(setItemAsync.mock.calls.map(call => call[1])).toEqual(['true', 'false']);
    expect(store.get()).toBe(false);
  });

  it('reports a requested null for a nullable store', async () => {
    getItemAsync.mockResolvedValue(null);
    const writeGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementationOnce(async () => {
      await writeGate.promise;
    });
    const store = createSecureStorePreference<string | null>({
      key: 'k',
      defaultValue: null,
      parse: raw => raw,
      serialize: value => value ?? '',
    });

    store.set('chosen');
    // A null target is a real choice ("auto"), not "nothing pending".
    store.set(null);
    expect(store.getRequested()).toBeNull();

    writeGate.resolve(undefined);
    await store.whenPersisted();
    expect(store.get()).toBeNull();
  });

  it('releases whenPersisted() and drops a newer choice when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    const writeGate = Promise.withResolvers<undefined>();
    setItemAsync.mockImplementation(async (_key: string, value: string) => {
      await writeGate.promise;
      if (value === 'true') {
        throw new Error('disk full');
      }
    });
    const store = createSecureStorePreference<boolean>({
      key: 'k',
      defaultValue: false,
      parse: raw => raw === 'true',
      serialize: value => (value ? 'true' : 'false'),
    });

    store.set(true);
    // A choice made while the failing write is in flight is dropped with it.
    store.set(false);

    writeGate.resolve(undefined);
    await store.whenPersisted();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(false);
    expect(store.getRequested()).toBe(false);
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

  it('never repaints a pre-merge choice over the merged value', async () => {
    const pendingRead = Promise.withResolvers<string | null>();
    const writeGate = Promise.withResolvers<undefined>();
    getItemAsync.mockReturnValueOnce(pendingRead.promise).mockResolvedValue(null);
    setItemAsync.mockImplementationOnce(async () => {
      await writeGate.promise;
    });
    const store = createSecureStorePreference<string[]>({
      key: 'k',
      defaultValue: [],
      parse: raw => (raw ? (JSON.parse(raw) as string[]) : []),
      serialize: value => JSON.stringify(value),
      mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
    });

    const seen: string[][] = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.get());
    });

    // The choice starts its write, then the read settles and reconciles the
    // disk entries into the value, which supersedes that in-flight write: it
    // must not paint its own target back over the merge while the reconciliation
    // write is still to come.
    store.set(['local']);
    pendingRead.resolve('["disk"]');
    await flushMicrotasks();
    writeGate.resolve(undefined);
    await store.whenPersisted();

    // The merged value is visible once the read settles, and no later repaint
    // may drop back to the pre-merge target (which would hide the disk entries
    // until the reconciliation write lands).
    const mergedAt = seen.findIndex(entry => entry.length === 2);
    expect(mergedAt).toBeGreaterThanOrEqual(0);
    // Every repaint after the merge keeps the disk entries; none drops back to
    // the pre-merge target, which would hide them until the reconciliation
    // write lands.
    expect(seen.slice(mergedAt).every(entry => entry.length === 2)).toBe(true);
    expect(seen.at(-1)).toEqual(['disk', 'local']);
    unsubscribe();
  });

  it('does not claim the list was read when a set lands before the initial read', async () => {
    const pendingRead = Promise.withResolvers<string | null>();
    getItemAsync.mockReturnValueOnce(pendingRead.promise);
    const store = createSecureStorePreference<string[]>({
      key: 'k',
      defaultValue: [],
      parse: raw => (raw === null || raw === '' ? [] : raw.split(',')),
      serialize: value => value.join(','),
      mergeOnLoad: (disk, pending) => [...new Set([...disk, ...pending])],
    });

    /* A screen that adds a server before the first read has to be able to tell
       "the stored list is known" from "the stored list is still on its way". A
       write landing answers neither, so it must not settle the read. */
    const unsubscribe = store.subscribe(noopListener);
    store.set(['local']);
    await store.whenPersisted();
    expect(store.getHasLoaded()).toBe(false);

    pendingRead.resolve('disk');
    await store.whenLoaded();

    expect(store.getHasLoaded()).toBe(true);
    expect(store.get()).toEqual(['disk', 'local']);
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
