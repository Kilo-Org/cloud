import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

import { changedDependencyWorkspaces } from './changed-dependencies.mjs';

function snapshot() {
  return {
    workspace: { packages: ['apps/*', 'packages/*'], autoInstallPeers: false },
    patches: {},
    lockfile: {
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: false },
      importers: {
        '.': { devDependencies: { lint: { specifier: '1.0.0', version: '1.0.0' } } },
        'apps/mobile': { dependencies: { router: { specifier: '1.0.0', version: '1.0.0' } } },
        'apps/extension': {
          dependencies: {
            shared: { specifier: 'workspace:*', version: 'link:../../packages/shared' },
          },
          devDependencies: { bundler: { specifier: '1.0.0', version: '1.0.0' } },
        },
        'packages/shared': { dependencies: { parser: { specifier: '1.0.0', version: '1.0.0' } } },
      },
      packages: {
        'lint@1.0.0': { resolution: { integrity: 'lint-integrity' } },
        'router@1.0.0': { resolution: { integrity: 'router-integrity' } },
        'bundler@1.0.0': { resolution: { integrity: 'bundler-integrity' } },
        'parser@1.0.0': { resolution: { integrity: 'parser-integrity' } },
        'leaf@1.0.0': { resolution: { integrity: 'leaf-integrity' } },
        'leaf@2.0.0': { resolution: { integrity: 'other-leaf-integrity' } },
      },
      snapshots: {
        'lint@1.0.0': {},
        'router@1.0.0': {},
        'bundler@1.0.0': { dependencies: { leaf: '1.0.0' } },
        'parser@1.0.0': {},
        'leaf@1.0.0': {},
        'leaf@2.0.0': {},
      },
    },
  };
}

function addPatch(value, name, hash, content) {
  const selector = `${name}@1.0.0`;
  const path = `patches/${selector}.patch`;
  value.workspace.patchedDependencies = { [selector]: path };
  value.lockfile.patchedDependencies = { [selector]: hash };
  value.patches[path] = content;
}

test('unchanged dependencies select no workspace', () => {
  assert.deepEqual(changedDependencyWorkspaces(snapshot(), snapshot()), []);
});

test('a mobile router patch does not select the extension', () => {
  const before = snapshot();
  const after = snapshot();
  addPatch(after, 'router', 'new-hash', 'router lifecycle fix');
  after.lockfile.importers['apps/mobile'].dependencies.router.version =
    '1.0.0(patch_hash=new-hash)';
  after.lockfile.snapshots['router@1.0.0(patch_hash=new-hash)'] = {};
  delete after.lockfile.snapshots['router@1.0.0'];

  assert.deepEqual(changedDependencyWorkspaces(before, after), ['apps/mobile']);
  assert.deepEqual(changedDependencyWorkspaces(after, before), ['apps/mobile']);
});

test('a transitive development dependency change selects the extension', () => {
  const after = snapshot();
  after.lockfile.snapshots['bundler@1.0.0'].dependencies.leaf = '2.0.0';

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['apps/extension']);
});

test('an optional dependency change selects its consumer', () => {
  const after = snapshot();
  after.lockfile.snapshots['router@1.0.0'].optionalDependencies = { leaf: '2.0.0' };

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['apps/mobile']);
});

test('an integrity change selects the workspace and its transitive consumers', () => {
  const after = snapshot();
  after.lockfile.packages['parser@1.0.0'].resolution.integrity = 'updated-integrity';

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), [
    'apps/extension',
    'packages/shared',
  ]);
});

test('a root tool dependency change selects all workspaces', () => {
  const after = snapshot();
  after.lockfile.packages['lint@1.0.0'].resolution.integrity = 'updated-integrity';

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['*']);
});

test('an unused catalog or override change does not select the extension', () => {
  const after = snapshot();
  after.workspace.catalog = { router: '1.0.0' };
  after.workspace.overrides = { router: '1.0.0' };
  after.lockfile.catalogs = { default: { router: { specifier: '1.0.0', version: '1.0.0' } } };
  after.lockfile.overrides = { router: '1.0.0' };

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), []);
});

test('a workspace installation policy change selects all workspaces', () => {
  const after = snapshot();
  after.workspace.autoInstallPeers = true;

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['*']);
});

test('a lockfile setting change selects all workspaces', () => {
  const after = snapshot();
  after.lockfile.settings.autoInstallPeers = true;

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['*']);
});

test('a patch content change selects consumers even when the lock hash is unchanged', () => {
  const before = snapshot();
  const after = snapshot();
  addPatch(before, 'parser', 'same-hash', 'before');
  addPatch(after, 'parser', 'same-hash', 'after');

  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/extension',
    'packages/shared',
  ]);
});

test('dependency cycles do not prevent change detection', () => {
  const before = snapshot();
  before.lockfile.snapshots['parser@1.0.0'].dependencies = { leaf: '1.0.0' };
  before.lockfile.snapshots['leaf@1.0.0'].dependencies = { parser: '1.0.0' };
  const after = structuredClone(before);
  after.lockfile.packages['leaf@1.0.0'].resolution.integrity = 'updated-integrity';

  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/extension',
    'packages/shared',
  ]);
});

test('aliased packages use the resolved package identity', () => {
  const before = snapshot();
  before.lockfile.importers['packages/shared'].dependencies.parser.version = 'leaf@1.0.0';
  const after = structuredClone(before);
  after.lockfile.importers['packages/shared'].dependencies.parser.version = 'leaf@2.0.0';

  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/extension',
    'packages/shared',
  ]);
});

test('new and deleted importers are selected', () => {
  const after = snapshot();
  after.lockfile.importers['apps/new'] = {};

  assert.deepEqual(changedDependencyWorkspaces(snapshot(), after), ['apps/new']);
  assert.deepEqual(changedDependencyWorkspaces(after, snapshot()), ['apps/new']);
});

test('injected workspace snapshots resolve links from the repository root', () => {
  const before = snapshot();
  before.lockfile.importers['apps/mobile'].dependencies.copied = {
    version: 'file:packages/copied',
  };
  before.lockfile.packages['copied@file:packages/copied'] = {
    resolution: { directory: 'packages/copied', type: 'directory' },
  };
  before.lockfile.snapshots['copied@file:packages/copied'] = {
    dependencies: { shared: 'link:packages/shared' },
  };
  const after = structuredClone(before);
  after.lockfile.packages['parser@1.0.0'].resolution.integrity = 'updated-integrity';

  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/mobile',
    'apps/extension',
    'packages/shared',
  ]);
});

test('resolved optional peers remain part of their consumer graph', () => {
  const before = snapshot();
  before.lockfile.packages['parser@1.0.0'].peerDependenciesMeta = { router: { optional: true } };
  before.lockfile.snapshots['parser@1.0.0'].optionalDependencies = { router: '1.0.0' };
  const after = structuredClone(before);
  after.lockfile.packages['router@1.0.0'].resolution.integrity = 'updated-integrity';

  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/mobile',
    'apps/extension',
    'packages/shared',
  ]);
});

test('native-only patches do not affect web consumers through optional peers', () => {
  const before = snapshot();
  before.lockfile.importers['apps/mobile'].dependencies['react-native'] = { version: '1.0.0' };
  before.lockfile.packages['react-native@1.0.0'] = {};
  before.lockfile.packages['router@1.0.0'].peerDependencies = { 'react-native': '*' };
  before.lockfile.snapshots['react-native@1.0.0'] = {};
  before.lockfile.packages['parser@1.0.0'].peerDependenciesMeta = { router: { optional: true } };
  before.lockfile.snapshots['parser@1.0.0'].optionalDependencies = { router: '1.0.0' };
  const after = structuredClone(before);
  const nativePatch = [
    'diff --git a/useLinking.native.js b/useLinking.native.js',
    '--- a/useLinking.native.js',
    '+++ b/useLinking.native.js',
    '',
  ].join('\n');
  addPatch(after, 'router', 'new-hash', nativePatch);
  after.lockfile.importers['apps/mobile'].dependencies.router.version =
    '1.0.0(patch_hash=new-hash)';
  after.lockfile.snapshots['parser@1.0.0'].optionalDependencies.router =
    '1.0.0(patch_hash=new-hash)';
  after.lockfile.snapshots['router@1.0.0(patch_hash=new-hash)'] = {};
  delete after.lockfile.snapshots['router@1.0.0'];

  assert.deepEqual(changedDependencyWorkspaces(before, after), ['apps/mobile']);
  assert.deepEqual(changedDependencyWorkspaces(after, before), ['apps/mobile']);

  after.patches['patches/router@1.0.0.patch'] += '--- a/useLinking.js\n+++ b/useLinking.js\n';
  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/mobile',
    'apps/extension',
    'packages/shared',
  ]);

  after.patches['patches/router@1.0.0.patch'] =
    nativePatch + 'diff --git a/useLinking.js b/useLinking.js\n';
  assert.deepEqual(changedDependencyWorkspaces(before, after), [
    'apps/mobile',
    'apps/extension',
    'packages/shared',
  ]);
});

test('an unsupported lockfile cannot silently skip tests', () => {
  const after = snapshot();
  after.lockfile.lockfileVersion = '10.0';

  assert.throws(() => changedDependencyWorkspaces(snapshot(), after), /Unsupported pnpm lockfile/);
});

test('a missing dependency cannot silently skip tests', () => {
  const after = snapshot();
  delete after.lockfile.snapshots['leaf@1.0.0'];

  assert.throws(() => changedDependencyWorkspaces(snapshot(), after), /Missing lockfile entry/);
});

function readWorkflow(file) {
  return load(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
}

function matchesPatterns(value, patterns) {
  return patterns.some(pattern => posix.matchesGlob(value, pattern));
}

function admitsEvent(event, branch, path) {
  return (
    event !== undefined &&
    (!event?.branches || matchesPatterns(branch, event.branches)) &&
    (!event?.['branches-ignore'] || !matchesPatterns(branch, event['branches-ignore'])) &&
    (!event?.paths || matchesPatterns(path, event.paths)) &&
    (!event?.['paths-ignore'] || !matchesPatterns(path, event['paths-ignore']))
  );
}

for (const [file, paths, filterName] of [
  ['ci.yml', ['apps/web/src/routers/active-sessions-router.ts'], 'kilocode_backend'],
  [
    'kilo-app-ci.yml',
    [
      'apps/mobile/src/app/index.tsx',
      'packages/trpc/src/mobile.ts',
      'apps/web/src/routers/active-sessions-router.ts',
    ],
  ],
  [
    'extension-ci.yml',
    [
      'apps/extension/tests/e2e/agents-fixture.ts',
      'apps/web/src/routers/active-sessions-router.ts',
    ],
    'extension',
  ],
]) {
  test(`${file} admits main and stack PRs, keeps main-only pushes and relevant paths`, () => {
    const workflow = readWorkflow(file);
    for (const branch of ['main', 'mobile-ux-ad6d-s1', 'mobile-ux-ad6d-s5', 'feature/other']) {
      for (const path of paths) {
        assert.equal(
          admitsEvent(workflow.on.pull_request, branch, path),
          true,
          `PR ${branch}: ${path}`
        );
        assert.equal(
          admitsEvent(workflow.on.push, branch, path),
          branch === 'main',
          `push ${branch}: ${path}`
        );
      }
    }
    if (filterName) {
      const step = workflow.jobs.changes.steps.find(step => step.id === 'filter');
      const patterns = load(step.with.filters)[filterName];
      for (const path of paths) assert.equal(matchesPatterns(path, patterns), true, path);
      assert.equal(matchesPatterns('docs/unrelated.md', patterns), false);
    } else {
      assert.equal(
        admitsEvent(workflow.on.pull_request, 'mobile-ux-ad6d-s1', 'docs/unrelated.md'),
        false
      );
      assert.equal(admitsEvent(workflow.on.push, 'main', 'docs/unrelated.md'), false);
      assert.ok(Object.hasOwn(workflow.on, 'workflow_call'));
    }
  });
}

test('the ingest workspace runs only the explicit native attachment regression', () => {
  const workflow = readWorkflow('ci.yml');
  const path = 'services/session-ingest/test/integration/user-connection-attachment.test.ts';
  assert.equal(admitsEvent(workflow.on.pull_request, 'mobile-ux-ad6d-s1', path), true);
  const step = workflow.jobs['workspace-tests'].steps.find(step =>
    step.run?.includes('test:integration')
  );
  assert.equal(step?.if, "matrix.workspace.name == 'cloudflare-session-ingest'");
  assert.equal(
    step?.run,
    'pnpm --filter cloudflare-session-ingest run test:integration test/integration/user-connection-attachment.test.ts'
  );
});
