import { describe, expect, it } from 'vitest';

import {
  isTabStackRootMissing,
  TAB_STACK_ROOT_ROUTE_NAME,
  tabStackRootRepair,
} from './tab-stack-root-repair';

const route = (key: string, name: string) => ({ key, name });

describe('isTabStackRootMissing', () => {
  it('reports the root missing when a restored subpage is the only route', () => {
    // The state a fresh destination leaves: the target alone, no root beneath.
    expect(isTabStackRootMissing({ routes: [route('p', 'preferences')], index: 0 })).toBe(true);
  });

  it('reports the root present when the Stack holds it under the subpage', () => {
    expect(
      isTabStackRootMissing({ routes: [route('i', 'index'), route('p', 'preferences')], index: 1 })
    ).toBe(false);
  });

  it('leaves the tab root alone', () => {
    expect(isTabStackRootMissing({ routes: [route('i', 'index')], index: 0 })).toBe(false);
  });

  it('reports the root present wherever it sits in the Stack', () => {
    // The root is the Stack's base. A copy anywhere keeps every screen above it
    // reachable, and a second copy would split the screens the reader came
    // through, so the question is by name and not by position.
    expect(
      isTabStackRootMissing({
        routes: [route('l', 'profiles/index'), route('i', 'index'), route('p', 'section')],
        index: 1,
      })
    ).toBe(false);
  });

  it('leaves an empty state alone instead of filling it with a lone root', () => {
    expect(isTabStackRootMissing({ routes: [], index: 0 })).toBe(false);
  });
});

describe('tabStackRootRepair', () => {
  it('inserts the root at the bottom and keeps the subpage focused', () => {
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

  it('keeps the parents the profile repair builds beneath the focused screen', () => {
    // The profile parent repair pushes the list and the overview above whatever
    // the Stack holds. The tab root is the base, so it goes below all of them
    // and Back still steps through the screens the reader came through.
    const repaired = tabStackRootRepair({
      routes: [
        route('l', 'profiles/index'),
        route('o', 'profiles/[profileId]/index'),
        route('s', 'profiles/[profileId]/agents'),
      ],
      index: 2,
    });

    expect(repaired?.routes.map(item => item.name)).toEqual([
      'index',
      'profiles/index',
      'profiles/[profileId]/index',
      'profiles/[profileId]/agents',
    ]);
    expect(repaired?.index).toBe(3);
  });

  it('keeps a subpage that sits above other screens focused', () => {
    const repaired = tabStackRootRepair({
      routes: [route('a', 'account'), route('p', 'preferences')],
      index: 1,
    });

    expect(repaired?.routes.map(item => item.name)).toEqual(['index', 'account', 'preferences']);
    expect(repaired?.index).toBe(2);
  });

  it('does nothing when the Stack already holds the root', () => {
    expect(
      tabStackRootRepair({ routes: [route('i', 'index'), route('p', 'preferences')], index: 1 })
    ).toBeNull();
  });

  it('does nothing when the tab root is the focused screen', () => {
    expect(tabStackRootRepair({ routes: [route('i', 'index')], index: 0 })).toBeNull();
  });
});
