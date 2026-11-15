import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeToFocusedRoute } from './route-scope';
import { dump } from './rules/test-dump';
import type { ProbeDump, ProbeNode } from './tree';

/** Route files, as the probe names the screen that renders each node. */
const HISTORY = './(app)/(tabs)/(2_agents)/history.tsx';
const HOME = './(app)/(tabs)/(0_home)/index.tsx';
const TABS = './(app)/(tabs)/_layout.tsx';
const SCREEN = '(app)/(tabs)/(2_agents)/history';

function node(over: Partial<ProbeNode> & Pick<ProbeNode, 'parent'>): ProbeNode {
  return { tag: 'View', rect: [0, 0, 10, 10], layoutRect: [0, 0, 10, 10], ...over };
}

/** Root chrome, a Home screen, the History screen, and chrome after both. */
function fixture(): ProbeDump {
  return dump(
    [
      node({ parent: 0, testID: 'tab-bar', screen: TABS }),
      node({ parent: 0, screen: HOME }),
      node({ parent: 2, testID: 'home-body' }),
      node({ parent: 0, screen: HISTORY }),
      node({ parent: 4, testID: 'agents-open-filters' }),
    ],
    { screen: SCREEN }
  );
}

test('drops a background tab and keeps the focused screen with its chrome', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'tab-bar', 'View', 'agents-open-filters']
  );
});

test('keeps the tree a tree after the removed subtree', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.deepEqual(
    scoped.nodes.map(entry => entry.parent),
    [-1, 0, 0, 2]
  );
});

test('remaps parents when the dropped subtree comes before the kept one', () => {
  const ordered = dump(
    [
      node({ parent: 0, screen: HOME }),
      node({ parent: 1, testID: 'home-body' }),
      node({ parent: 0, testID: 'tab-bar', screen: TABS }),
      node({ parent: 0, screen: HISTORY }),
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

test('drops the layout of a group the focused screen is not in', () => {
  const signedOut = dump(
    [
      node({ parent: 0, screen: './(auth)/_layout.tsx' }),
      node({ parent: 1, testID: 'login' }),
      node({ parent: 0, screen: HISTORY }),
      node({ parent: 3, testID: 'agents-open-filters' }),
    ],
    { screen: SCREEN }
  );
  const scoped = scopeToFocusedRoute(signedOut);
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'View', 'agents-open-filters']
  );
});

test('keeps the tab layout above the screen it renders', () => {
  const scoped = scopeToFocusedRoute(fixture());
  assert.ok(scoped.nodes.some(entry => entry.testID === 'tab-bar'));
  assert.ok(!scoped.nodes.some(entry => entry.testID === 'home-body'));
});

test('drops the tab behind a pushed route that shares its last segment', () => {
  // The navigator names the chat tab `[id]` and the pushed review screen
  // `reviews/[id]`, so a route name cannot tell them apart; the route file can.
  const pushed = dump(
    [
      node({ parent: 0, screen: './(app)/(tabs)/(4_chat)/[id].tsx' }),
      node({ parent: 1, testID: 'chat-composer' }),
      node({ parent: 0, screen: './(app)/code-reviewer/[scope]/[platform]/reviews/[id].tsx' }),
      node({ parent: 3, testID: 'review-body' }),
    ],
    { screen: '(app)/code-reviewer/[scope]/[platform]/reviews/[id]' }
  );
  const scoped = scopeToFocusedRoute(pushed);
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'View', 'review-body']
  );
});

test('drops the tab a pushed route was opened from', () => {
  const pushed = dump(
    [
      node({ parent: 0, screen: HOME }),
      node({ parent: 1, testID: 'home-body' }),
      node({ parent: 0, screen: './(app)/agent-chat/[session-id].tsx' }),
      node({ parent: 3, testID: 'composer' }),
    ],
    { screen: '(app)/agent-chat/[session-id]' }
  );
  const scoped = scopeToFocusedRoute(pushed);
  assert.deepEqual(
    scoped.nodes.map(entry => entry.testID ?? entry.tag),
    ['View', 'View', 'composer']
  );
});

test('keeps a tab screen the key names through its index file', () => {
  const home = dump([node({ parent: 0, screen: TABS }), node({ parent: 1, screen: HOME })], {
    screen: '(app)/(tabs)/(0_home)',
  });
  assert.equal(scopeToFocusedRoute(home), home);
});

test('keeps every node when the focused route names no screen', () => {
  const unfocused = dump(
    [node({ parent: 0, screen: HOME }), node({ parent: 0, screen: HISTORY })],
    {
      screen: '(app)/settings',
    }
  );
  assert.equal(scopeToFocusedRoute(unfocused), unfocused);
});

test('keeps every node when the dump carries no screen identity', () => {
  const anonymous = dump([node({ parent: 0, owners: ['View'] }), node({ parent: 0 })]);
  assert.equal(scopeToFocusedRoute(anonymous), anonymous);
});

test('keeps every node when the only screen is the focused one', () => {
  const single = dump([node({ parent: 0, screen: HISTORY }), node({ parent: 1, testID: 'row' })], {
    screen: SCREEN,
  });
  assert.equal(scopeToFocusedRoute(single), single);
});
