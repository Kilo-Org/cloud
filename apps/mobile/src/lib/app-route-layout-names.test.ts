// Source guard for the typed-routes subtree drop. Expo Router calls a route
// file a layout when the part before its first dot is `_layout`
// (`getFileMeta`'s `isLayout = filenameParts[0] === '_layout'` in
// `getRoutesCore`), but the typed-routes generator only asks `getRoutes` to
// ignore `/_layout\.[tj]sx?$/` (`@expo/router-server`'s `generate.js`). Any
// other `_layout.<name>` file — a co-located `_layout.mounted.test.tsx`, say —
// is therefore collected as a *layout* route, and the declaration generator
// skips every non-`route` node that is not the root layout: the directory's
// whole subtree vanishes from `.expo/types/router.d.ts` and every `Href` under
// it stops typechecking. One such test under `(tabs)` hid all five tab routes
// and failed `pnpm typecheck` in 12 places. Metro's test blockList keeps the
// tests out of the runtime bundle, so the loss is silent until typecheck runs.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { basename, dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** The `_layout` names the typed-routes generator ignores. */
const IGNORED_LAYOUT_NAMES = new Set(['_layout.tsx', '_layout.ts', '_layout.jsx', '_layout.js']);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return routeFiles(full);
    }
    return /\.(tsx|ts|jsx|js)$/.test(entry.name) ? [relative(APP_ROOT, full)] : [];
  });
}

describe('app route layout names', () => {
  it('names no route file `_layout.<name>` except the ignored `_layout.<ext>`', () => {
    const offenders = routeFiles(APP_ROOT).filter(file => {
      const name = basename(file);
      return name.split('.')[0] === '_layout' && !IGNORED_LAYOUT_NAMES.has(name);
    });

    expect(
      offenders,
      'this file is collected as a layout and hides its directory from the generated typed routes; rename it (a `_layout-` prefix is not a layout)'
    ).toEqual([]);
  });
});
