// Source guard for the "a test beside a layout is not a layout" class.
//
// expo-router derives a route's name from the file name's first dot-segment:
// `getFileMeta` splits `_layout.mounted.test.tsx` into ['_layout', 'mounted',
// 'test'] and reads `_layout` as the route name, so the test registers as a
// second layout for its directory. `getRoutes` then conflicts on that layout
// and the whole subtree drops out of `.expo/types/router.d.ts` — every `Href`
// under it fails `pnpm typecheck` (explorer-10 gate, 2026-09-22: every
// `(app)/(tabs)/…` href).
//
// A test of a layout therefore names the screen it tests, not the file:
// `tabs-layout.mounted.test.tsx`, never `_layout.mounted.test.tsx`.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { basename, dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

const ROUTE_FILE = /\.[jt]sx?$/;

/** The route name expo-router reads: the first dot-segment after the extensions. */
function routeName(fileName: string): string {
  return fileName.replaceAll(/(\+api)?\.[jt]sx?$/g, '').split('.')[0] ?? '';
}

/** True when expo-router reads this file as a layout for its directory. */
function readsAsLayout(fileName: string): boolean {
  return routeName(fileName) === '_layout';
}

/** The one file allowed to carry the `_layout` route name. */
function isLayoutFile(fileName: string): boolean {
  return /^_layout\.[jt]sx?$/.test(fileName);
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return routeFiles(full);
    }
    return ROUTE_FILE.test(entry.name) ? [full] : [];
  });
}

describe('expo-router route file names', () => {
  it('reads a name beside a layout as `_layout`, the way expo-router does', () => {
    expect(readsAsLayout('_layout.tsx')).toBe(true);
    expect(readsAsLayout('_layout.mounted.test.tsx')).toBe(true);
    expect(readsAsLayout('tabs-layout.mounted.test.tsx')).toBe(false);
    expect(isLayoutFile('_layout.mounted.test.tsx')).toBe(false);
    expect(isLayoutFile('_layout.tsx')).toBe(true);
  });

  it('reserves the `_layout` route name for the real layout file', () => {
    const conflicts = routeFiles(APP)
      .map(file => ({ file, name: basename(file) }))
      .filter(({ name }) => readsAsLayout(name) && !isLayoutFile(name))
      .map(({ file }) => relative(APP, file));
    expect(
      conflicts,
      'a file beside a layout must not start its name with `_layout`, or expo-router treats it as a second layout and drops the subtree from the typed routes'
    ).toEqual([]);
  });
});
