// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { existsSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isPickerRoutePath, PICKER_ROUTE_NAMES, PICKER_ROUTE_PATHS } from './picker-routes';

const APP = fileURLToPath(new URL('../app/(app)/', import.meta.url));

describe('picker route paths', () => {
  it('names a route file for every path', () => {
    for (const path of PICKER_ROUTE_PATHS) {
      expect(existsSync(`${APP}${path.slice(1)}.tsx`), `${path} has no route file`).toBe(true);
    }
  });

  it('matches the formSheet routes the app layout registers', () => {
    const layout = readFileSync(`${APP}_layout.tsx`, 'utf8');

    for (const name of PICKER_ROUTE_NAMES) {
      expect(layout, `${name} is missing from the layout`).toContain(`name="${name}"`);
    }
  });

  it('recognises only the picker paths', () => {
    expect(isPickerRoutePath('/agent-chat/repo-picker')).toBe(true);
    expect(isPickerRoutePath('/agent-chat/new')).toBe(false);
    expect(isPickerRoutePath('/agent-chat/repo-picker-preview')).toBe(false);
    expect(isPickerRoutePath(undefined)).toBe(false);
    expect(isPickerRoutePath(null)).toBe(false);
  });
});
