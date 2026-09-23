// Source guard for the "_layout shadows its directory" class: Expo Router's
// typed-route generator reads every file whose name reduces to `_layout` as the
// directory's layout, and a layout node's whole subtree is dropped from
// `.expo/types/router.d.ts`. A test colocated as `_layout.mounted.test.tsx`
// therefore deleted every `(tabs)` href from the generated union and failed the
// app's typecheck. Only a real layout, which the generator ignores, may carry
// the prefix.
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** The layout file names the typed-route generator ignores. */
const REAL_LAYOUT = /^_layout\.(?:js|jsx|ts|tsx)$/;

function shadowingFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return shadowingFiles(full);
    }
    return entry.name.startsWith('_layout.') && !REAL_LAYOUT.test(entry.name) ? [full] : [];
  });
}

describe('typed-route layout guard', () => {
  it('keeps the `_layout` prefix for real layouts only', () => {
    expect(
      shadowingFiles(APP).map(file => relative(APP, file)),
      'a `_layout.<suffix>` file still collapses to `_layout`, so the typed-route generator reads it as the directory layout and drops every route under it from .expo/types/router.d.ts'
    ).toEqual([]);
  });
});
