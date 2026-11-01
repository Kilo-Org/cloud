import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  type ScopeStackNavigation,
  useRepairSecurityAgentScopeStack,
} from './use-repair-security-agent-scope-stack';

type Route = { name: string; key: string; params?: unknown };
type State = { index: number; routes: Route[] };

/** The fake `[scope]` Stack the repair reads, dispatches into, and listens to. */
type NavigationHarness = {
  navigation: ScopeStackNavigation;
  /** Every reset the repair dispatched, in order. */
  resets: State[];
  state: () => State;
  /** A navigation the app dispatched: the state changes and listeners fire. */
  deliver: (next: State) => void;
  listenerCount: () => number;
};

/**
 * A `[scope]` Stack's navigation: the state the repair reads, the reset it
 * dispatches (which, like the navigator, commits the new state and notifies
 * the state listeners), and the listener the repair subscribes.
 */
function createNavigation(
  initial: State,
  options: { commitOnReset?: boolean } = {}
): NavigationHarness {
  const commitOnReset = options.commitOnReset ?? true;
  let state = initial;
  const listeners = new Set<() => void>();
  const resets: State[] = [];

  const commit = (next: State) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const navigation: ScopeStackNavigation = {
    getState: () => state as never,
    reset: next => {
      resets.push(next as unknown as State);
      if (commitOnReset) {
        commit(next as unknown as State);
      }
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

  return {
    navigation,
    resets,
    state: () => state,
    deliver: commit,
    listenerCount: () => listeners.size,
  };
}

/**
 * Mount one scene wrapper per Stack screen, the way every screen of the group
 * renders its own layout.
 */
function mount(
  harness: NavigationHarness,
  scope: string | null,
  sceneCount = 1
): TestRenderer.ReactTestRenderer {
  function Scene(): null {
    useRepairSecurityAgentScopeStack(harness.navigation, scope);
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

describe('useRepairSecurityAgentScopeStack', () => {
  it('puts the dashboard beneath a screen the Stack opened on its own', () => {
    const harness = createNavigation({
      index: 0,
      routes: [{ name: 'settings/notifications', key: 'notifications' }],
    });
    mount(harness, 'personal');

    expect(harness.resets).toHaveLength(1);
    expect(harness.state()).toEqual({
      index: 1,
      routes: [
        { key: 'notifications:index', name: 'index', params: { scope: 'personal' } },
        { name: 'settings/notifications', key: 'notifications' },
      ],
    });
    // The screen the reader is on keeps its key, so it is not remounted.
    expect(harness.state().routes[1]?.key).toBe('notifications');
    // And the repair settles: the inserted dashboard satisfies the next read.
    expect(harness.resets).toHaveLength(1);
  });

  it('leaves a Stack that already holds the dashboard beneath the screen', () => {
    const harness = createNavigation({
      index: 1,
      routes: [
        { name: 'index', key: 'dashboard' },
        { name: 'findings/[id]', key: 'finding' },
      ],
    });
    mount(harness, 'personal');

    expect(harness.resets).toHaveLength(0);
  });

  it('leaves the dashboard itself alone so Back can leave the feature', () => {
    const harness = createNavigation({ index: 0, routes: [{ name: 'index', key: 'dashboard' }] });
    mount(harness, 'personal');

    expect(harness.resets).toHaveLength(0);
  });

  it('inserts the dashboard directly beneath the focused screen', () => {
    const harness = createNavigation({
      index: 1,
      routes: [
        { name: 'findings/index', key: 'list' },
        { name: 'findings/[id]', key: 'finding' },
      ],
    });
    mount(harness, 'personal');

    expect(harness.state().routes.map(route => route.name)).toEqual([
      'findings/index',
      'index',
      'findings/[id]',
    ]);
    expect(harness.state().index).toBe(2);
  });

  it('repairs a Stack the app replaced again after the first repair', () => {
    const harness = createNavigation({
      index: 0,
      routes: [{ name: 'settings/notifications', key: 'first' }],
    });
    mount(harness, 'personal');
    expect(harness.resets).toHaveLength(1);

    // A later link replaces the focused route, so the group holds one screen
    // again.
    harness.deliver({ index: 0, routes: [{ name: 'settings/analysis', key: 'analysis' }] });

    expect(harness.resets).toHaveLength(2);
    expect(harness.state()).toEqual({
      index: 1,
      routes: [
        { key: 'analysis:index', name: 'index', params: { scope: 'personal' } },
        { name: 'settings/analysis', key: 'analysis' },
      ],
    });
  });

  it('inserts once when every scene of the Stack reads the same state', () => {
    // Two scene wrappers subscribe before the first reset commits, which is
    // what a screen that arrives with the dashboard already missing looks
    // like: the navigator hands both the same state object.
    const harness = createNavigation(
      { index: 0, routes: [{ name: 'settings/notifications', key: 'notifications' }] },
      { commitOnReset: false }
    );
    mount(harness, 'personal', 2);

    expect(harness.resets).toHaveLength(1);
  });

  it('does nothing without a valid segment to name the dashboard', () => {
    const harness = createNavigation({
      index: 0,
      routes: [{ name: 'settings/notifications', key: 'notifications' }],
    });
    mount(harness, null);

    expect(harness.resets).toHaveLength(0);
    // No listener either: a screen under an invalid segment renders the
    // terminal state, so there is no Stack to keep.
    expect(harness.listenerCount()).toBe(0);
  });
});
