/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the widget sources from disk, which is the only place the family contract is observable under vitest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
});
