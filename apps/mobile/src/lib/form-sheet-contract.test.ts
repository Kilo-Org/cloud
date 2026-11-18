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
import { join } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appDir = fileURLToPath(new URL('../app', import.meta.url));
// `fileURLToPath` keeps the trailing separator of `src/`; `join` below makes
// every walked path canonical so assertions can name a file.
const srcDir = fileURLToPath(new URL('..', import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return routeFiles(full);
    }
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [full] : [];
  });
}

/** Every bundled source file, so a guard can scan the app and not only routes. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    const bundled =
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.includes('.test.') &&
      !entry.name.endsWith('.d.ts');
    return bundled ? [full] : [];
  });
}

const routes = new Map(routeFiles(appDir).map(file => [file, readFileSync(file, 'utf8')]));
const sources = new Map(sourceFiles(srcDir).map(file => [file, readFileSync(file, 'utf8')]));

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

// A nested safe-area provider reports 0 for the frame a sheet header first
// lays out and the window inset once the surface presents, so a header that
// reserves the top edge from it moves by the status-bar height after it lands
// (51.8 dp on the PR review merge sheet). Sheet chrome takes its top clearance
// from `useSheetHeaderTopClearance`, which resolves the same value before the
// first frame — so no module that renders or decides a sheet header reserves
// the top edge by itself. A surface that is not sheet chrome (a full-screen
// route) may still apply its own top edge.
//
// TOP_EDGE_RESERVE matches an inline `edges={['top']}` and a named constant
// such as `HEADER_EDGES = ['top']`, the form the merge-sheet header used.
const TOP_EDGE_RESERVE = /EDGES\s*=\s*\[[^\]]*'top'|edges=\{[^\n]*\[[^\]]*'top'/;

describe('sheet header top clearance contract', () => {
  const SHEET_CHROME =
    /<\s*SheetHeader\b|PrFormSheetHeader|useSheetHeaderTopClearance|SheetHeaderTopInset/;
  const sheetChrome = [...sources.entries()].filter(([, source]) => SHEET_CHROME.test(source));

  it('finds the sheet chrome it guards', () => {
    const files = sheetChrome.map(([file]) => file);

    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain(
      fileURLToPath(new URL('../components/sheet-header.tsx', import.meta.url))
    );
    expect(files).toContain(
      fileURLToPath(new URL('../components/pr-review/pr-form-sheet-chrome.tsx', import.meta.url))
    );
  });

  it('never reserves the window top inset from a safe-area edge', () => {
    const topReserves = sheetChrome
      .filter(([, source]) => TOP_EDGE_RESERVE.test(source))
      .map(([file]) => file);

    expect(topReserves).toEqual([]);
  });

  it('reports a top-edge reserve when one is present', () => {
    expect(TOP_EDGE_RESERVE.test("const HEADER_SAFE_AREA_EDGES = ['top'] as const;")).toBe(true);
    expect(TOP_EDGE_RESERVE.test("<SafeAreaView edges={['top']}>")).toBe(true);
    expect(TOP_EDGE_RESERVE.test("<SafeAreaView edges={['bottom']} />")).toBe(false);
  });
});
