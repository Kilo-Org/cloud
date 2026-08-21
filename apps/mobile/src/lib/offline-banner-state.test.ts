import { describe, expect, it, vi } from 'vitest';

import { type ConnectivityState } from '@/lib/connectivity-online';
import {
  type ConnectivitySource,
  createOfflineBannerStore,
  OFFLINE_BANNER_SHOW_DELAY_MS,
  type OfflineBannerStore,
  type OfflineBannerTimer,
} from '@/lib/offline-banner-state';

const offlineState: ConnectivityState = { isConnected: false, isInternetReachable: false };
const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
const unknownState: ConnectivityState = { isConnected: null, isInternetReachable: null };

function createFakeSource() {
  const listeners = new Set<(state: ConnectivityState) => void>();
  const unsubscribe = vi.fn(() => undefined);
  const source: ConnectivitySource = {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
  return {
    source,
    emit(state: ConnectivityState): void {
      for (const listener of listeners) {
        listener(state);
      }
    },
    unsubscribe,
  };
}

type ScheduledEntry = { callback: () => void; cancelled: boolean; delayMs: number };

function createFakeTimer() {
  const scheduled: ScheduledEntry[] = [];
  const timer: OfflineBannerTimer = {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- the fake timer stores callbacks for manual firing
    set(callback, delayMs) {
      const entry: ScheduledEntry = { callback, cancelled: false, delayMs };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
  return {
    timer,
    scheduled,
    firePending(): void {
      while (scheduled.length > 0) {
        const entry = scheduled.shift();
        if (!entry) {
          return;
        }
        if (!entry.cancelled) {
          entry.callback();
          return;
        }
      }
    },
  };
}

function createStore(
  source = createFakeSource(),
  timer = createFakeTimer()
): {
  store: OfflineBannerStore;
  source: ReturnType<typeof createFakeSource>;
  timer: ReturnType<typeof createFakeTimer>;
} {
  return {
    store: createOfflineBannerStore({ source: source.source, timer: timer.timer }),
    source,
    timer,
  };
}

describe('createOfflineBannerStore', () => {
  it('starts unknown, not offline', () => {
    const { store } = createStore();

    expect(store.isOffline()).toBe(false);
    expect(store.state()).toBe('unknown');
  });

  it('does not show the offline banner while connectivity is unknown', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(unknownState);
    timer.firePending();

    expect(store.isOffline()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies on unknown → online (the banner stays hidden)', () => {
    const { store, source } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(unknownState);
    source.emit(onlineState);

    expect(store.isOffline()).toBe(false);
    expect(store.state()).toBe('online');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('commits offline only after the show delay and notifies once', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(offlineState);

    expect(store.isOffline()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(timer.scheduled[0]?.delayMs).toBe(OFFLINE_BANNER_SHOW_DELAY_MS);

    timer.firePending();

    expect(store.isOffline()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending offline commit when the state returns online inside the window', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(offlineState);
    source.emit(onlineState);

    timer.firePending();

    expect(store.isOffline()).toBe(false);
    expect(store.state()).toBe('online');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hides immediately when the connection returns after a committed offline', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(offlineState);
    timer.firePending();
    expect(store.isOffline()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    source.emit(onlineState);

    expect(store.isOffline()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(timer.scheduled.filter(entry => !entry.cancelled)).toEqual([]);
  });

  it('commits exactly once for rapid alternation, matching the final quiet state', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(offlineState);
    source.emit(onlineState);
    source.emit(offlineState);
    source.emit(onlineState);
    source.emit(offlineState);

    timer.firePending();

    expect(store.isOffline()).toBe(true);
    // One notification for the unknown → online commit, one for the final
    // offline commit — the intermediate online commits are no-ops.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('destroy with a pending commit cancels the timer and unsubscribes the source', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    source.emit(offlineState);
    store.destroy();

    timer.firePending();
    source.emit(onlineState);

    expect(store.isOffline()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not notify after destroy when the source emits', () => {
    const { store, source, timer } = createStore();
    const listener = vi.fn(() => undefined);
    store.subscribe(listener);

    store.destroy();
    source.emit(offlineState);
    timer.firePending();

    expect(listener).not.toHaveBeenCalled();
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes a removed listener', () => {
    const { store, source } = createStore();
    const listener = vi.fn(() => undefined);
    const remove = store.subscribe(listener);

    remove();
    source.emit(offlineState);

    expect(listener).not.toHaveBeenCalled();
  });

  it('exposes the committed state via state()', () => {
    const { store, source, timer } = createStore();

    expect(store.state()).toBe('unknown');

    source.emit(onlineState);
    expect(store.state()).toBe('online');

    source.emit(offlineState);
    timer.firePending();
    expect(store.state()).toBe('offline');
  });
});
