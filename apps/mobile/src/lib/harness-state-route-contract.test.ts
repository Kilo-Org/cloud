// Source guard for harness-only routes.
//
// A harness start state deep-links a raw path: `state.sh` reaches it with
// `session.sh open <device> <route>` and no `--email`, so the state's `route`
// must be a product path, never a bare command name (runbook/sessions.md:
// without `--email` the route is a raw `kiloapp://` path, not a name from the
// dev command's table). The `settings` state had shipped the bare name
// `settings`, which resolves to `kiloapp://settings`; no product surface emits
// that link, and the repair points the state at the real `/profile/preferences`
// path. A `(app)/settings.tsx` alias had been added so the bad link resolved —
// a route whose only trigger is the harness is verification-only runtime
// support and must not come back. This guard reads the two things the contract
// has to agree with: the product route tree (`src/app`) and the universal-link
// table the app resolves links through.
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { webPathToAppPath } from '@kilocode/app-shared/universal-links';
import { describe, expect, it } from 'vitest';

const appDir = fileURLToPath(new URL('../app', import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return routeFiles(full);
    }
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [full] : [];
  });
}

const routes = routeFiles(appDir);

describe('harness start-state route contract', () => {
  it('finds the product route tree it guards', () => {
    // A walk that silently found nothing would make the assertions below pass
    // vacuously.
    expect(routes.length).toBeGreaterThan(50);
  });

  it('ships no route that exists only for a harness start state', () => {
    // `/settings` names no product screen (system-search-route.test.ts and
    // system-search-entries.test.ts record it), so a route file for it has no
    // caller but the retired harness link.
    const harnessOnly = routes.filter(file => file.endsWith('/(app)/settings.tsx'));
    expect(harnessOnly).toEqual([]);
  });

  it('resolves the path the settings start state deep-links to', () => {
    // The state carries `/profile/preferences`: the table must map exactly that
    // path and the screen it maps to must exist in the tree.
    const appPath = webPathToAppPath('/profile/preferences');
    expect(appPath).toBe('/(app)/(tabs)/(3_profile)/preferences');
    expect(routes).toContain(`${appDir}/(app)/(tabs)/(3_profile)/preferences.tsx`);
    // The retired bare link stays unmapped.
    expect(webPathToAppPath('/settings')).toBeNull();
  });
});
