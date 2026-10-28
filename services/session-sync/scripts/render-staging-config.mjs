import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'jsonc-parser';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = join(packageDir, '.wrangler', 'wrangler.staging.json');
const idPattern = /^[a-f0-9]{32}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireID(value, field) {
  requireValue(
    typeof value === 'string' && idPattern.test(value),
    `${field} must be a real Cloudflare resource ID`
  );
  requireValue(!/^(.)\1+$/.test(value), `${field} must not be a placeholder`);
}

try {
  requireValue(
    process.argv.length === 3 && Boolean(process.argv[2]),
    'Usage: node scripts/render-staging-config.mjs <verified-nonsecret-resource-manifest.json>'
  );
  const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const key of ['accountID', 'hyperdriveID', 'secretsStoreID']) {
    requireID(manifest[key], key);
  }
  requireValue(
    manifest.hyperdriveID !== '624ec80650dd414199349f4e217ddb10',
    'The session-ingest Hyperdrive is not an isolated session-sync staging database'
  );
  requireValue(
    manifest.bucketName === 'session-sync-staging',
    'bucketName must be the dedicated session-sync-staging bucket'
  );
  const verification = manifest.verification;
  requireValue(
    verification?.hyperdriveDedicatedNonproduction === true &&
      verification?.databaseSyntheticOnly === true &&
      verification?.r2DedicatedAndPrivate === true &&
      verification?.independentSigningSecrets === true,
    'Verify the actual Hyperdrive origin, synthetic-only database, private dedicated R2 bucket, and independent staging signing secrets before rendering (see README.md)'
  );
  requireValue(
    typeof verification.evidence === 'string' && verification.evidence.trim().length > 0,
    'verification.evidence must reference the reviewed nonsecret resource metadata and isolation evidence'
  );
  const errors = [];
  const source = parse(readFileSync(join(packageDir, 'wrangler.jsonc'), 'utf8'), errors, {
    allowTrailingComma: true,
  });
  requireValue(errors.length === 0, 'The source wrangler.jsonc is invalid');
  requireValue(
    source.main === 'src/index.ts' &&
      source.durable_objects?.bindings?.length === 1 &&
      source.durable_objects.bindings[0].name === 'SESSION_SYNC_DO' &&
      source.durable_objects.bindings[0].class_name === 'SessionSyncDO' &&
      !source.durable_objects.bindings[0].script_name &&
      !source.durable_objects.bindings[0].environment,
    'Review the staging renderer when the entrypoint or Durable Object bindings change'
  );
  // Select only service code/runtime settings. Never inherit local credentials,
  // resource bindings, routes, environments, or a future production service binding.
  const config = {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: 'session-sync-staging',
    account_id: manifest.accountID,
    main: '../src/index.ts',
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    rules: source.rules,
    observability: source.observability,
    workers_dev: true,
    preview_urls: false,
    vars: { ENVIRONMENT: 'staging' },
    durable_objects: {
      bindings: [{ name: 'SESSION_SYNC_DO', class_name: 'SessionSyncDO' }],
    },
    migrations: source.migrations,
    hyperdrive: [{ binding: 'HYPERDRIVE', id: manifest.hyperdriveID }],
    r2_buckets: [{ binding: 'SESSION_SYNC_R2', bucket_name: manifest.bucketName }],
    secrets_store_secrets: [
      {
        binding: 'NEXTAUTH_SECRET',
        store_id: manifest.secretsStoreID,
        secret_name: 'session-sync-staging-nextauth',
      },
      {
        binding: 'SESSION_SYNC_SECRET',
        store_id: manifest.secretsStoreID,
        secret_name: 'session-sync-staging-grants',
      },
    ],
  };
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    'Rendered .wrangler/wrangler.staging.json; no infrastructure was created or deployed.'
  );
} catch (error) {
  // Do not echo manifest values or parse errors containing input data.
  console.error(
    error instanceof SyntaxError ? 'Invalid staging resource manifest JSON' : error.message
  );
  process.exitCode = 1;
}
