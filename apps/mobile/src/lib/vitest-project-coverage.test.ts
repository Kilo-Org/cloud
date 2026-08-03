// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { globSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import mountedConfig from '../../vitest.mounted.config';
import pureConfig from '../../vitest.pure.config';

// The root vitest config composes two projects with enumerated include globs.
// A test file matching neither glob is silently never executed. This guard
// evaluates the real include arrays from both configs against every
// test-looking file under src/ and fails on orphans or double-matches.

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

function matches(include: string[]): Set<string> {
  return new Set(globSync(include, { cwd: appRoot }));
}

describe('vitest project coverage', () => {
  const allTestFiles = matches(['src/**/*.test.ts', 'src/**/*.test.tsx']);
  const pure = matches(pureConfig.test?.include ?? []);
  const mounted = matches(mountedConfig.test?.include ?? []);

  it('sees the existing suites (glob cwd sanity)', () => {
    expect(allTestFiles.size).toBeGreaterThan(100);
    expect(pure.size).toBeGreaterThan(0);
    expect(mounted.size).toBeGreaterThan(0);
  });

  it('every test file is matched by a vitest project', () => {
    const orphans = [...allTestFiles]
      .filter(file => !pure.has(file) && !mounted.has(file))
      .toSorted();
    expect(
      orphans,
      `Test files matched by no vitest project include — they never run.\nAdd their directory to vitest.pure.config.ts (or name them *.mounted.test.tsx):\n${orphans.join('\n')}`
    ).toEqual([]);
  });

  it('no test file is matched by both projects', () => {
    const both = [...pure].filter(file => mounted.has(file)).toSorted();
    expect(
      both,
      `Test files matched by BOTH vitest projects — they would run twice:\n${both.join('\n')}`
    ).toEqual([]);
  });
});
