import { describe, expect, it } from 'vitest';

import { type ProbeNode } from '@/lib/design-gate/collect';

import { scopeToFocusedRoute } from './route-scope';

function node(over: Partial<ProbeNode> & Pick<ProbeNode, 'parent' | 'tag'>): ProbeNode {
  return { rect: [0, 0, 10, 10], layoutRect: [0, 0, 10, 10], ...over };
}

/** Root chrome, a Home screen subtree, a History screen subtree, and chrome after them. */
const TREE: readonly ProbeNode[] = [
  node({ parent: -1, tag: 'RootView' }),
  node({ parent: 0, tag: 'View', owners: ['View', 'Route', 'Route(index)'] }),
  node({ parent: 1, tag: 'View', testID: 'home-body' }),
  node({ parent: 2, tag: 'View', testID: 'home-empty-state' }),
  node({ parent: 0, tag: 'View', owners: ['View', 'Route', 'Route(history)'] }),
  node({ parent: 4, tag: 'View', testID: 'agents-open-filters' }),
  node({ parent: 0, tag: 'View', testID: 'tab-bar' }),
];

describe('scopeToFocusedRoute', () => {
  it('drops a background screen and keeps the focused one with its chrome', () => {
    const scoped = scopeToFocusedRoute(TREE, 'history');
    expect(scoped.map(entry => entry.testID ?? entry.tag)).toEqual([
      'RootView',
      'View',
      'agents-open-filters',
      'tab-bar',
    ]);
  });

  it('keeps the tree a tree after the removed subtree', () => {
    const scoped = scopeToFocusedRoute(TREE, 'history');
    // The focused screen's parent was the root; the tab bar stays directly under it.
    expect(scoped.map(entry => entry.parent)).toEqual([-1, 0, 1, 0]);
  });

  it('keeps everything when the focused route names no screen in the tree', () => {
    // A tab's route is registered as `index` while the screen key is `(0_home)`:
    // nothing matches, so the dump keeps exactly the frames it had before.
    expect(scopeToFocusedRoute(TREE, '(0_home)')).toBe(TREE);
  });

  it('keeps everything when the dump names no route at all', () => {
    const plain = TREE.map(entry => ({ ...entry, owners: undefined }));
    expect(scopeToFocusedRoute(plain, 'history')).toBe(plain);
    expect(scopeToFocusedRoute(TREE, null)).toBe(TREE);
  });

  it('is a no-op when the only screen in the tree is the focused one', () => {
    // A cell whose route is pushed over nothing still holds one screen.
    const single: readonly ProbeNode[] = [
      node({ parent: -1, tag: 'RootView' }),
      node({ parent: 0, tag: 'View', owners: ['View', 'Route', 'Route(history)'] }),
      node({ parent: 1, tag: 'View', testID: 'agents-open-filters' }),
    ];
    expect(scopeToFocusedRoute(single, 'history')).toBe(single);
  });

  it('remaps parents when the dropped subtree is before the kept one', () => {
    // Chrome, a background screen, then chrome and the focused screen: the kept
    // indices shift, so every parent index has to be rewritten.
    const ordered: readonly ProbeNode[] = [
      node({ parent: -1, tag: 'RootView' }),
      node({ parent: 0, tag: 'View', owners: ['Route', 'Route(index)'] }),
      node({ parent: 1, tag: 'View', testID: 'home-body' }),
      node({ parent: 0, tag: 'View', testID: 'tab-bar' }),
      node({ parent: 0, tag: 'View', owners: ['Route', 'Route(history)'] }),
      node({ parent: 4, tag: 'View', testID: 'agents-open-filters' }),
    ];
    const scoped = scopeToFocusedRoute(ordered, 'history');
    expect(scoped.map(entry => entry.testID ?? entry.tag)).toEqual([
      'RootView',
      'tab-bar',
      'View',
      'agents-open-filters',
    ]);
    expect(scoped.map(entry => entry.parent)).toEqual([-1, 0, 0, 2]);
  });

  it('keeps the focused subtree when it is the one after the background screen', () => {
    const scoped = scopeToFocusedRoute(TREE, 'history');
    const filters = scoped.find(entry => entry.testID === 'agents-open-filters');
    expect(filters).toBeDefined();
    expect(scoped.some(entry => entry.testID === 'home-empty-state')).toBe(false);
  });
});
