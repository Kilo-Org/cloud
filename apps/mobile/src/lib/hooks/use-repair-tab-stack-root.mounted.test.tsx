import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { type TabStackNavigation, useRepairTabStackRoot } from './use-repair-tab-stack-root';

type Route = { name: string; key: string; params?: object };
type State = { index: number; routes: Route[] };

/** The fake tab Stack the repair reads, dispatches into, and listens to. */
type NavigationHarness = {
  navigation: TabStackNavigation;
  /** Every reset the repair dispatched, in order. */
  resets: State[];
  state: () => State;
  /** A navigation the app dispatched: the state changes and listeners fire. */
  deliver: (next: State) => void;
};

/**
 * A tab Stack's navigation: the state the repair reads, the reset it dispatches
 * (which, like the navigator, commits the new state and notifies the state
 * listeners), and the listener the repair subscribes.
 */
function createNavigation(initial: State): NavigationHarness {
  let state = initial;
  const listeners = new Set<() => void>();
  const resets: State[] = [];

  const commit = (next: State) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const navigation: TabStackNavigation = {
    getState: () => state as never,
    reset: next => {
      resets.push(next as unknown as State);
      commit(next as unknown as State);
    },
    addListener: (_event, listener) => {
      const entry = () => {
        listener(undefined as never);
      };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };

  return { navigation, resets, state: () => state, deliver: commit };
}

/**
 * Mount one scene wrapper per Stack screen, the way every scene of the Stack
 * renders its own layout and so runs its own repair.
 */
function mount(harness: NavigationHarness, sceneCount = 1): TestRenderer.ReactTestRenderer {
  function Scene(): null {
    useRepairTabStackRoot(harness.navigation);
    return null;
  }

  const scenes = Array.from({ length: sceneCount }, (_, index) =>
    createElement(Scene, { key: index })
  );
  const created: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    created.renderer = TestRenderer.create(createElement(Fragment, null, ...scenes));
  });
  const renderer = created.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('useRepairTabStackRoot', () => {
  it('puts the tab root beneath a subpage the Stack restored on its own', () => {
    const harness = createNavigation({
      index: 0,
      routes: [{ name: 'preferences', key: 'preferences' }],
    });
    mount(harness);

    expect(harness.resets).toHaveLength(1);
    // The inserted root is keyless: the reset action mints its key from the
    // state's own sequence, which is the chain the tab's screens derive from.
    expect(harness.state()).toEqual({
      index: 1,
      routes: [
        { key: '', name: 'index', params: {} },
        { name: 'preferences', key: 'preferences' },
      ],
    });
    // The restored screen keeps its key, so it is not remounted.
    expect(harness.state().routes[1]?.key).toBe('preferences');
    // And the repair settles: the inserted root satisfies the next read.
    expect(harness.resets).toHaveLength(1);
  });

  it('inserts once for every scene of the same state', () => {
    // Every scene of the Stack mounts this hook, and they all read the state
    // object from before the first reset committed.
    const harness = createNavigation({
      index: 0,
      routes: [{ name: 'history', key: 'history' }],
    });
    mount(harness, 3);

    expect(harness.resets).toHaveLength(1);
  });

  it('leaves a Stack that already holds the root beneath the subpage', () => {
    const harness = createNavigation({
      index: 1,
      routes: [
        { name: 'index', key: 'root' },
        { name: 'preferences', key: 'preferences' },
      ],
    });
    mount(harness);

    expect(harness.resets).toHaveLength(0);
  });

  it('leaves the tab root itself alone', () => {
    const harness = createNavigation({ index: 0, routes: [{ name: 'index', key: 'root' }] });
    mount(harness);

    expect(harness.resets).toHaveLength(0);
  });

  it('repairs a subpage a later link leaves as the only route', () => {
    const harness = createNavigation({ index: 0, routes: [{ name: 'index', key: 'root' }] });
    mount(harness);
    expect(harness.resets).toHaveLength(0);

    // A link delivered later replaces the focused route with a fresh
    // destination, which leaves the subpage as the Stack's only route.
    act(() => {
      harness.deliver({ index: 0, routes: [{ name: 'history', key: 'history' }] });
    });

    expect(harness.state()).toEqual({
      index: 1,
      routes: [
        { key: '', name: 'index', params: {} },
        { name: 'history', key: 'history' },
      ],
    });
  });
});
