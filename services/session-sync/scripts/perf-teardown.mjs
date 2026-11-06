import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateTarget } from './perf-common.mjs';
import { currentDeployment, operatorAPI, resolveOperatorToken } from './perf-identity.mjs';

const [mode, file] = process.argv.slice(2);
assert(
  ['arm', 'now'].includes(mode) && file,
  'Usage: perf-teardown.mjs arm|now target-manifest.json'
);
const manifest = JSON.parse(readFileSync(file, 'utf8'));
validateTarget(
  { runID: manifest.runID, baseURL: manifest.baseURL, stopAt: manifest.teardownAt },
  manifest
);
assert(
  manifest.wrangler.endsWith('/node_modules/.bin/wrangler'),
  'Use the repository-pinned operator binary'
);
assert(manifest.teardownAt > Date.now() - 900000 && manifest.teardownAt <= Date.now() + 900000);
const account = `/accounts/${manifest.accountID}`;
const proof = { startedAt: Date.now(), deadline: manifest.teardownAt, operations: [], errors: [] };
const save = () =>
  writeFileSync(manifest.teardownProofFile, JSON.stringify(proof, null, 2), { mode: 0o600 });
const api = operatorAPI(() => resolveOperatorToken(manifest.wrangler));
async function confirmOwnership() {
  try {
    const deployment = await currentDeployment(manifest, api);
    const bucket = await api('GET', `${account}/r2/buckets/${manifest.r2Bucket}/domains/managed`);
    if (!bucket.absent) assert.equal(bucket.result.bucketId, manifest.r2BucketID);
    return { ...deployment, bucketAbsent: bucket.absent === true };
  } catch {
    proof.errors.push({ name: 'ownership_changed_or_unverified', at: Date.now() });
    save();
    process.exit(1);
  }
}
async function cli(args) {
  const child = spawn(manifest.wrangler, ['--config', manifest.configFile, ...args], {
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: await resolveOperatorToken(manifest.wrangler),
      CLOUDFLARE_ACCOUNT_ID: manifest.accountID,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end('y\n');
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, 'Pinned operator command failed');
}
async function operation(name, action) {
  try {
    await action();
    proof.operations.push({ name, ok: true, at: Date.now() });
  } catch {
    proof.errors.push({ name, at: Date.now() });
  }
  save();
}
if (mode === 'arm') {
  const current = await confirmOwnership();
  assert(!current.absent, 'Cannot arm against an absent deployment');
  const ready = () => {
    const value = {
      runID: manifest.runID,
      workerName: manifest.workerName,
      deploymentID: manifest.deploymentID,
      versionID: manifest.versionID,
      instanceID: manifest.independentWatchdogID,
      pid: process.pid,
      heartbeatAt: Date.now(),
      teardownAt: manifest.teardownAt,
    };
    writeFileSync(manifest.watchdogReadyFile + '.tmp', JSON.stringify(value), { mode: 0o600 });
    renameSync(manifest.watchdogReadyFile + '.tmp', manifest.watchdogReadyFile);
  };
  save();
  ready();
  const heartbeat = setInterval(ready, 2000);
  const wake = new AbortController();
  process.once('SIGTERM', () => wake.abort());
  process.once('SIGINT', () => wake.abort());
  try {
    await sleep(Math.max(0, manifest.teardownAt - Date.now()), undefined, { signal: wake.signal });
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
const ownership = await confirmOwnership();
if (!ownership.absent)
  await operation('delete_worker', () => cli(['delete', manifest.workerName, '--force']));
for (const key of ownership.bucketAbsent ? [] : (manifest.r2Keys ?? [])) {
  assert(typeof key === 'string' && !key.startsWith('/') && !key.includes('..'));
  await operation('delete_synthetic_object', () =>
    cli(['r2', 'object', 'delete', `${manifest.r2Bucket}/${key}`, '--remote'])
  );
}
if (!ownership.bucketAbsent)
  await operation('delete_bucket', () => cli(['r2', 'bucket', 'delete', manifest.r2Bucket]));
await operation('delete_hyperdrive', async () => {
  const path = `${account}/hyperdrive/configs/${manifest.hyperdriveID}`;
  const current = await api('GET', path);
  if (!current.absent) {
    assert.equal(current.result.name, manifest.workerName);
    await api('DELETE', path);
  }
});
for (const secret of manifest.secrets) {
  assert(manifest.secretNames.includes(secret.name) && /^[a-f0-9]{32}$/.test(secret.id));
  assert(/^[a-f0-9]{32}$/.test(manifest.secretsStoreID));
  await operation('delete_staging_secret', async () => {
    const path = `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets/${secret.id}`;
    const list = await api(
      'GET',
      `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`
    );
    const rows = Array.isArray(list.result) ? list.result : list.result.secrets;
    const current = rows.find(item => item.id === secret.id);
    if (current) {
      assert.equal(current.name, secret.name);
      await api('DELETE', path);
    }
  });
}
await operation('verify_worker_absent', async () => {
  const list = await api('GET', `${account}/workers/scripts`);
  assert(!list.result.some(item => item.id === manifest.workerName));
});
await operation('verify_namespaces_absent', async () => {
  for (let page = 1; ; page++) {
    const list = await api(
      'GET',
      `${account}/workers/durable_objects/namespaces?per_page=100&page=${page}`
    );
    assert(
      !list.result.some(
        item =>
          manifest.namespaceIDs.includes(item.id) ||
          item.script === manifest.workerName ||
          item.script_name === manifest.workerName
      )
    );
    if (list.result.length < 100) break;
    assert(page < 100, 'Namespace inventory page budget');
  }
});
for (const [name, path] of [
  ['bucket', `${account}/r2/buckets/${manifest.r2Bucket}`],
  ['hyperdrive', `${account}/hyperdrive/configs/${manifest.hyperdriveID}`],
]) {
  await operation(`verify_${name}_absent`, async () =>
    assert.equal((await api('GET', path)).absent, true)
  );
}
await operation('verify_secrets_absent', async () => {
  const list = await api(
    'GET',
    `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`
  );
  const rows = Array.isArray(list.result) ? list.result : list.result.secrets;
  assert(!rows.some(secret => manifest.secretNames.includes(secret.name)));
});
proof.finishedAt = Date.now();
save();
console.log(
  JSON.stringify({
    operations: proof.operations.length,
    errors: proof.errors.length,
    finishedAt: proof.finishedAt,
  })
);
process.exitCode = proof.errors.length ? 1 : 0;
