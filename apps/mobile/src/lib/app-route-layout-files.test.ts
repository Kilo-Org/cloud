// Source guard for the "a colocated test must not take the `_layout` name"
// class: Expo Router decides a file is a layout from the FIRST dot-segment of
// its name (`getFileMeta` in expo-router/build/getRoutesCore.js:
// `filenameParts[0] === '_layout'`), so a colocated test named
// `_layout.<anything>.tsx` registers as that directory's layout. The typed-routes
// generator then reports the test file as the layout node and drops every route
// under it from the generated `Href` union — `(tabs)/_layout.mounted.test.tsx`
// silently removed all 222 tab hrefs. `metro.config.js` keeps `*.test.*` out of
// the bundle, but the generator scans the filesystem, so it still sees them.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** Extensions Expo Router strips before reading the name's dot-segments. */
const ROUTE_EXTENSION = /\.[jt]sx?$/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return routeFiles(full);
    }
    return ROUTE_EXTENSION.test(entry.name) ? [full] : [];
  });
}

describe('app route layout files', () => {
  it('keeps the `_layout` name for the layout itself, never a colocated test', () => {
    const shadows = routeFiles(APP_DIR)
      .map(file => relative(APP_DIR, file))
      .filter(path => {
        const name = (path.split('/').pop() ?? '').replace(ROUTE_EXTENSION, '');
        return name.split('.')[0] === '_layout' && name !== '_layout';
      });
    expect(
      shadows,
      'rename the test: expo-router reads `_layout.<rest>` as a layout and drops the routes under it from the typed-routes Href union'
    ).toEqual([]);
  });

  it('reads the tabs layout from a file named exactly `_layout.tsx`', () => {
    const layouts = routeFiles(join(APP_DIR, '(app)', '(tabs)')).map(file =>
      relative(APP_DIR, file)
    );
    expect(layouts).toContain('(app)/(tabs)/_layout.tsx');
  });
});
