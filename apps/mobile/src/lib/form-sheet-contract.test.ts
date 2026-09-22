// Registration guard for formSheets.
//
// A formSheet that builds its own options leaves out
// `sheetShouldOverflowTopInset`, and Android then measures the detents against
// the height left after the top inset and lifts the sheet by the bottom system
// gesture inset on top of that: the sheet surface stops above the window
// bottom and the screen behind it shows through the strip under the sheet (the
// new-session screen's olive "Start session" button under the repo picker).
// `useFormSheetScreenOptions` is the one place that sets the flag, so sheet
// routes must spread it and never spell the options out themselves.
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

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

const routes = new Map(routeFiles(appDir).map(file => [file, readFileSync(file, 'utf8')]));

describe('formSheet registration contract', () => {
  it('finds the route tree it guards', () => {
    // A walk that silently found nothing would make the assertions below pass
    // vacuously.
    expect(routes.size).toBeGreaterThan(50);
    expect(
      [...routes.values()].filter(source => source.includes('useFormSheetScreenOptions')).length
    ).toBeGreaterThan(5);
  });

  it('never spells out formSheet options in a route', () => {
    const handRolled = [...routes.entries()]
      .filter(
        ([, source]) =>
          source.includes("presentation: 'formSheet'") ||
          source.includes('sheetShouldOverflowTopInset')
      )
      .map(([file]) => file);

    expect(handRolled).toEqual([]);
  });

  it('registers the new-session repo picker through the shared options', () => {
    const appLayout = [...routes.entries()].find(([file]) => file.endsWith('(app)/_layout.tsx'));

    expect(appLayout).toBeDefined();
    expect(appLayout?.[1]).toContain('useFormSheetScreenOptions');
    expect(appLayout?.[1]).toContain('name="agent-chat/repo-picker"');
  });
});
