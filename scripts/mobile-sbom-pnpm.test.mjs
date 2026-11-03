import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readPnpmProductionClosure } from './mobile-sbom-pnpm.mjs';

// base64 of the 64-byte SHA-512 digest of `mobile-sbom-fixture`, with its hex.
const INTEGRITY_BASE64 =
  'xtZRIttu4MFKWQZM08IsyI6OJ2IasjPgvpEHEuGPXlj9xgIj7gEIJX+hkF/yC8ex7vaZjsjf7rIWYovyWHiITA==';
const INTEGRITY_HEX =
  'c6d65122db6ee0c14a59064cd3c22cc88e8e27621ab233e0be910712e18f5e58fdc60223ee0108257fa1905ff20bc7b1eef6998ec8dfeeb216628bf25878884c';

const LOCKFILE = `\
lockfileVersion: '9.0'
importers:
  apps/mobile:
    dependencies:
      prod-direct: 1.0.0
      '@scope/prod-peer':
        specifier: 2.0.0
        version: 2.0.0(peer-runtime@1.0.0)
      plain-string-direct: 4.0.0
      ghost-dep: 0.0.0
      'aliased-direct':
        specifier: npm:aliased-real@^3
        version: aliased-real@3.0.0
      'aliased-scoped':
        specifier: 'npm:@scope/aliased-pkg@^1'
        version: '@scope/aliased-pkg@1.5.0'
      '@kilocode/workspace-link':
        specifier: workspace:*
        version: link:../../packages/shared
      '@kilocode/workspace-file':
        specifier: workspace:*
        version: file:packages/injected(@tanstack/react-query@5.0.0)
    optionalDependencies:
      optional-direct: 7.0.0
    devDependencies:
      dev-only: 9.9.9
  packages/shared:
    dependencies:
      shared-dep: 5.0.0
  packages/injected:
    dependencies:
      injected-dep: 6.0.0
packages:
  'prod-direct@1.0.0':
    resolution: {integrity: 'sha512-${INTEGRITY_BASE64}'}
  'transitive@3.0.0':
    resolution: {integrity: 'sha512-${INTEGRITY_BASE64}'}
snapshots:
  'prod-direct@1.0.0':
    dependencies:
      transitive: 3.0.0
      aliased-sub: aliased-sub-real@2.5.0
  'aliased-sub-real@2.5.0':
    dependencies:
      alias-deep: 2.6.0
  'transitive@3.0.0':
    dependencies:
      deep: 8.0.0
  'deep@8.0.0': {}
  'alias-deep@2.6.0': {}
  'aliased-real@3.0.0': {}
  '@scope/aliased-pkg@1.5.0': {}
  '@scope/prod-peer@2.0.0(peer-runtime@1.0.0)': {}
  plain-string-direct@4.0.0: {}
  optional-direct@7.0.0: {}
  shared-dep@5.0.0: {}
  injected-dep@6.0.0: {}
`;

function withLockfile(contents, run) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-sbom-pnpm-'));
  try {
    const lockfilePath = join(dir, 'pnpm-lock.yaml');
    writeFileSync(lockfilePath, contents);
    return run(lockfilePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reads the app production closure from a synthesized lockfile', () => {
  withLockfile(LOCKFILE, lockfilePath => {
    const { components, counts, skipped } = readPnpmProductionClosure({ lockfilePath });
    const byName = new Map(components.map(component => [component.name, component]));

    for (const name of [
      'prod-direct',
      '@scope/prod-peer',
      'plain-string-direct',
      'optional-direct',
      'transitive',
      'deep',
      // Reached through a `link:` workspace importer and a `file:` one.
      'shared-dep',
      'injected-dep',
      // npm aliases resolve to the real package, not the alias name.
      'aliased-real',
      'aliased-sub-real',
      'alias-deep',
      '@scope/aliased-pkg',
    ]) {
      assert.ok(byName.has(name), `expected a component for ${name}`);
    }
    assert.equal(byName.has('dev-only'), false, 'devDependencies must not appear');
    assert.equal(byName.has('peer-runtime'), false, 'the peer suffix is not a dependency');
    assert.equal(byName.has('aliased-direct'), false, 'an npm alias name is not a component');
    assert.equal(byName.has('aliased-sub'), false, 'an npm alias name is not a component');
    assert.equal(byName.has('aliased-scoped'), false, 'an npm alias name is not a component');

    assert.equal(counts.direct, 9, 'eight production entries plus one optional');
    assert.equal(counts.resolved, components.length);

    assert.deepEqual(byName.get('prod-direct'), {
      ecosystem: 'npm',
      name: 'prod-direct',
      version: '1.0.0',
      purl: 'pkg:npm/prod-direct@1.0.0',
      hashes: [{ alg: 'SHA-512', content: INTEGRITY_HEX }],
    });
    assert.equal('hashes' in byName.get('deep'), false, 'no integrity means no hashes');

    const scoped = byName.get('@scope/prod-peer');
    assert.equal(scoped.version, '2.0.0', 'the peer suffix is stripped from the version');
    assert.equal(scoped.purl, 'pkg:npm/%40scope/prod-peer@2.0.0');

    // An alias value (`aliased-direct: aliased-real@3.0.0`) keys the snapshot
    // as the value itself and reports the real package.
    assert.deepEqual(byName.get('aliased-real'), {
      ecosystem: 'npm',
      name: 'aliased-real',
      version: '3.0.0',
      purl: 'pkg:npm/aliased-real@3.0.0',
    });
    assert.deepEqual(byName.get('@scope/aliased-pkg'), {
      ecosystem: 'npm',
      name: '@scope/aliased-pkg',
      version: '1.5.0',
      purl: 'pkg:npm/%40scope/aliased-pkg@1.5.0',
    });

    assert.deepEqual(
      components.map(component => component.name),
      [
        '@scope/aliased-pkg',
        '@scope/prod-peer',
        'alias-deep',
        'aliased-real',
        'aliased-sub-real',
        'deep',
        'injected-dep',
        'optional-direct',
        'plain-string-direct',
        'prod-direct',
        'shared-dep',
        'transitive',
      ],
      'components sort by name, then version'
    );
    assert.deepEqual(skipped, ['ghost-dep@0.0.0']);
  });
});

test('throws when the importer key is missing or not an object', () => {
  withLockfile(`lockfileVersion: '9.0'\n`, lockfilePath => {
    assert.throws(() => readPnpmProductionClosure({ lockfilePath }), /no importer apps\/mobile/);
  });
  withLockfile(
    `lockfileVersion: '9.0'\nimporters:\n  apps/web:\n    dependencies: {}\n`,
    lockfilePath => {
      assert.throws(() => readPnpmProductionClosure({ lockfilePath }), /no importer apps\/mobile/);
    }
  );
  withLockfile(
    `lockfileVersion: '9.0'\nimporters:\n  apps/mobile: not-an-object\n`,
    lockfilePath => {
      assert.throws(() => readPnpmProductionClosure({ lockfilePath }), /no importer apps\/mobile/);
    }
  );
});
