// Shared fakes for offline-banner-state.test.ts (extracted for max-lines):
// a ConnectivitySource driven by hand, a manual timer, and a store wired to
// both with a recording probe.

import { vi } from 'vitest';

import { type ConnectivityState } from '@/lib/connectivity-online';
import {
  type BannerState,
  type ConnectivitySource,
  createOfflineBannerStore,
  type OfflineBannerTimer,
} from '@/lib/offline-banner-state';

export const offlineState: ConnectivityState = { isConnected: true, isInternetReachable: false };
export const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
export const unknownState: ConnectivityState = { isConnected: null, isInternetReachable: null };
// The radio-back-without-reachability case (uxs3 spot check, e6-after-net:
// airplane mode → 3G while NetInfo's external probe never answers).
export const radioUpUnknownState: ConnectivityState = {
  isConnected: true,
  isInternetReachable: null,
};
export const outcomes = ['online', 'offline', 'reject'] as const;
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

export function createStore() {
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
