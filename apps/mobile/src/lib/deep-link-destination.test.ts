// What an incoming link may open. The two shapes that used to replace the
// visible screen — a session capture that cannot name a session, and a path
// outside the app's route namespace — are rejected here, so the navigator never
// resolves them and the screen beneath keeps its unsaved state.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_ROUTE_ROOTS, opensAppRoutePath, opensDestination } from './deep-link-destination';

const SESSION_ID = 'ses_0123456789abcdefghijklmnop';

describe('opensDestination', () => {
  it.each([
    '/(app)/(tabs)/(0_home)',
    '/(app)/(tabs)/(3_profile)',
    '/(app)/security-agent/personal/findings',
    '/(app)/pr-review/Kilo-Org/cloud/6234',
    '/(app)/agent-chat/new',
    `/(app)/agent-chat/${SESSION_ID}`,
  ])('opens the table destination %s', href => {
    expect(opensDestination(href)).toBe(true);
  });

  it.each([
    '/(app)/agent-chat/not-a-session',
    '/(app)/agent-chat/00000000-0000-0000-0000-000000000000',
    '/(app)/agent-chat/ses_short',
  ])('refuses the session destination %s', href => {
    expect(opensDestination(href)).toBe(false);
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
    'kiloapp://agent-chat/not-a-session',
    'kiloapp:///(app)/agent-chat/not-a-session',
    '/(app)/agent-chat/ses_short',
  ])('refuses %s', path => {
    expect(opensAppRoutePath(path)).toBe(false);
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
