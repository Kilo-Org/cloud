import { describe, expect, it } from 'vitest';

import { createStore, offlineState, onlineState } from './offline-banner-state.test-helpers';

describe('OfflineBannerStore.confirmOffline', () => {
  it('commits offline at once, and a late probe cannot publish over it', async () => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(onlineState);
    source.emit(offlineState);
    timer.advanceBy(5000);
    expect(probe).toHaveBeenCalledTimes(1);

    store.confirmOffline();

    expect(store.phase().kind).toBe('offline');
    expect(store.isOffline()).toBe(true);
    expect(changes).toEqual(['online', 'offline']);
    await settle(0, 'online');
    expect(store.state()).toBe('offline');
    source.emit(onlineState);
    expect(store.state()).toBe('online');
  });

  it('drops a pending confirmation, without a probe', () => {
    const { store, source, timer, probe, changes } = createStore();
    source.emit(offlineState);

    store.confirmOffline();
    timer.advanceBy(10_000);

    expect(store.state()).toBe('offline');
    expect(probe).not.toHaveBeenCalled();
    expect(changes).toEqual(['offline']);
  });
});
