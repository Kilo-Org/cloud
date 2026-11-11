import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeToFocusedRoute } from './route-scope';
import { dump } from './rules/test-dump';
import type { ProbeDump, ProbeNode } from './tree';

const HISTORY = ['View', 'Route', 'Route(history)'];
const HOME = ['View', 'Route', 'Route(index)'];
const SCREEN = '(app)/(tabs)/(2_agents)/history';

function node(over: Partial<ProbeNode> & Pick<ProbeNode, 'parent'>): ProbeNode {
  return { tag: 'View', rect: [0, 0, 10, 10], layoutRect: [0, 0, 10, 10], ...over };
}

/** Root chrome, a Home screen, the History screen, and chrome after both. */
function fixture(): ProbeDump {
  return dump(
    [
      node({ parent: 0, owners: HOME }),
      node({ parent: 1, testID: 'home-body' }),
      node({ parent: 0, owners: HISTORY }),
      node({ parent: 3, testID: 'agents-open-filters' }),
      node({ parent: 0, testID: 'tab-bar' }),
    ],
    { screen: SCREEN }
  );
}

test('drops a background tab and keeps the focused screen with its chrome', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'View', 'agents-open-filters', 'tab-bar']
  );
});

test('keeps the tree a tree after the removed subtree', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.deepEqual(
    scoped.nodes.map(entry => entry.parent),
    [-1, 0, 1, 0]
  );
});

test('remaps parents when the dropped subtree comes before the kept one', () => {
  const ordered = dump(
    [
      node({ parent: 0, owners: HOME }),
      node({ parent: 1, testID: 'home-body' }),
      node({ parent: 0, testID: 'tab-bar' }),
      node({ parent: 0, owners: HISTORY }),
      node({ parent: 4, testID: 'agents-open-filters' }),
    ],
    { screen: SCREEN }
  );
  const scoped = scopeToFocusedRoute(ordered);
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'tab-bar', 'View', 'agents-open-filters']
  );
  assert.deepEqual(
    scoped.nodes.map(entry => entry.parent),
    [-1, 0, 0, 2]
  );
});

test('keeps every node when the focused route names no screen', () => {
  // A tab's route is registered as `index` while its screen key is the group.
  const unfocused = dump(
    [node({ parent: 0, owners: HOME }), node({ parent: 0, owners: HISTORY })],
    {
      screen: '(app)/(tabs)/(0_home)',
    }
  );
  assert.equal(scopeToFocusedRoute(unfocused), unfocused);
});

test('keeps every node when the dump carries no screen identity', () => {
  const anonymous = dump([node({ parent: 0, owners: HOME }), node({ parent: 0, owners: HISTORY })]);
  assert.equal(scopeToFocusedRoute(anonymous), anonymous);
});

test('keeps every node when the only screen is the focused one', () => {
  const single = dump([node({ parent: 0, owners: HISTORY }), node({ parent: 1, testID: 'row' })], {
    screen: SCREEN,
  });
  assert.equal(scopeToFocusedRoute(single), single);
});

test('keeps a node under no route screen, such as the tab bar', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.ok(scoped.nodes.some(entry => entry.testID === 'tab-bar'));
  assert.ok(!scoped.nodes.some(entry => entry.testID === 'home-body'));
});
