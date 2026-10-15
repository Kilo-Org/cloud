import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAffected } from './affected-workspaces.mjs';

const workspace = (name, dir, dependencies = {}) => ({ name, dir, manifest: { dependencies } });
const items = [
  workspace('@kilocode/db', 'packages/db'),
  workspace('@kilocode/trpc', 'packages/trpc', { '@kilocode/db': 'workspace:*' }),
  workspace('web', 'apps/web', { '@kilocode/db': 'workspace:*' }),
  workspace('kilo-app', 'apps/mobile', { '@kilocode/trpc': 'workspace:*' }),
  workspace('agent', 'services/agent'),
  workspace('agent-wrapper', 'services/agent/wrapper'),
  workspace('leaf', 'services/leaf'),
];
const references = [
  ['packages/trpc/src/index.ts', 'apps/web/src/routers/root-router'],
  ['apps/web/src/lib/preview.ts', 'services/agent/src/shared/preview'],
  ['services/leaf/vitest.config.ts', 'tools/shared'],
];
const select = (changedFiles, lockfileDirs = []) =>
  selectAffected({ items, changedFiles, lockfileDirs, references });

test('a leaf change selects only the leaf', () => {
  assert.deepEqual(select(['services/leaf/src/index.ts']), {
    full: false,
    reasons: [],
    dirs: ['services/leaf'],
    packages: ['leaf'],
    build: [],
  });
});

test('a change reaches workspace dependents and relative-import readers', () => {
  const { packages, build } = select(['packages/db/src/schema.ts']);
  assert.deepEqual(packages, ['@kilocode/db', '@kilocode/trpc', 'kilo-app', 'web']);
  assert.deepEqual(build, ['@kilocode/trpc']);
  assert.deepEqual(select(['services/agent/src/shared/preview.ts']).packages, [
    '@kilocode/trpc',
    'agent',
    'kilo-app',
    'web',
  ]);
});

test('a nested workspace change selects the workspace around it', () => {
  assert.deepEqual(select(['services/agent/wrapper/src/main.ts']).packages.slice(0, 2), [
    '@kilocode/trpc',
    'agent',
  ]);
});

test('a consumer of a built package needs that build without selecting it', () => {
  const { packages, build } = select(['apps/mobile/src/app.tsx']);
  assert.deepEqual(packages, ['kilo-app']);
  assert.deepEqual(build, ['@kilocode/trpc']);
});

test('documentation and unchecked root paths select nothing', () => {
  for (const file of [
    'README.md',
    'services/leaf/README.md',
    'docs/a.ts',
    '.github/workflows/deploy.yml',
    'dev/a.ts',
  ]) {
    assert.deepEqual(select([file]).dirs, [], file);
  }
});

test('a root path read by a workspace selects its reader', () => {
  assert.deepEqual(select(['tools/shared/setup.ts']).packages, ['leaf']);
  assert.deepEqual(select(['scripts/web-env/plan.ts']).packages, [
    '@kilocode/trpc',
    'kilo-app',
    'web',
  ]);
});

test('an unattributable or global change selects everything', () => {
  for (const file of [
    'package.json',
    'tsconfig.base.json',
    'unknown/file.ts',
    '.github/workflows/ci.yml',
    'scripts/lint-all.sh',
    'patches/a.patch',
  ]) {
    const result = select([file]);
    assert.equal(result.full, true, file);
    assert.equal(result.dirs.length, items.length, file);
  }
  assert.equal(select(['<no base revision>']).full, true);
});

test('lockfile changes select the workspaces whose dependencies changed', () => {
  assert.deepEqual(select(['pnpm-lock.yaml'], ['services/leaf']).packages, ['leaf']);
  assert.deepEqual(select(['pnpm-lock.yaml'], []).dirs, []);
  assert.equal(select(['pnpm-lock.yaml'], ['*']).full, true);
  assert.equal(select(['pnpm-lock.yaml'], ['.']).full, true);
});
