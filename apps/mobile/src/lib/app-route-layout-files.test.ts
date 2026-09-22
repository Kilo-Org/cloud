// Source guard for the "a colocated test must not take the `_layout` name"
// class: Expo Router decides a file is a layout from the FIRST dot-segment of
// its name (`getFileMeta` in expo-router/build/getRoutesCore.js:
// `filenameParts[0] === '_layout'`), so a colocated test named
// `_layout.<anything>.tsx` registers as that directory's layout. The typed-routes
// generator then reports the test file as the layout node and drops every route
// under it from the generated `Href` union — `(tabs)/_layout.mounted.test.tsx`
// silently removed all 222 tab hrefs. `metro.config.js` keeps `*.test.*` out of
// the bundle, but the generator scans the filesystem, so it still sees them.
// The same rule also matches the platform-variant layouts Expo Router must read
// (`_layout.ios.tsx`, `_layout.android.tsx`, `_layout.web.tsx`,
// `_layout.native.tsx`), so the guard flags only names that carry a vitest
// test/spec segment.
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

/**
 * Whether Expo Router reads the file name as a directory layout: it compares
 * the FIRST dot-segment to `_layout` after stripping the file extension.
 * `_layout.tsx`, `_layout.ios.tsx` and `_layout.test.tsx` all match, which is
 * why the guard below needs the test check too.
 */
function isLayoutName(name: string): boolean {
  return name.split('.')[0] === '_layout';
}

/**
 * Whether the file name carries a vitest test/spec segment. Only these names
 * are the colocated-test shadow this guard targets: `_layout.ios.tsx`,
 * `_layout.android.tsx`, `_layout.web.tsx` and `_layout.native.tsx` are the
 * directory's platform-variant layouts and Expo Router must read them.
 */
function isTestName(name: string): boolean {
  return name
    .split('.')
    .some((segment, index) => index > 0 && (segment === 'test' || segment === 'spec'));
}

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
        return isLayoutName(name) && isTestName(name);
      });
    expect(
      shadows,
      'rename the test: expo-router reads `_layout.<rest>` as a layout and drops the routes under it from the typed-routes Href union'
    ).toEqual([]);
  });

  it('accepts the platform-variant layouts Expo Router also reads as this directory layout', () => {
    for (const name of [
      '_layout',
      '_layout.ios',
      '_layout.android',
      '_layout.web',
      '_layout.native',
    ]) {
      expect(isLayoutName(name), name).toBe(true);
      expect(isTestName(name), name).toBe(false);
    }
    // A test shadow is only a test shadow when a test/spec segment is present,
    // so a platform-variant test is still caught.
    for (const name of [
      '_layout.test',
      '_layout.mounted.test',
      '_layout.spec',
      '_layout.ios.test',
    ]) {
      expect(isTestName(name), name).toBe(true);
    }
  });

  it('reads the tabs layout from a file named exactly `_layout.tsx`', () => {
    const layouts = routeFiles(join(APP_DIR, '(app)', '(tabs)')).map(file =>
      relative(APP_DIR, file)
    );
    expect(layouts).toContain('(app)/(tabs)/_layout.tsx');
  });
});
