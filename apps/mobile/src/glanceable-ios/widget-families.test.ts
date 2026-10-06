/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the widget sources from disk, which is the only place the family contract is observable under vitest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { glanceableLayoutCopy } from './layout-copy';

const MOBILE_DIR = join(__dirname, '..', '..');

const read = (...segments: string[]) => readFileSync(join(...segments), 'utf8');

/**
 * The widget transform stringifies the layout, so nothing here can execute it:
 * the declared families and the large-card branch are only observable in the
 * sources. This is the same boundary `layout-copy.test.ts` reads.
 */
describe('ActiveAgentsWidget families', () => {
  it('declares systemLarge on the ActiveAgentsWidget entry', () => {
    const entry = /name: 'ActiveAgentsWidget'[\s\S]*?supportedFamilies: \[([\s\S]*?)\]/.exec(
      read(MOBILE_DIR, 'app.config.ts')
    );

    expect(entry?.[1]).toContain("'systemLarge'");
  });

  it('prefers the delayed copy over the newest result while the counts are stale', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');
    const footer = layout.slice(
      layout.indexOf('const newestResultBody'),
      layout.indexOf('const footerBody')
    );

    // `statusLine` is tested first, so a stale frame draws "Can't update now"
    // and never a relative time claiming freshness the snapshot has lost.
    expect(footer).toContain('if (statusLine !== null)');
    expect(footer.indexOf('statusLine')).toBeLessThan(footer.indexOf('newestResultKind'));
  });

  it('bakes the newestResult copy slot into the layout map', () => {
    expect(read(__dirname, 'layout-copy.ts')).toContain("i18n.t('glanceable.newestResult')");
    expect(glanceableLayoutCopy()).toHaveProperty('newestResult');
  });

  it('decodes raw app-group count rows instead of mapping them blindly', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');

    // A stale timeline written by another app version can carry a non-array or
    // a null row; mapping it threw and expo-widgets drew the red error box in
    // every family. The rows are decoded, and an unknown kind falls back to the
    // neutral idle mark instead of reading `.icon` off `undefined`.
    expect(layout).toContain('Array.isArray(props.countLines) ? props.countLines : []');
    expect(layout).toContain('const glyphFor = (kind: string | null | undefined)');
    expect(layout).toContain('Object.hasOwn(GLYPH, kind)');
    expect(layout).toContain('return GLYPH.idle;');
    // No raw lookup may reach `.icon`/`.color`: an unknown kind there is a
    // runtime `undefined` and the whole widget view falls into its red box.
    expect(layout).not.toContain('GLYPH[primaryKind');
    expect(layout).not.toContain('GLYPH[newestResultKind');
    expect(layout).not.toContain('GLYPH[line.kind');
  });
});
