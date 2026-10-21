/* eslint-disable max-lines -- the plan truth table and the layout-reading drift guard share one harness */
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync, readFileSync, statSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { join } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FORM_SHEET_ROUTE_SUFFIXES, isFormSheetRoute } from '@/lib/form-sheet-routes';
import { planProfileTabPress } from '@/lib/tab-press';

const PROFILE_SEGMENTS = ['(app)', '(tabs)', '(3_profile)'];

describe('isFormSheetRoute', () => {
  it('matches the member limit sheet on its full path', () => {
    expect(isFormSheetRoute([...PROFILE_SEGMENTS, 'organization', 'member-limit'])).toBe(true);
  });

  it('matches a one-segment sheet route name exactly', () => {
    expect(isFormSheetRoute([...PROFILE_SEGMENTS, 'organization', 'invite-member'])).toBe(true);
  });

  it('does not match a plain screen whose name contains a sheet name', () => {
    // 'filter' must not match 'filters', and 'member-limit' must not match a
    // longer name that ends with the same text.
    expect(isFormSheetRoute([...PROFILE_SEGMENTS, 'organization', 'member-limits'])).toBe(false);
    expect(isFormSheetRoute([...PROFILE_SEGMENTS, 'organization', 'prefilter'])).toBe(false);
  });

  it('matches a dynamic sheet route by its pattern segments', () => {
    expect(
      isFormSheetRoute([...PROFILE_SEGMENTS, 'security-agent', '[scope]', 'dismiss', '[id]'])
    ).toBe(true);
  });

  it('does not match a plain dynamic route that shares the pattern leaf', () => {
    expect(
      isFormSheetRoute([...PROFILE_SEGMENTS, 'security-agent', '[scope]', 'findings', '[id]'])
    ).toBe(false);
  });

  it('does not match a shorter route than the suffix', () => {
    expect(isFormSheetRoute(['organization'])).toBe(false);
  });
});

describe('planProfileTabPress', () => {
  it('leaves a cross-tab press to the navigator', () => {
    expect(
      planProfileTabPress({
        profileFocused: false,
        segments: ['(app)', '(tabs)', '(0_home)'],
        profileStackIndex: 2,
      })
    ).toBe('leave');
  });

  it('resets to the root on a focused re-press over a plain screen', () => {
    expect(
      planProfileTabPress({
        profileFocused: true,
        segments: [...PROFILE_SEGMENTS, 'security-agent', '[scope]', 'settings', 'automation'],
        profileStackIndex: 1,
      })
    ).toBe('reset-to-root');
  });

  it('preserves a focused form sheet', () => {
    expect(
      planProfileTabPress({
        profileFocused: true,
        segments: [...PROFILE_SEGMENTS, 'organization', 'member-limit'],
        profileStackIndex: 1,
      })
    ).toBe('preserve');
  });

  it('preserves when the tab is already at its root', () => {
    expect(
      planProfileTabPress({
        profileFocused: true,
        segments: [...PROFILE_SEGMENTS],
        profileStackIndex: 0,
      })
    ).toBe('preserve');
  });

  it('treats a stack state without an index as nothing to reset', () => {
    expect(
      planProfileTabPress({
        profileFocused: true,
        segments: [...PROFILE_SEGMENTS, 'organization'],
        profileStackIndex: undefined,
      })
    ).toBe('preserve');
  });
});

describe('form sheet route declarations', () => {
  // FORM_SHEET_ROUTE_SUFFIXES in lib/form-sheet-routes.ts must name every
  // screen a layout presents with useFormSheetScreenOptions, or the tab layer
  // would reset a tab over a live sheet. Read the layouts and fail when a
  // declaration is missing.
  const appDir = fileURLToPath(new URL('../app', import.meta.url));

  function layoutFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        files.push(...layoutFiles(path));
      } else if (entry === '_layout.tsx') {
        files.push(path);
      }
    }
    return files;
  }

  function layoutRoutePattern(layout: string, name: string): string[] {
    // A layout declares its screens relative to its own directory, so the
    // registry match needs the directory's route segments too.
    const relative = layout.slice(appDir.length + 1, -'/_layout.tsx'.length);
    const dirs = relative === '' ? [] : relative.split('/');
    return [...dirs, ...name.split('/')];
  }

  function declaredSheetRoutes(layout: string, source: string): string[] {
    const names: string[] = [];
    // <Stack.Screen name="x" options={sheetOptions|searchSheetOptions|{...sheetOptions ...}} />
    for (const match of source.matchAll(/name="([^"]+)"[^>]*options=\{[^}]*[Ss]heet/g)) {
      if (match[1] !== undefined) {
        names.push(match[1]);
      }
    }
    return names.map(name => layoutRoutePattern(layout, name).join('/'));
  }

  it('names every declared sheet screen', () => {
    const missing: string[] = [];
    for (const layout of layoutFiles(appDir)) {
      const source = readFileSync(layout, 'utf8');
      for (const name of declaredSheetRoutes(layout, source)) {
        if (!isFormSheetRoute(name.split('/'))) {
          missing.push(`${layout}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the registry free of routes no layout declares', () => {
    const declaredRoutes: string[] = [];
    for (const layout of layoutFiles(appDir)) {
      declaredRoutes.push(...declaredSheetRoutes(layout, readFileSync(layout, 'utf8')));
    }
    const stale = FORM_SHEET_ROUTE_SUFFIXES.filter(suffix => {
      const key = suffix.join('/');
      return !declaredRoutes.some(route => route.endsWith(`/${key}`));
    }).map(suffix => suffix.join('/'));
    expect(stale).toEqual([]);
  });
});
