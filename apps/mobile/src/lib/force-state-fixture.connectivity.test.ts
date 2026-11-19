import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ConnectivityState } from '@/lib/connectivity-online';
import {
  applyForceStatePath,
  resetForceStateForTests,
  subscribeConnectivityWithForceState,
} from '@/lib/force-state-fixture';

const online: ConnectivityState = { isConnected: true, isInternetReachable: true };
const wifiOnly: ConnectivityState = { isConnected: true, isInternetReachable: null };
const offline: ConnectivityState = { isConnected: false, isInternetReachable: false };

const client = new QueryClient();

function force(mode: string) {
  applyForceStatePath(`kiloapp:///dev/force-state/${mode}`, client);
}

/** A NetInfo-shaped subscription the test drives by hand. */
function liveSource() {
  const listeners = new Set<(state: ConnectivityState) => void>();
  return {
    subscribe: (listener: (state: ConnectivityState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (state: ConnectivityState) => {
      for (const listener of listeners) {
        listener(state);
      }
    },
    size: () => listeners.size,
  };
}

function record(subscribe: (listener: (state: ConnectivityState) => void) => () => void) {
  const reports: ConnectivityState[] = [];
  const unsubscribe = subscribeConnectivityWithForceState(subscribe, state => {
    reports.push(state);
  });
  return { reports, unsubscribe };
}

beforeEach(() => {
  resetForceStateForTests();
});

afterEach(() => {
  resetForceStateForTests();
  client.clear();
});

describe('forced connectivity', () => {
  it('reports no network while offline holds, then the latest live report', () => {
    const source = liveSource();
    const { reports, unsubscribe } = record(source.subscribe);
    source.emit(online);

    force('offline');
    source.emit(wifiOnly);
    force('offline');
    force('clear');

    expect(reports).toEqual([online, offline, wifiOnly]);
    unsubscribe();
    expect(source.size()).toBe(0);
  });

  it('starts offline for a subscription made while offline holds', () => {
    force('offline');
    const source = liveSource();
    const { reports } = record(source.subscribe);
    source.emit(online);

    expect(reports).toEqual([offline]);
  });

  it('leaves connectivity live in every other mode', () => {
    const source = liveSource();
    const { reports } = record(source.subscribe);
    force('retryable');
    source.emit(online);

    expect(reports).toEqual([online]);
  });
});
