import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dump, load } from 'js-yaml';

import { lockfileInput } from './build-key-inputs.mjs';

function repository(lockfile, workspace = { packages: ['apps/*', 'packages/*'] }) {
  const root = mkdtempSync(join(tmpdir(), 'build-key-inputs-'));
  writeFileSync(join(root, 'pnpm-lock.yaml'), dump(lockfile, { lineWidth: -1 }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), dump(workspace, { lineWidth: -1 }));
  return root;
}

function lockfile() {
  return {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: false },
    importers: {
      '.': { devDependencies: { lint: { specifier: '1.0.0', version: '1.0.0' } } },
      'apps/other': { dependencies: { router: { specifier: '1.0.0', version: '1.0.0' } } },
      'packages/harness-sdk': {
        dependencies: { effect: { specifier: '4.0.5', version: '4.0.5' } },
      },
      'packages/trpc': {
        dependencies: {
          '@kilocode/notifications': { specifier: 'workspace:*', version: 'link:../notifications' },
          '@trpc/server': { specifier: '11.19.0', version: '11.19.0' },
        },
      },
      'packages/notifications': {
        dependencies: { resend: { specifier: '1.0.0', version: '1.0.0' } },
      },
    },
    packages: {
      'lint@1.0.0': { resolution: { integrity: 'lint-integrity' } },
      'router@1.0.0': { resolution: { integrity: 'router-integrity' } },
      'router@2.0.0': { resolution: { integrity: 'router-2-integrity' } },
      'effect@4.0.5': { resolution: { integrity: 'effect-integrity' } },
      'resend@1.0.0': { resolution: { integrity: 'resend-integrity' } },
      '@trpc/server@11.19.0': { resolution: { integrity: 'trpc-integrity' } },
    },
    snapshots: {
      'lint@1.0.0': {},
      'router@1.0.0': {},
      'router@2.0.0': {},
      'effect@4.0.5': {},
      'resend@1.0.0': {},
      '@trpc/server@11.19.0': { dependencies: { lint: '1.0.0' } },
    },
  };
}

test('a dependency change in another workspace keeps the key', () => {
  const before = repository(lockfile());
  const changed = lockfile();
  changed.importers['apps/other'].dependencies.router = { specifier: '2.0.0', version: '2.0.0' };
  const after = repository(changed);

  assert.equal(
    lockfileInput(after, 'packages/harness-sdk'),
    lockfileInput(before, 'packages/harness-sdk')
  );
  assert.equal(lockfileInput(after, 'packages/trpc'), lockfileInput(before, 'packages/trpc'));
});

test("the package's own dependency change moves the key", () => {
  const before = repository(lockfile());
  const changed = lockfile();
  changed.importers['packages/harness-sdk'].dependencies.effect = {
    specifier: '4.0.6',
    version: '4.0.6',
  };
  changed.packages['effect@4.0.6'] = { resolution: { integrity: 'effect-4.0.6-integrity' } };
  changed.snapshots['effect@4.0.6'] = {};
  const after = repository(changed);

  assert.notEqual(
    lockfileInput(after, 'packages/harness-sdk'),
    lockfileInput(before, 'packages/harness-sdk')
  );
  assert.equal(lockfileInput(after, 'packages/trpc'), lockfileInput(before, 'packages/trpc'));
});

test("a linked workspace's dependency change moves the key", () => {
  const before = repository(lockfile());
  const changed = lockfile();
  changed.importers['packages/notifications'].dependencies.resend = {
    specifier: '1.1.0',
    version: '1.1.0',
  };
  changed.packages['resend@1.1.0'] = { resolution: { integrity: 'resend-1.1.0-integrity' } };
  changed.snapshots['resend@1.1.0'] = {};
  const after = repository(changed);

  assert.notEqual(lockfileInput(after, 'packages/trpc'), lockfileInput(before, 'packages/trpc'));
  assert.equal(
    lockfileInput(after, 'packages/harness-sdk'),
    lockfileInput(before, 'packages/harness-sdk')
  );
});

test('a patch content change in the closure moves the key without a lock hash change', () => {
  const patched = workspace => ({
    ...workspace,
    patchedDependencies: { 'effect@4.0.5': 'patches/effect@4.0.5.patch' },
  });
  const build = content => {
    const lock = lockfile();
    lock.patchedDependencies = { 'effect@4.0.5': 'effect-hash' };
    const root = repository(lock, patched({ packages: ['apps/*', 'packages/*'] }));
    mkdirSync(join(root, 'patches'), { recursive: true });
    writeFileSync(join(root, 'patches/effect@4.0.5.patch'), content);
    return root;
  };
  const before = build('first');
  const after = build('second');

  assert.notEqual(
    lockfileInput(after, 'packages/harness-sdk'),
    lockfileInput(before, 'packages/harness-sdk')
  );
  assert.equal(lockfileInput(after, 'packages/trpc'), lockfileInput(before, 'packages/trpc'));
});

test('an unsupported lockfile version falls back to the whole lockfile', () => {
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  try {
    const changed = lockfile();
    changed.lockfileVersion = '8.0';
    const before = repository(changed);
    const unrelated = lockfile();
    unrelated.lockfileVersion = '8.0';
    unrelated.importers['apps/other'].dependencies.router = {
      specifier: '2.0.0',
      version: '2.0.0',
    };
    const after = repository(unrelated);

    assert.notEqual(lockfileInput(after, 'packages/trpc'), lockfileInput(before, 'packages/trpc'));
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    errors.map(message => message.replace(/^Cannot hash .*: /, '')),
    ['Unsupported pnpm lockfile', 'Unsupported pnpm lockfile']
  );
});

test('the repository lockfile keys on its closures, and keeps them when an unrelated importer appears', () => {
  const root = mkdtempSync(join(tmpdir(), 'build-key-repo-'));
  cpSync(new URL('../pnpm-lock.yaml', import.meta.url), join(root, 'pnpm-lock.yaml'));
  cpSync(new URL('../pnpm-workspace.yaml', import.meta.url), join(root, 'pnpm-workspace.yaml'));
  cpSync(new URL('../patches', import.meta.url), join(root, 'patches'), { recursive: true });

  const before = lockfileInput(root, 'packages/harness-sdk');
  assert.ok(before.startsWith('closure\0'), 'the real lockfile must use its importer closure');

  const data = load(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  data.importers['apps/zzz-unrelated'] = {
    dependencies: { zod: { specifier: 'catalog:', version: '4.6.7' } },
  };
  writeFileSync(join(root, 'pnpm-lock.yaml'), dump(data, { lineWidth: -1 }));

  assert.equal(lockfileInput(root, 'packages/harness-sdk'), before);
});
