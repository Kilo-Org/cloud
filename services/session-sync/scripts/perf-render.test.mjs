import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { limiterConfig } from './perf-common.mjs';

for (const scenario of ['dedicated', 'shared-name', 'production-origin'])
  test(`renders an isolated config: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-load-render-'));
    const file = join(root, 'manifest.json');
    const manifest = {
      runID: 'render-check',
      accountID: 'e115e769bcdd4c3d66af59d3332cb394',
      workerName: 'session-sync-render-check-loadtest',
      r2Bucket: 'session-sync-render-check-loadtest',
      configFile: join(root, 'rendered.json'),
      syntheticDatabase: true,
      independentSigningSecrets: true,
      hyperdriveCaching: false,
      hyperdriveID: 'bb58259a7dd9454487b333b6b10dfafe',
      secretsStoreID: '342a86d9e3a94da698e82d0c6e2a36f0',
      secrets: ['NEXTAUTH_SECRET', 'SESSION_SYNC_SECRET', 'INTERNAL_API_SECRET_PROD'].map(
        binding => ({ binding, name: binding + '_RENDER_CHECK_STAGING_LOADTEST' })
      ),
    };
    if (scenario === 'shared-name') manifest.workerName = 'session-sync-loadtest';
    if (scenario === 'production-origin')
      manifest.hyperdriveID = '2dd5d842a72e432c96b83f8757585ddc';
    writeFileSync(file, JSON.stringify(manifest));
    try {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./perf-render.mjs', import.meta.url)), file],
        { encoding: 'utf8' }
      );
      if (scenario !== 'dedicated') assert.notEqual(child.status, 0);
      else {
        assert.equal(child.status, 0, child.stderr);
        const config = JSON.parse(readFileSync(manifest.configFile, 'utf8'));
        assert.equal(config.name, manifest.workerName);
        assert.deepEqual(config.ratelimits, limiterConfig(manifest.runID));
        assert.equal(config.routes, undefined);
        assert(
          config.secrets_store_secrets.every(row => row.secret_name.endsWith('_STAGING_LOADTEST'))
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
