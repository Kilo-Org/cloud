import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

for (const cachingDisabled of [undefined, false, true]) {
  test(`requires reviewed cache-disabled Hyperdrive metadata: ${String(cachingDisabled)}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-sync-renderer-'));
    try {
      mkdirSync(join(directory, 'scripts'));
      copyFileSync(
        join(root, 'scripts/render-staging-config.mjs'),
        join(directory, 'scripts/render-staging-config.mjs')
      );
      copyFileSync(join(root, 'wrangler.jsonc'), join(directory, 'wrangler.jsonc'));
      symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
      const manifest = {
        accountID: '0123456789abcdef0123456789abcdef',
        hyperdriveID: '123456789abcdef0123456789abcdef0',
        secretsStoreID: '23456789abcdef0123456789abcdef01',
        bucketName: 'session-sync-staging',
        verification: {
          hyperdriveDedicatedNonproduction: true,
          databaseSyntheticOnly: true,
          hyperdriveCachingDisabled: cachingDisabled,
          r2DedicatedAndPrivate: true,
          independentSigningSecrets: true,
          evidence: 'Synthetic offline renderer test; no real resources.',
        },
      };
      const manifestPath = join(directory, 'resources.json');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = spawnSync(
        process.execPath,
        [join(directory, 'scripts/render-staging-config.mjs'), manifestPath],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, cachingDisabled === true ? 0 : 1, result.stderr);
      if (cachingDisabled === true) {
        const config = JSON.parse(
          readFileSync(join(directory, '.wrangler/wrangler.staging.json'), 'utf8')
        );
        assert.deepEqual(config.hyperdrive, [{ binding: 'HYPERDRIVE', id: manifest.hyperdriveID }]);
        assert.equal(
          config.ratelimits.find(binding => binding.name === 'USER_DATA_BLOCK_LIMITER').simple
            .limit,
          120
        );
        assert.equal(new Set(config.ratelimits.map(binding => binding.namespace_id)).size, 5);
        assert.deepEqual(
          config.durable_objects.bindings.map(binding => binding.class_name),
          ['SessionSyncDO', 'SessionSyncTenantDO', 'SessionRelayDO', 'SessionPresenceDO']
        );
        assert.deepEqual(config.migrations.at(-1), {
          tag: 'v3',
          new_sqlite_classes: ['SessionRelayDO', 'SessionPresenceDO'],
        });
      } else {
        assert.match(result.stderr, /caching disabled/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
