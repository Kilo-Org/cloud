import { describe, expect, it } from 'vitest';

import { createAppStateStore } from './app-state-store';

function createFakeSource() {
  const handlers = new Set<(state: string) => void>();
  let added = 0;
  let removed = 0;
  let lastState = 'active';

  return {
    added: () => added,
    removed: () => removed,
    handlerCount: () => handlers.size,
    lastState: () => lastState,
    addEventListener(_type: 'change', handler: (state: string) => void) {
      added += 1;
      handlers.add(handler);
      return {
        remove: () => {
          removed += 1;
          handlers.delete(handler);
        },
      };
    },
    emit: (state: string) => {
      lastState = state;
      for (const handler of handlers) {
        handler(state);
      }
    },
  };
}

describe('createAppStateStore', () => {
  it('starts active and does not touch the source until subscribe', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);

    expect(store.isActive()).toBe(true);
    expect(source.added()).toBe(0);
    expect(source.handlerCount()).toBe(0);
  });

  it('seeds from readInitialActive and resets to not-active on the last unsubscribe', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source, () => false);

    expect(store.isActive()).toBe(false);

    const unsubscribe = store.subscribe(() => undefined);
    source.emit('active');
    expect(store.isActive()).toBe(true);

    unsubscribe();
    expect(store.isActive()).toBe(false);
    expect(source.handlerCount()).toBe(0);
  });

  it('re-reads readInitialActive on the last unsubscribe instead of pinning the seed', () => {
    const source = createFakeSource();
    let live = false;
    const store = createAppStateStore(source, () => live);
    expect(store.isActive()).toBe(false);

    const unsubscribe = store.subscribe(() => undefined);
    live = true;
    unsubscribe();

    expect(store.isActive()).toBe(true);
  });

  it('re-reads the live seed when the first listener subscribes', () => {
    // Cold start: the store is constructed at module evaluation with the app
    // not yet active, so the seed captured then is stale. The app reaches
    // `active` before the first consumer mounts; the source listener is only
    // registered now, so the inactive -> active edge was observed by nobody.
    // The first subscribe must re-read the live seed, or that consumer reads
    // `false` for the whole session.
    const source = createFakeSource();
    let live = false;
    const store = createAppStateStore(source, () => live);
    expect(store.isActive()).toBe(false);

    live = true;
    const unsubscribe = store.subscribe(() => undefined);
    expect(store.isActive()).toBe(true);

    unsubscribe();
  });

  it('does not re-read the live seed for a subscriber after the first', () => {
    // Only the first subscribe re-seeds: the store's own source listener is
    // already live for a second subscriber, so its snapshot must not jump.
    const source = createFakeSource();
    let live = true;
    const store = createAppStateStore(source, () => live);
    const first = store.subscribe(() => undefined);
    source.emit('background');
    expect(store.isActive()).toBe(false);

    live = true;
    const second = store.subscribe(() => undefined);
    expect(store.isActive()).toBe(false);

    first();
    second();
  });

  it('tracks background and inactive as not active, and notifies', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    source.emit('background');
    expect(store.isActive()).toBe(false);
    expect(notifications).toBe(1);

    source.emit('inactive');
    expect(store.isActive()).toBe(false);
    expect(notifications).toBe(1);

    source.emit('active');
    expect(store.isActive()).toBe(true);
    expect(notifications).toBe(2);

    source.emit('extension');
    expect(store.isActive()).toBe(false);
    expect(notifications).toBe(3);
  });

  it('does not notify when the activity state is unchanged', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    source.emit('active');
    expect(notifications).toBe(0);

    source.emit('background');
    source.emit('background');
    expect(notifications).toBe(1);
  });

  it('shares one source subscription between subscribers', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);

    expect(source.added()).toBe(1);
    expect(source.handlerCount()).toBe(1);

    source.emit('background');
    expect(store.isActive()).toBe(false);

    first();
    second();
    expect(source.removed()).toBe(1);
    expect(source.handlerCount()).toBe(0);
  });

  it('keeps the source subscription until the last subscriber leaves', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);

    first();
    expect(source.removed()).toBe(0);
    expect(source.handlerCount()).toBe(1);

    second();
    expect(source.removed()).toBe(1);
    expect(source.handlerCount()).toBe(0);
    expect(source.added()).toBe(1);
  });

  it('resets to active on the last unsubscribe so a remount sees no edge', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    const first = store.subscribe(() => undefined);

    source.emit('background');
    expect(store.isActive()).toBe(false);

    first();
    // Nothing is subscribed, so the source is left alone from here.
    expect(store.isActive()).toBe(true);
    expect(source.handlerCount()).toBe(0);

    // A remount while the app is still backgrounded starts from `true`, exactly
    // like today's per-hook `useState(true)`, so the next `active` event is not
    // a background -> active edge.
    const notifications: number[] = [];
    const second = store.subscribe(() => {
      notifications.push(store.isActive() ? 1 : 0);
    });
    expect(source.lastState()).toBe('background');
    expect(store.isActive()).toBe(true);

    source.emit('active');
    expect(notifications).toEqual([]);

    second();
    expect(source.added()).toBe(2);
    expect(source.removed()).toBe(2);
    expect(source.handlerCount()).toBe(0);
  });

  it('ignores a repeat unsubscribe of the same listener', () => {
    const source = createFakeSource();
    const store = createAppStateStore(source);
    const unsubscribe = store.subscribe(() => undefined);

    unsubscribe();
    unsubscribe();

    expect(source.removed()).toBe(1);
    expect(source.added()).toBe(1);
  });
});
