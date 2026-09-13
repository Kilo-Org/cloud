import { describe, expect, it, vi } from 'vitest';

import { OFFLINE_BANNER_HEIGHT, offlineHeaderReservation } from './offline-banner-state';
import {
  createStore,
  offlineState,
  onlineState,
  outcomes,
  radioUpUnknownState,
  unknownState,
} from './offline-banner-state.test-helpers';

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

  // The radio-back-without-reachability case (uxs3 spot check, e6-after-net:
  // airplane mode → 3G while NetInfo's external probe never answers). The
  // committed offline must not be preserved forever: the app's own probe is
  // the decider, fired immediately without the five-second delay. The
  // radioUpUnknownState fixture lives in the test helpers.

  it('probes immediately on unknown with the radio up while committed offline, and clears on a reachable probe', async () => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(0, 'offline');
    expect(store.isOffline()).toBe(true);

    source.emit(radioUpUnknownState);
    // No timer wait: the probe fired on the event itself.
    expect(probe).toHaveBeenCalledTimes(2);
    await settle(1, 'online');
    expect(store.state()).toBe('online');
    expect(store.isOffline()).toBe(false);
    expect(changes).toEqual(['offline', 'online']);
  });

  it('keeps the offline commit when the radio-up probe fails, without a duplicate notification', async () => {
    const { store, source, timer, probe, changes, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(0, 'offline');

    source.emit(radioUpUnknownState);
    expect(probe).toHaveBeenCalledTimes(2);
    await settle(1, 'offline');
    expect(store.state()).toBe('offline');
    expect(store.isOffline()).toBe(true);
    expect(changes).toEqual(['offline']);
  });

  it('does not probe on unknown with the radio state itself unknown while committed offline', async () => {
    // isConnected null means NetInfo has not settled the radio either — no
    // new information to chase; the last committed state stands (the
    // pre-existing preserve rule).
    const { store, source, timer, probe, settle } = createStore();
    source.emit(offlineState);
    timer.advanceBy(5000);
    await settle(0, 'offline');

    source.emit(unknownState);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.state()).toBe('offline');
  });

  it('does not probe on unknown while committed online (no offline to un-stick)', () => {
    const { store, source, probe, changes } = createStore();
    source.emit(onlineState);
    source.emit(radioUpUnknownState);
    expect(probe).not.toHaveBeenCalled();
    expect(store.state()).toBe('online');
    expect(changes).toEqual(['online']);
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

describe('offlineHeaderReservation', () => {
  it('reserves exactly the painted banner height while offline', () => {
    expect(offlineHeaderReservation(true)).toBe(OFFLINE_BANNER_HEIGHT);
  });

  it('keeps the header flush while online', () => {
    expect(offlineHeaderReservation(false)).toBe(0);
  });
});
