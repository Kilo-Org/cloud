import { describe, expect, it } from 'vitest';

import {
  isTabStackRootMissing,
  TAB_STACK_ROOT_ROUTE_NAME,
  tabStackRootRepair,
} from './tab-stack-root-repair';

const route = (key: string, name: string) => ({ key, name });

describe('isTabStackRootMissing', () => {
  it('reports the root missing when a restored subpage is the only route', () => {
    // The relaunch restore after the app died on Preferences: expo-router could
    // not read the tab Stack's anchor, so the destination is the subpage alone.
    expect(isTabStackRootMissing({ routes: [route('p', 'preferences')], index: 0 })).toBe(true);
  });

  it('reports the root present when it sits beneath the subpage', () => {
    expect(
      isTabStackRootMissing({ routes: [route('i', 'index'), route('p', 'preferences')], index: 1 })
    ).toBe(false);
  });

  it('leaves the tab root alone', () => {
    expect(isTabStackRootMissing({ routes: [route('i', 'index')], index: 0 })).toBe(false);
  });

  it('does not count a root above the subpage as its parent', () => {
    // A root above the focused screen is one the reader moved on from, not a
    // parent: only the routes BELOW the focused one count.
    expect(
      isTabStackRootMissing({
        routes: [route('a', 'account'), route('i', 'index')],
        index: 0,
      })
    ).toBe(true);
  });

  it('leaves an empty state alone instead of filling it with a lone root', () => {
    expect(isTabStackRootMissing({ routes: [], index: 0 })).toBe(false);
  });
});

describe('tabStackRootRepair', () => {
  it('inserts the root beneath the focused subpage and keeps it focused', () => {
    const repaired = tabStackRootRepair({ routes: [route('p', 'preferences')], index: 0 });

    expect(repaired?.routes.map(item => item.name)).toEqual(['index', 'preferences']);
    expect(repaired?.index).toBe(1);
    // The restored screen keeps its key, so it keeps its identity and its
    // state and is never removed and re-inserted in one commit.
    expect(repaired?.routes[1]?.key).toBe('p');
  });

  it('leaves the inserted root keyless so the reset mints its key', () => {
    // Expo Router derives a nested navigator's state keys from the parent
    // route key's chain, so an invented one breaks the tab's screens. The
    // reset mints a key for a route whose key is empty.
    const repaired = tabStackRootRepair({ routes: [route('p', 'preferences')], index: 0 });

    expect(repaired?.routes[0]?.key).toBe('');
    expect(repaired?.routes[0]?.name).toBe(TAB_STACK_ROOT_ROUTE_NAME);
    expect(repaired?.routes[0]?.params).toEqual({});
  });

  it('inserts beneath the focused screen, not at the bottom', () => {
    const repaired = tabStackRootRepair({
      routes: [route('a', 'account'), route('h', 'history'), route('p', 'preferences')],
      index: 2,
    });

    expect(repaired?.routes.map(item => item.name)).toEqual([
      'account',
      'history',
      'index',
      'preferences',
    ]);
    expect(repaired?.index).toBe(3);
  });

  it('does nothing when the root is already beneath the subpage', () => {
    expect(
      tabStackRootRepair({ routes: [route('i', 'index'), route('p', 'preferences')], index: 1 })
    ).toBeNull();
  });

  it('does nothing when the tab root is the focused screen', () => {
    expect(tabStackRootRepair({ routes: [route('i', 'index')], index: 0 })).toBeNull();
  });
});
