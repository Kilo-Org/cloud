import assert from 'node:assert/strict';
import test from 'node:test';

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
