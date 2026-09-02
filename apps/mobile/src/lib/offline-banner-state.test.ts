import { describe, expect, it, vi } from 'vitest';

import { type ConnectivityState } from '@/lib/connectivity-online';
import {
  type BannerState,
  type ConnectivitySource,
  createOfflineBannerStore,
  type OfflineBannerTimer,
} from '@/lib/offline-banner-state';

const offlineState: ConnectivityState = { isConnected: true, isInternetReachable: false };
const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
const unknownState: ConnectivityState = { isConnected: null, isInternetReachable: null };
const outcomes = ['online', 'offline', 'reject'] as const;
type Outcome = (typeof outcomes)[number];

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

function createFakeTimer() {
  let now = 0;
  const scheduled: { callback: () => void; at: number; cancelled: boolean }[] = [];
  const timer: OfflineBannerTimer = {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- manually controlled timer callbacks
    set(callback, delayMs) {
      const entry = { callback, at: now + delayMs, cancelled: false };
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
    advanceBy(ms: number): void {
      now += ms;
      for (const entry of scheduled) {
        if (!entry.cancelled && entry.at <= now) {
          entry.cancelled = true;
          entry.callback();
        }
      }
    },
  };
}

function createStore() {
  const source = createFakeSource();
  const timer = createFakeTimer();
  const attempts: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
  const probe = vi.fn(async () => {
    const attempt = Promise.withResolvers<boolean>();
    attempts.push(attempt);
    const result = await attempt.promise;
    return result;
  });
  const store = createOfflineBannerStore({ source: source.source, timer: timer.timer, probe });
  const changes: BannerState[] = [];
  store.subscribe(() => {
    changes.push(store.state());
  });
  return {
    store,
    source,
    timer,
    probe,
    changes,
    settle: async (index: number, outcome: Outcome) => {
      const attempt = attempts[index];
      if (!attempt) {
        throw new Error(`Missing probe ${index}`);
      }
      if (outcome === 'reject') {
        attempt.reject(new Error('Transport failed'));
      } else {
        attempt.resolve(outcome === 'online');
      }
      await Promise.allSettled([attempt.promise]);
    },
  };
}

describe('createOfflineBannerStore', () => {
  it('starts unknown and stays hidden without probing unknown connectivity', () => {
    const { store, source, timer, probe, changes } = createStore();
    expect(store.state()).toBe('unknown');
    source.emit(unknownState);
    timer.advanceBy(10_000);
    expect(store.state()).toBe('unknown');
    expect(store.isOffline()).toBe(false);
    expect(changes).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(outcomes)('waits exactly five seconds and one current probe before %s', async outcome => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(4999);
    expect(store.state()).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
    timer.advanceBy(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.isOffline()).toBe(false);
    expect(changes).toEqual([]);
    timer.advanceBy(10_000);
    expect(probe).toHaveBeenCalledTimes(1);
    await settle(0, outcome);
    const expected = outcome === 'online' ? 'online' : 'offline';
    expect(store.state()).toBe(expected);
    expect(store.isOffline()).toBe(expected === 'offline');
    expect(changes).toEqual([expected]);
  });

  it('handles a synchronous probe throw as a failed confirmation', () => {
    const { store, source, timer, probe, changes } = createStore();
    probe.mockImplementationOnce(() => {
      throw new Error('Probe could not start');
    });
    source.emit({ isConnected: false, isInternetReachable: false });
    timer.advanceBy(5000);
    expect(store.state()).toBe('offline');
    expect(changes).toEqual(['offline']);
  });

  it.each([
    { event: onlineState, expected: 'online', changes: ['online'] },
    { event: unknownState, expected: 'unknown', changes: [] },
  ])('cancels the delay on $expected without probing', ({ event, expected, changes }) => {
    const fixture = createStore();
    fixture.source.emit(offlineState);
    fixture.source.emit(event);
    fixture.timer.advanceBy(5000);
    expect(fixture.store.state()).toBe(expected);
    expect(fixture.store.isOffline()).toBe(false);
    expect(fixture.changes).toEqual(changes);
    expect(fixture.probe).not.toHaveBeenCalled();
  });

  it('restarts the full delay on repeated offline reports and ignores a cancelled callback', async () => {
    const { store, source, timer, probe, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(4999);
    source.emit(offlineState);
    timer.scheduled[0]?.callback();
    timer.advanceBy(1);
    expect(store.state()).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
    timer.advanceBy(4999);
    await settle(0, 'offline');
    expect(store.isOffline()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(outcomes)('hides immediately on recovery and ignores the in-flight %s', async outcome => {
    const { store, source, timer, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(0, 'offline');
    expect(store.isOffline()).toBe(true);
    source.emit(offlineState);
    timer.advanceBy(5000);
    source.emit(onlineState);
    expect(store.state()).toBe('online');
    expect(store.isOffline()).toBe(false);
    await settle(1, outcome);
    expect(store.state()).toBe('online');
    expect(changes).toEqual(['offline', 'online']);
  });

  it.each(outcomes)(
    'invalidates an in-flight %s on unknown without advancing boot state',
    async outcome => {
      const { store, source, timer, changes, settle } = createStore();
      source.emit(offlineState);
      timer.advanceBy(5000);
      source.emit(unknownState);
      await settle(0, outcome);
      expect(store.state()).toBe('unknown');
      expect(store.isOffline()).toBe(false);
      expect(changes).toEqual([]);
    }
  );

  it.each(outcomes)(
    'invalidates an in-flight %s while a newer offline delay is pending',
    async outcome => {
      const { store, source, timer, changes, settle } = createStore();
      source.emit(offlineState);
      timer.advanceBy(5000);
      source.emit(offlineState);
      await settle(0, outcome);
      expect(store.state()).toBe('unknown');
      expect(changes).toEqual([]);
      timer.advanceBy(5000);
      await settle(1, 'offline');
      expect(store.state()).toBe('offline');
      expect(changes).toEqual(['offline']);
    }
  );

  it.each([
    ['offline', 'online'],
    ['reject', 'online'],
    ['online', 'offline'],
  ] as const)('ignores older %s after a newer %s result', async (older, newer) => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    source.emit(unknownState);
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(1, newer);
    expect(store.state()).toBe(newer);
    await settle(0, older);
    expect(store.state()).toBe(newer);
    expect(changes).toEqual([newer]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('preserves confirmed offline on unknown and avoids duplicate offline notifications', async () => {
    const { store, source, timer, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(0, 'offline');
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(1, 'offline');
    source.emit(unknownState);
    expect(store.isOffline()).toBe(true);
    expect(changes).toEqual(['offline']);
  });

  it('destroy cancels the timer, unsubscribes, and ignores a queued timer callback', () => {
    const { store, source, timer, probe, changes } = createStore();
    source.emit(offlineState);
    store.destroy();
    timer.scheduled[0]?.callback();
    timer.advanceBy(5000);
    source.emit(onlineState);
    expect(store.state()).toBe('unknown');
    expect(changes).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(outcomes)(
    'ignores %s after destruction without notifying or changing state',
    async outcome => {
      const { store, source, timer, changes, settle } = createStore();
      source.emit(offlineState);
      timer.advanceBy(5000);
      store.destroy();
      await settle(0, outcome);
      source.emit(onlineState);
      expect(store.state()).toBe('unknown');
      expect(store.isOffline()).toBe(false);
      expect(changes).toEqual([]);
    }
  );

  it('notifies unknown to online once and removes unsubscribed listeners', () => {
    const { store, source, changes } = createStore();
    const listener = vi.fn<() => void>();
    const remove = store.subscribe(listener);
    remove();
    source.emit(onlineState);
    source.emit(onlineState);
    expect(store.state()).toBe('online');
    expect(store.isOffline()).toBe(false);
    expect(changes).toEqual(['online']);
    expect(listener).not.toHaveBeenCalled();
  });
});
