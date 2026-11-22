/* eslint-disable eslint-plugin-import/no-nodejs-modules -- this test reads the app's navigation call sites from disk, the only place the swap contract is observable without rendering every screen */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A screen handoff that swaps the focused native-stack screen must not use a
 * literal `router.replace`. One commit removes the old screen and inserts the
 * new one, react-native-screens reparents a view the outgoing screen still owns
 * during it, and Android Fabric throws `addViewAt: failed to insert view [...]
 * The specified child already has a parent`.
 *
 * The safe shapes are `useStackSafeReplace()` (push, then retire the source on
 * that push's own transition end) and `useSettledReplace()` (one replace
 * dispatched only once the navigator has settled). Either way the file imports
 * the hook, so the check is: a file with a literal `router.replace(` must also
 * import one of them, unless it is allowlisted below with its reason.
 *
 * The hooks' own mechanics live in `stack-safe-replace.mounted.test.tsx` and
 * `settled-replace.mounted.test.tsx`.
 */

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Files that may keep a literal `router.replace`, and why. Everything else in
 * `apps/mobile/src` that swaps the focused screen goes through a hook.
 */
const ALLOWED: Record<string, string> = {
  // The root layout renders a `Slot`, so its redirects swap whole route groups
  // ((app) vs (auth)) rather than one screen for another. Pushing first would
  // mount the other group's tree beside the current one.
  'src/app/_layout.tsx': 'root group redirect over the Slot',
  // Reopens the route that was open before an RTL reload, from the app root,
  // outside any screen's stack.
  'src/lib/hooks/use-language-startup-preparation.ts': 'root-level RTL reload return',
  // Reached from `+native-intent` before any route is mounted, so no navigator
  // screen owns the swap.
  'src/lib/pr-review/pr-review-copy-fixture-route.ts': 'dev link handled outside a navigator',
  'src/lib/pr-review/pr-review-instance-fixture.ts': 'dev link handled outside a navigator',
  // A helper, not a screen: every caller passes the stack-safe router in.
  'src/components/agents/session-detail-routes.ts': 'helper; callers pass the stack-safe router',
  // The one deliberate single-commit swap: it dispatches only after the
  // navigator has settled, which is the safe shape for a route-guard bounce.
  'src/lib/navigation/settled-replace.ts': 'the settle-then-swap hook itself',
};

/** The hooks a swapping file may use, matched by their import specifier. */
const SAFE_HOOKS = [
  "from '@/lib/navigation/stack-safe-replace'",
  "from '@/lib/navigation/settled-replace'",
];

function sourceFiles(): string[] {
  return readdirSync(join(APP_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map(path => join('src', path))
    .filter(path => /\.(ts|tsx)$/.test(path))
    .filter(path => !/\.test\.(ts|tsx)$/.test(path));
}

describe('navigation swap contract', () => {
  it('no file swaps the focused screen with a literal router.replace', () => {
    const offenders = sourceFiles()
      .filter(path => !(path in ALLOWED))
      .filter(path => {
        const source = readFileSync(join(APP_ROOT, path), 'utf8');
        if (!source.includes('router.replace(')) {
          return false;
        }
        return !SAFE_HOOKS.some(specifier => source.includes(specifier));
      });
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still exists and records its reason', () => {
    const files = sourceFiles();
    for (const [path, reason] of Object.entries(ALLOWED)) {
      expect(files, path).toContain(path);
      expect(reason.length, path).toBeGreaterThan(0);
    }
  });

  it('the settle hook waits for the navigator and never dispatches after unmount', () => {
    const settled = readFileSync(join(APP_ROOT, 'src/lib/navigation/settled-replace.ts'), 'utf8');
    expect(settled).toContain("addListener('transitionEnd'");
    expect(settled).toContain('setTimeout(dispatchQueued, 0)');
    expect(settled).toContain('clearTimeout(timerRef.current)');
  });
});
