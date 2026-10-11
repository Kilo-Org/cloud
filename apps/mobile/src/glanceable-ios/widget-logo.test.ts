/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withWidgetLogo } from './widget-logo';

vi.mock('expo-widgets', () => ({ widgetsDirectory: 'file:///group/ExpoWidgets/' }));

const MARK = '__KILO_WIDGET_LOGO_URI__';
const GLYPH = '__KILO_WIDGET_GLYPH_URI__';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/**
 * The `'widget'` layouts are stringified by Babel and re-evaluated inside the
 * widget process, where an imported binding is an undefined global that throws
 * and blanks the whole surface. So each placeholder must appear as a literal in
 * the layout source. These assertions read the sources because no widget
 * transform runs under vitest.
 */
describe('widget logo placeholders', () => {
  it('match the tokens widget-logo.ts replaces', () => {
    const source = read('widget-logo.ts');
    expect(source).toContain(`'${MARK}'`);
    expect(source).toContain(`'${GLYPH}'`);
  });

  it('are literals in each layout that draws them', () => {
    expect(read('active-agents-widget.tsx')).toContain(`= '${MARK}'`);
    expect(read('active-agents-widget.tsx')).toContain(`= '${GLYPH}'`);
    expect(read('active-agents-live-activity.tsx')).toContain(`= '${MARK}'`);
  });

  it('resolve to the app-group copies in a stringified layout', () => {
    expect(withWidgetLogo(`const a = '${MARK}'; const b = '${GLYPH}';`)).toBe(
      "const a = 'file:///group/ExpoWidgets/kilo-logo.png'; const b = 'file:///group/ExpoWidgets/kilo-logo-glyph.png';"
    );
  });
});
