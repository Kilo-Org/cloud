// A cold start with the radio surely down commits the banner with the first
// screen; every later disconnect keeps the flap delay and the probe.
import { describe, expect, it } from 'vitest';

import { phaseBlocksWrites } from './offline-banner-state';
import {
  createStore,
  disconnectedState,
  offlineState,
  onlineState,
  unknownState,
} from './offline-banner-state.test-helpers';

describe('createOfflineBannerStore cold start', () => {
  it('commits a definite disconnect at once when it is the first committed state', () => {
    const { store, source, timer, probe, changes } = createStore();
    source.emit(unknownState);
    source.emit(disconnectedState);
    expect(store.isOffline()).toBe(true);
    expect(phaseBlocksWrites(store.phase())).toBe(true);
    expect(changes).toEqual(['offline']);
    timer.advanceBy(10_000);
    expect(probe).not.toHaveBeenCalled();
    expect(changes).toEqual(['offline']);
  });

  it('never shows the banner for an initial unknown report followed by online', () => {
    const { store, source, timer, probe, changes } = createStore();
    source.emit(unknownState);
    source.emit(onlineState);
    timer.advanceBy(10_000);
    expect(store.isOffline()).toBe(false);
    expect(changes).toEqual(['online']);
    expect(probe).not.toHaveBeenCalled();
  });

  it('waits the full delay for a definite disconnect after online was committed', async () => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(onlineState);
    source.emit(disconnectedState);
    expect(store.state()).toBe('online');
    timer.advanceBy(4999);
    expect(store.isOffline()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    timer.advanceBy(1);
    await settle(0, 'offline');
    expect(store.isOffline()).toBe(true);
    expect(changes).toEqual(['online', 'offline']);
  });

  it('waits the full delay for a definite disconnect after a cancelled confirmation', async () => {
    const { store, source, timer, probe, settle } = createStore();
    source.emit(offlineState);
    source.emit(unknownState);
    source.emit(disconnectedState);
    timer.advanceBy(4999);
    expect(store.isOffline()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    timer.advanceBy(1);
    await settle(0, 'offline');
    expect(store.isOffline()).toBe(true);
  });

  it('commits a confirmOffline made while starting, then waits again after recovery', async () => {
    const { store, source, timer, probe, changes, settle } = createStore();
    store.confirmOffline();
    expect(store.phase().kind).toBe('offline');
    source.emit(onlineState);
    source.emit(disconnectedState);
    timer.advanceBy(4999);
    expect(store.isOffline()).toBe(false);
    timer.advanceBy(1);
    expect(probe).toHaveBeenCalledOnce();
    await settle(0, 'offline');
    expect(changes).toEqual(['offline', 'online', 'offline']);
  });
});
