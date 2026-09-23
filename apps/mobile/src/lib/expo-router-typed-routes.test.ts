// Source guard for the "a colocated test must not shadow its routes" class.
//
// Expo Router decides a file is a layout from the first dot-segment of its
// basename, not the exact basename (expo-router/build/getRoutesCore.js,
// `getFileMeta`: `removeSupportedExtensions(filename).split('.')[0] ===
// '_layout'`). The typed-routes generator only ignores the plain
// `_layout.tsx`/`_layout.ts` (its `ignore: [/_layout\.[tj]sx?$/]` in
// @expo/router-server/build/typed-routes/generate.js), so any other `_layout.*`
// file becomes the layout node for its directory. Its own `groupRouteNodes`
// then returns before recursing into a non-route node with a non-empty route,
// dropping every route in that directory from `.expo/types/router.d.ts`.
//
// This is exactly what `(app)/(tabs)/_layout.mounted.test.tsx` did: the whole
// `/(app)/(tabs)/...` subtree vanished from the generated types and every
// `router.replace('/(app)/(tabs)/(3_profile)')` failed the mobile typecheck
// (TS2345/TS2322/TS2367), while the app itself still worked because Metro's
// blockList keeps `*.test.tsx` out of the runtime bundle. The typed-routes
// scan has no such exclusion, so the fix is the file name.
//
// Platform-specific layouts (`_layout.ios.tsx`) do not shadow: the typed-routes
// scan runs with `platformRoutes: false`, which skips them.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { dirname, join } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** expo-router's `validPlatforms`, the extensions the typed-routes scan skips. */
const PLATFORM_EXTENSIONS = new Set(['android', 'ios', 'native', 'web']);

function routeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...routeFiles(path));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** The first dot-segment of a route file's basename, as `getFileMeta` reads it. */
function layoutKey(file: string): string[] {
  const basename = file.slice(file.lastIndexOf('/') + 1);
  return basename.replace(/(\+api)?\.[jt]sx?$/, '').split('.');
}

describe('Expo Router typed routes', () => {
  it('keeps the `_layout` basename for the plain layout files only', () => {
    const offenders = routeFiles(APP_DIR).filter(file => {
      const [head, second] = layoutKey(file);
      return head === '_layout' && second !== undefined && !PLATFORM_EXTENSIONS.has(second);
    });

    // `_layout.mounted.test.tsx` is not ignored as a layout and drops its whole
    // directory's routes from the generated types; a colocated test of a layout
    // has to be named without the `_layout` prefix (e.g. `tabs-layout.mounted.test.tsx`).
    expect(offenders).toEqual([]);
  });
});
