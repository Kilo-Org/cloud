/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PLACEHOLDER = '__KILO_WIDGET_LOGO_URI__';
const LAYOUT_FILES = ['active-agents-live-activity.tsx', 'active-agents-widget.tsx'];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/**
 * The `'widget'` layouts are stringified by Babel and re-evaluated inside the
 * widget process, where an imported binding is an undefined global that throws
 * and blanks the whole surface. So the placeholder must appear as a literal in
 * each layout source, never as the imported `WIDGET_LOGO_PLACEHOLDER`
 * identifier. These assertions read the sources because no widget transform
 * runs under vitest.
 */
describe('widget logo placeholder', () => {
  it('matches the token widget-logo.ts replaces', () => {
    expect(read('widget-logo.ts')).toContain(`= '${PLACEHOLDER}'`);
  });

  for (const file of LAYOUT_FILES) {
    it(`is a literal in ${file}`, () => {
      const source = read(file);
      expect(source).toContain(`= '${PLACEHOLDER}'`);
      expect(source).not.toContain('logoUri = WIDGET_LOGO_PLACEHOLDER');
    });
  }
});
