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
 * dispatched only once the navigator has settled). Either way the file binds
 * one of the hooks, so the check is: a file that dispatches `replace` on a
 * navigator must also bind one of them, unless it is allowlisted below with its
 * reason.
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
  // These two routes render directly under that root `Slot`, which is a plain
  // router navigator: it emits no transition start or end, so a push-then-retire
  // could never retire the source, and Back from the destination would return to
  // the dead route. `replace` leaves nothing beneath.
  'src/app/+not-found.tsx': 'root Slot route; no transition event to retire on',
  'src/app/security-agent-single-route-fixture.tsx':
    'root Slot route; no transition event to retire on',
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

/**
 * The bindings a swapping file may use. Matching the call, not the import, is
 * what makes this a contract: a file that imports one of the hooks and then
 * still swaps with a navigator fails.
 */
const SAFE_BINDINGS = ['= useStackSafeReplace(', '= useSettledReplace('];

/** A navigator object bound from `useRouter()` or `useNavigation()`. */
const NAVIGATOR_BINDING =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useRouter|useNavigation)\s*\(/g;

/** A `replace` member taken straight off one of those calls. */
const NAVIGATOR_DESTRUCTURE = /\{([^}]*)\}\s*=\s*(?:useRouter|useNavigation)\s*\(/g;

function escapeIdentifier(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The swap shapes in one file. An empty list means the file never dispatches a
 * navigator `replace`. Each entry names the shape so a failure says why.
 */
function swapShapes(source: string): string[] {
  const shapes: string[] = [];

  for (const match of source.matchAll(NAVIGATOR_BINDING)) {
    const name = match[1];
    // The lookbehind keeps a name that only appears as a property access out.
    if (name && new RegExp(`(?<![\\w$])${escapeIdentifier(name)}\\.replace\\(`).test(source)) {
      shapes.push(`\`${name}.replace(\``);
    }
  }

  for (const match of source.matchAll(NAVIGATOR_DESTRUCTURE)) {
    for (const member of (match[1] ?? '').split(',')) {
      const binding = /^replace(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(member.trim());
      if (binding) {
        const name = binding[1] ?? 'replace';
        // The lookbehind keeps `someOtherRouter.replace(` and a string's own
        // `.replace(` out: only a bare call of the destructured name counts.
        if (new RegExp(`(?<![.\\w$])${escapeIdentifier(name)}\\s*\\(`).test(source)) {
          shapes.push(`bare \`${name}(\` from a destructure`);
        }
      }
    }
  }

  if (source.includes('router.replace(') && !shapes.includes('`router.replace(`')) {
    shapes.push('`router.replace(`');
  }

  return shapes;
}

function findOffenders(): { path: string; shapes: string[] }[] {
  return sourceFiles()
    .filter(path => !(path in ALLOWED))
    .map(path => ({ path, source: readFileSync(join(APP_ROOT, path), 'utf8') }))
    .filter(({ source }) => !SAFE_BINDINGS.some(binding => source.includes(binding)))
    .map(({ path, source }) => ({ path, shapes: swapShapes(source) }))
    .filter(({ shapes }) => shapes.length > 0);
}

function sourceFiles(): string[] {
  return readdirSync(join(APP_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map(path => join('src', path))
    .filter(path => /\.(ts|tsx)$/.test(path))
    .filter(path => !/\.test\.(ts|tsx)$/.test(path));
}

describe('navigation swap contract', () => {
  it('no file swaps the focused screen with a navigator replace', () => {
    const offenders = findOffenders().map(({ path, shapes }) => `${path} (${shapes.join(', ')})`);
    expect(offenders).toEqual([]);
  });

  it('the swap check reads every binding shape', () => {
    expect(swapShapes("const { replace } = useRouter();\nreplace('/x');")).toEqual([
      'bare `replace(` from a destructure',
    ]);
    expect(swapShapes("const navigation = useNavigation();\nnavigation.replace('/x');")).toEqual([
      '`navigation.replace(`',
    ]);
    expect(swapShapes("const { back, replace: swap } = useNavigation();\nswap('/x');")).toEqual([
      'bare `swap(` from a destructure',
    ]);
    expect(swapShapes("const router = useRouter();\nrouter.replace('/x');")).toEqual([
      '`router.replace(`',
    ]);
    expect(swapShapes('stackSafeRouter.replace(href);\nhref.replace(a, b);')).toEqual([]);
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
