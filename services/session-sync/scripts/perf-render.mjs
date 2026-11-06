import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { limiterConfig } from './perf-common.mjs';
import { assertManifestIdentity } from './perf-identity.mjs';

const [file] = process.argv.slice(2);
assert(file, 'Usage: perf-render.mjs verified-resource-manifest.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));
assertManifestIdentity(manifest);
assert(/^[a-z0-9-]{3,32}$/.test(manifest.runID));
assert.equal(manifest.accountID, 'e115e769bcdd4c3d66af59d3332cb394');
assert.equal(manifest.workerName, `session-sync-${manifest.runID}-loadtest`);
assert.equal(manifest.r2Bucket, manifest.workerName);
assert(
  manifest.syntheticDatabase &&
    manifest.independentSigningSecrets &&
    manifest.hyperdriveCaching === false
);
assert(/^[a-f0-9]{32}$/.test(manifest.hyperdriveID));
assert(
  !['624ec80650dd414199349f4e217ddb10', '2dd5d842a72e432c96b83f8757585ddc'].includes(
    manifest.hyperdriveID
  )
);
assert(/^[a-f0-9]{32}$/.test(manifest.secretsStoreID));
assert.equal(manifest.secrets.length, 3);
assert.equal(new Set(manifest.secrets.map(row => row.name)).size, 3);
assert(manifest.secrets.every(row => row.name.endsWith('_STAGING_LOADTEST')));
assert.deepEqual(manifest.secrets.map(row => row.binding).sort(), [
  'INTERNAL_API_SECRET_PROD',
  'NEXTAUTH_SECRET',
  'SESSION_SYNC_SECRET',
]);
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const source = parse(readFileSync(join(packageDir, 'wrangler.jsonc'), 'utf8'), errors, {
  allowTrailingComma: true,
});
assert.equal(errors.length, 0);
const config = {
  name: manifest.workerName,
  account_id: manifest.accountID,
  main: join(packageDir, 'src/index.ts'),
  compatibility_date: source.compatibility_date,
  compatibility_flags: source.compatibility_flags,
  rules: source.rules,
  migrations: source.migrations,
  workers_dev: true,
  preview_urls: false,
  logpush: true,
  observability: { enabled: false },
  vars: {
    ENVIRONMENT: 'staging',
    USER_TENANT_SESSIONS: source.vars.USER_TENANT_SESSIONS,
    USER_TENANT_BYTES: source.vars.USER_TENANT_BYTES,
    ORGANIZATION_TENANT_SESSIONS: source.vars.ORGANIZATION_TENANT_SESSIONS,
    ORGANIZATION_TENANT_BYTES: source.vars.ORGANIZATION_TENANT_BYTES,
  },
  ratelimits: limiterConfig(manifest.runID),
  analytics_engine_datasets: [
    {
      binding: 'SESSION_SYNC_METRICS',
      dataset: `session_sync_${manifest.runID.replaceAll('-', '_')}_loadtest_metrics`,
    },
  ],
  durable_objects: {
    bindings: source.durable_objects.bindings.map(({ name, class_name }) => ({ name, class_name })),
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: manifest.hyperdriveID }],
  r2_buckets: [{ binding: 'SESSION_SYNC_R2', bucket_name: manifest.r2Bucket }],
  secrets_store_secrets: manifest.secrets.map(row => ({
    binding: row.binding,
    secret_name: row.name,
    store_id: manifest.secretsStoreID,
  })),
};
mkdirSync(dirname(manifest.configFile), { recursive: true });
writeFileSync(manifest.configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log('Dedicated run config rendered; no resources created or deployed.');
