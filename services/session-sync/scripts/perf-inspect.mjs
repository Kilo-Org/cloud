import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  assertManifestIdentity,
  assertUnusedLimiters,
  inspectLive,
  inventory,
  listWorkerScripts,
  operatorAPI,
  resolveOperatorToken,
} from './perf-identity.mjs';
import { limiterConfig } from './perf-common.mjs';

const [mode, file] = process.argv.slice(2);
assert(
  ['absent', 'verify'].includes(mode) && file,
  'Usage: perf-inspect.mjs absent|verify target-manifest.json'
);
const manifest = JSON.parse(readFileSync(file, 'utf8'));
assertManifestIdentity(manifest);
assert(/^[a-f0-9]{32}$/.test(manifest.secretsStoreID), 'Secrets store ID');
const api = operatorAPI(() => resolveOperatorToken(manifest.wrangler));
const account = `/accounts/${manifest.accountID}`;
if (mode === 'absent') {
  const workers = await listWorkerScripts(api);
  const buckets = await inventory(api, `${account}/r2/buckets`, result => result.buckets);
  const hyperdrives = await inventory(api, `${account}/hyperdrive/configs`);
  const secrets = await inventory(
    api,
    `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`,
    result => (Array.isArray(result) ? result : result.secrets)
  );
  assert(!workers.some(row => row.id === manifest.workerName));
  assert(!buckets.some(row => row.name === manifest.r2Bucket));
  assert(!hyperdrives.some(row => row.name === manifest.workerName));
  assert(!secrets.some(row => manifest.secretNames.includes(row.name)));
  await assertUnusedLimiters(
    api,
    workers,
    limiterConfig(manifest.runID).map(row => row.namespace_id)
  );
  const proof = {
    runID: manifest.runID,
    workerName: manifest.workerName,
    checkedAt: Date.now(),
    workerAbsent: true,
    bucketAbsent: true,
    hyperdriveAbsent: true,
    secretsAbsent: true,
    limiterNamespacesUnused: true,
  };
  writeFileSync(manifest.preProvisionEvidenceFile, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log('Complete dedicated-name inventory absence verified; no resources changed.');
} else {
  const proof = await inspectLive(manifest, api);
  writeFileSync(manifest.evidenceFile, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(
    'Current deployment, exact bindings, private bucket, and database evidence verified; no resources changed.'
  );
}
