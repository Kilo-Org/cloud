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

  it('draws the newest result on the large card and keeps the smaller families', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');
    // From the footer's derivation through the large branch, up to the medium
    // branch that follows it.
    const large = layout.slice(
      layout.indexOf('const newestResultKind'),
      layout.indexOf('if (wide)')
    );

    expect(large).toContain("family === 'systemLarge'");
    expect(large).toContain('props.newestResultKind');
    expect(large).toContain('props.newestResultLabel');
    expect(large).toContain('props.newestResultAt');
    expect(large).toContain('dateStyle="relative"');
    // The mark at the top, the rows centred, the footer at the bottom. A
    // spacer between the rows and the footer reserves the lower third up
    // front, so a stale→happy swap cannot move the counts.
    expect(large).toContain('{systemRows}');
    expect(large).toContain('{newestResultFooter}');
    // The spacer the comment names sits between the two markers: asserting the
    // last spacer in the whole slice would also accept one from the footer body
    // or the mark row, so a deleted spacer here would still pass.
    expect(
      large.slice(large.indexOf('{systemRows}'), large.indexOf('{newestResultFooter}'))
    ).toContain('<Spacer />');
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
});
