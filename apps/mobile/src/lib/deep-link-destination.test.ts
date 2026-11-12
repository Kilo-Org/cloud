// What an incoming link may open. The two shapes that used to replace the
// visible screen — a session capture that cannot name a session, and a path
// outside the app's route namespace — are rejected here, so the navigator never
// resolves them and the screen beneath keeps its unsaved state.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_ROUTE_ROOTS,
  opensAppRoutePath,
  opensDestination,
  SESSION_ROUTE_SIBLINGS,
  shellRouteHref,
} from './deep-link-destination';

const SESSION_ID = 'ses_0123456789abcdefghijklmnop';

describe('opensDestination', () => {
  it.each([
    '/(app)/(tabs)/(0_home)',
    '/(app)/(tabs)/(3_profile)',
    '/(app)/security-agent/personal/findings',
    '/(app)/pr-review/Kilo-Org/cloud/6234',
    '/(app)/agent-chat/new',
    `/(app)/agent-chat/${SESSION_ID}`,
    // A session id minted before the canonical shape: the store still holds it,
    // so a link that names it must reach the route.
    '/(app)/agent-chat/xmw2l780h18',
    // A `ses_` id whose length drifts from the canonical shape for the same
    // reason: the route can address it, so the link opens and the route's
    // not-found state answers an id that does not resolve.
    '/(app)/agent-chat/ses_01J9FRESH000000000000000001',
  ])('opens the table destination %s', href => {
    expect(opensDestination(href)).toBe(true);
  });

  it.each([
    // No capture: the href names the session family, not a session.
    '/(app)/agent-chat/',
    // Characters the store's id rule refuses, so no read could ever address it.
    '/(app)/agent-chat/ses:1',
    '/(app)/agent-chat/has space',
    // A sibling screen's name is a single addressable segment, and expo-router
    // matches the static route ahead of the session route: following the link
    // would open that screen instead of a session.
    ...SESSION_ROUTE_SIBLINGS.map(name => `/(app)/agent-chat/${name}`),
  ])('refuses the session destination %s', href => {
    expect(opensDestination(href)).toBe(false);
  });

  it('names every sibling route of the session screen', () => {
    // A sibling added to the route directory is a link target the filter must
    // refuse, so the list is checked against the directory rather than trusted.
    const entries = readdirSync(
      fileURLToPath(new URL('../app/(app)/agent-chat', import.meta.url)),
      {
        withFileTypes: true,
      }
    )
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .filter(name => !/\.test\.tsx?$/.test(name))
      .map(name => name.replace(/\.(tsx|ts|jsx|js)$/, ''))
      // `[session-id]` is the session route itself and `new` is its composer.
      .filter(name => name !== '[session-id]' && name !== 'new');

    expect([...SESSION_ROUTE_SIBLINGS].sort()).toEqual(entries.sort());
  });
});

describe('opensAppRoutePath', () => {
  it.each([
    'kiloapp:///(app)/profile-management/34d743e6-7bb8-4dd1-880c-580bd8d907d5/variables',
    'kiloapp:///(auth)/session-row-fixture',
    'kiloapp:///force-update',
    'kiloapp:///button-label-fixture',
    '/(app)/agent-chat/new?mode=code',
    '/(auth)/login',
    `kiloapp:///(app)/agent-chat/${SESSION_ID}`,
    'kiloapp:///(app)/agent-chat/new',
    `kiloapp://agent-chat/${SESSION_ID}`,
    'kiloapp://pr-review/Kilo-Org/cloud/6234',
    'kiloapp://security-agent/personal',
  ])('opens the app route %s', path => {
    expect(opensAppRoutePath(path)).toBe(true);
  });

  it.each([
    'kiloapp:///',
    'kiloapp://',
    'kiloapp:///definitely-not-a-route',
    'kiloapp:///dev/unknown-fixture',
    'https://app.kilo.ai/admin',
    'https://example.com/profile',
    'not a url',
    'kiloapp://agent-chat/ses:1',
    // The group-stripped family link with no capture names no session.
    'kiloapp://agent-chat/',
  ])('refuses %s', path => {
    expect(opensAppRoutePath(path)).toBe(false);
  });
});

describe('shellRouteHref', () => {
  // A link into the signed-in shell is navigated through the pending deep-link
  // slot, whose `withAnchor` navigation keeps each stack's layout anchor under
  // the target. Everything else keeps the path it had.
  it.each([
    [
      'kiloapp:///(app)/(tabs)/(3_profile)/organization/invoices',
      '/(app)/(tabs)/(3_profile)/organization/invoices',
    ],
    [
      'kiloapp:///(app)/(tabs)/(3_profile)/organization/credit-activity',
      '/(app)/(tabs)/(3_profile)/organization/credit-activity',
    ],
    ['kiloapp:///(app)/(tabs)/(2_agents)', '/(app)/(tabs)/(2_agents)'],
    ['/(app)/(tabs)/(3_profile)/preferences', '/(app)/(tabs)/(3_profile)/preferences'],
    ['/(app)/agent-chat/new?mode=code', '/(app)/agent-chat/new?mode=code'],
    ['kiloapp:///(app)/agent-chat/new', '/(app)/agent-chat/new'],
  ])('takes %s into the pending slot as %s', (path, href) => {
    expect(shellRouteHref(path)).toBe(href);
  });

  it.each([
    // The shell gates own these: the consumer never runs on them.
    'kiloapp:///(auth)/session-row-fixture',
    '/(auth)/login',
    'kiloapp:///force-update',
    // A group-stripped search-family link belongs to the search slot.
    'kiloapp://agent-chat/ses_0123456789abcdefghijklmnop',
    'kiloapp://pr-review/Kilo-Org/cloud/6234',
    // An id indexed before its family moved keeps the old route: still a tap.
    'kiloapp:///(app)/(tabs)/(3_profile)/security-agent/finding-1',
    // A session capture the route cannot address is not a screen.
    'kiloapp:///(app)/agent-chat/ses:1',
    'https://app.kilo.ai/profile',
    'not a url',
  ])('leaves %s where it was', path => {
    expect(shellRouteHref(path)).toBeNull();
  });
});

describe('route namespace', () => {
  it('names every root entry of the route directory', () => {
    // A new root-level route must be opened deliberately: an incoming link
    // reaches the navigator only through one of these names (or the indexed
    // families), so a route missing here is unreachable by link.
    const entries = readdirSync(fileURLToPath(new URL('../app', import.meta.url)), {
      withFileTypes: true,
    })
      .map(entry => entry.name)
      // `_layout` and `+`-prefixed files are navigator plumbing, not routes.
      .filter(name => !name.startsWith('_') && !name.startsWith('+'))
      .filter(name => !/\.test\.tsx?$/.test(name))
      .map(name => name.replace(/\.(tsx|ts|jsx|js)$/, ''));

    expect([...new Set(entries)].sort()).toEqual([...APP_ROUTE_ROOTS].sort());
  });
});

describe('seed fixture links', () => {
  it('records the link form the app opens', () => {
    // `dev/seed/AGENTS.md` requires a fixture to record the deep link that opens
    // it, and `opensAppRoutePath` forwards only the group-prefixed form (or a
    // `dev/` fixture link, which `+native-intent` answers before the mapper).
    const files = seedSources(fileURLToPath(new URL('../../../../dev/seed', import.meta.url)));
    const links = files.flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/kiloapp:\/\/[^\s'"`]+/g)].map(match => match[0])
    );

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(
        link.startsWith('kiloapp:///(app)/') || link.startsWith('kiloapp:///dev/'),
        `${link} does not follow the recorded link form`
      ).toBe(true);
    }
  });
});

function seedSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return seedSources(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}
