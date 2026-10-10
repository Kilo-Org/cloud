/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the fixture list lives outside src for shell loops, so it is read from disk */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GLANCEABLE_FIXTURES } from './fixture-catalog';

const LIST = JSON.parse(
  readFileSync(join(__dirname, '../../../scripts/glanceable-fixtures.json'), 'utf8')
) as { fixtures: { name: string; description: string }[] };

describe('glanceable fixture list', () => {
  it('matches the catalog name for name, in order', () => {
    expect(LIST.fixtures).toEqual(
      Object.entries(GLANCEABLE_FIXTURES).map(([name, fixture]) => ({
        name,
        description: fixture.description,
      }))
    );
  });
});
