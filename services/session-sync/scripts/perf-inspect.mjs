import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectLive, operatorAPI, resolveOperatorToken } from './perf-identity.mjs';
import { limiterConfig } from './perf-common.mjs';

const [mode, file] = process.argv.slice(2);
assert(
  ['absent', 'verify'].includes(mode) && file,
  'Usage: perf-inspect.mjs absent|verify target-manifest.json'
);
const manifest = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(manifest.accountID, 'e115e769bcdd4c3d66af59d3332cb394');
assert(/^[a-z0-9-]{3,32}$/.test(manifest.runID));
assert.equal(manifest.workerName, `session-sync-${manifest.runID}-loadtest`);
assert.equal(manifest.r2Bucket, manifest.workerName);
const api = operatorAPI(() => resolveOperatorToken(manifest.wrangler));
async function inventory(path, rows) {
  const found = [];
  let cursor;
  for (let page = 1; page <= 100; page++) {
    const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : `per_page=100&page=${page}`;
    const response = await api('GET', `${path}?${query}`);
    const values = rows(response.result);
    assert(Array.isArray(values), 'Inventory response schema changed');
    found.push(...values);
    cursor = response.result?.cursor ?? response.result_info?.cursor;
    if (cursor) continue;
    if (response.result_info?.total_count !== undefined) {
      if (found.length >= response.result_info.total_count) return found;
    } else if (values.length < 100) return found;
  }
  throw Error('Inventory page budget exceeded; absence is unproven');
}
const account = `/accounts/${manifest.accountID}`;
if (mode === 'absent') {
  const workers = await inventory(`${account}/workers/scripts`, result => result);
  const buckets = await inventory(`${account}/r2/buckets`, result => result.buckets);
  const hyperdrives = await inventory(`${account}/hyperdrive/configs`, result => result);
  const secrets = await inventory(
    `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`,
    result => (Array.isArray(result) ? result : result.secrets)
  );
  assert(!workers.some(row => row.id === manifest.workerName));
  assert(!buckets.some(row => row.name === manifest.r2Bucket));
  assert(!hyperdrives.some(row => row.name === manifest.workerName));
  assert(!secrets.some(row => manifest.secretNames.includes(row.name)));
  const namespaces = new Set(limiterConfig(manifest.runID).map(row => row.namespace_id));
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, workers.length) }, async () => {
      while (index < workers.length) {
        const worker = workers[index++];
        const settings = await api(
          'GET',
          `${account}/workers/scripts/${encodeURIComponent(worker.id)}/settings`
        );
        assert(
          !(settings.result.bindings ?? []).some(
            binding => binding.type === 'ratelimit' && namespaces.has(String(binding.namespace_id))
          ),
          'Limiter namespace is already shared with another Worker'
        );
      }
    })
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
