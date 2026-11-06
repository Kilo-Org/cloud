import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  return value;
}
export function identityHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function operatorAPI(credentials) {
  assert(credentials, 'A scoped operator credential resolver is required');
  const zoneIDs = new Set();
  return async (method, path) => {
    const zonesList = path.startsWith('/zones?account.id=e115e769bcdd4c3d66af59d3332cb394&');
    const zoneRoute = /^\/zones\/([a-f0-9]{32})\/workers\/routes(?:\?|$)/.exec(path);
    assert(
      path.startsWith('/accounts/e115e769bcdd4c3d66af59d3332cb394/') ||
        (method === 'GET' && (zonesList || (zoneRoute && zoneIDs.has(zoneRoute[1]))))
    );
    const token = typeof credentials === 'function' ? await credentials() : credentials;
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { absent: true };
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Cloudflare HTTP ${response.status}`);
    }
    const data = await response.json();
    assert(data.success !== false, 'Cloudflare operation unsuccessful');
    if (zonesList)
      for (const zone of data.result) {
        assert(zone.account.id === 'e115e769bcdd4c3d66af59d3332cb394');
        zoneIDs.add(zone.id);
      }
    return data;
  };
}
function normalized(binding) {
  const { name, type } = binding;
  if (type === 'plain_text') return { name, type, text: binding.text };
  if (type === 'durable_object_namespace')
    return { name, type, namespace_id: binding.namespace_id };
  if (type === 'hyperdrive') return { name, type, id: binding.id };
  if (type === 'r2_bucket') return { name, type, bucket_name: binding.bucket_name };
  if (type === 'analytics_engine') return { name, type, dataset: binding.dataset };
  if (type === 'secrets_store_secret')
    return { name, type, store_id: binding.store_id, secret_name: binding.secret_name };
  if (type === 'ratelimit')
    return { name, type, namespace_id: String(binding.namespace_id), simple: binding.simple };
  throw Error('Unexpected deployed binding type');
}
export function assertBindings(manifest, bindings) {
  const config = JSON.parse(readFileSync(manifest.configFile, 'utf8'));
  const expected = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...manifest.namespaces.map(row => ({
      name: row.binding,
      type: 'durable_object_namespace',
      namespace_id: row.id,
    })),
    ...config.hyperdrive.map(row => ({ name: row.binding, type: 'hyperdrive', id: row.id })),
    ...config.r2_buckets.map(row => ({
      name: row.binding,
      type: 'r2_bucket',
      bucket_name: row.bucket_name,
    })),
    ...config.analytics_engine_datasets.map(row => ({
      name: row.binding,
      type: 'analytics_engine',
      dataset: row.dataset,
    })),
    ...config.secrets_store_secrets.map(row => ({
      name: row.binding,
      type: 'secrets_store_secret',
      store_id: row.store_id,
      secret_name: row.secret_name,
    })),
    ...config.ratelimits.map(row => ({
      name: row.name,
      type: 'ratelimit',
      namespace_id: String(row.namespace_id),
      simple: row.simple,
    })),
  ];
  const sort = rows => rows.map(normalized).sort((a, b) => a.name.localeCompare(b.name));
  assert(
    identityHash(sort(bindings)) === identityHash(sort(expected)),
    'Current deployed bindings must match the reviewed dedicated resources'
  );
  return identityHash(sort(bindings));
}
export async function currentDeployment(manifest, api) {
  const path = `/accounts/${manifest.accountID}/workers/scripts/${manifest.workerName}`;
  const deployments = await api('GET', `${path}/deployments`);
  if (deployments.absent) return { absent: true };
  const rows = [...deployments.result.deployments].sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on)
  );
  const latest = rows[0];
  assert(latest, 'Worker deployment metadata is required');
  assert.equal(
    latest.id,
    manifest.deploymentID,
    'Worker ownership changed; refuse deletion or load'
  );
  assert.deepEqual(latest.versions, [{ percentage: 100, version_id: manifest.versionID }]);
  const settings = await api('GET', `${path}/settings`);
  assert.equal(
    settings.result.annotations?.['workers/tag'],
    manifest.runID,
    'Deployment must carry this run tag'
  );
  const bindingsHash = assertBindings(manifest, settings.result.bindings);
  return { deploymentID: latest.id, versionID: manifest.versionID, bindingsHash };
}
export async function inspectLive(manifest, api) {
  const current = await currentDeployment(manifest, api);
  assert(!current.absent, 'Expected deployment is absent');
  const account = `/accounts/${manifest.accountID}`;
  const namespaces = [];
  for (let page = 1; page <= 100; page++) {
    const list = await api(
      'GET',
      `${account}/workers/durable_objects/namespaces?per_page=100&page=${page}`
    );
    namespaces.push(
      ...list.result.filter(
        row => row.script === manifest.workerName || row.script_name === manifest.workerName
      )
    );
    if (
      list.result.length < 100 ||
      (list.result_info?.total_count !== undefined && page * 100 >= list.result_info.total_count)
    )
      break;
    assert(page < 100, 'Namespace inventory page budget');
  }
  assert.deepEqual(namespaces.map(row => row.id).sort(), [...manifest.namespaceIDs].sort());
  const rendered = JSON.parse(readFileSync(manifest.configFile, 'utf8'));
  for (const expected of manifest.namespaces) {
    const actual = namespaces.find(row => row.id === expected.id);
    assert.equal(
      actual.class,
      rendered.durable_objects.bindings.find(binding => binding.name === expected.binding)
        .class_name
    );
  }
  const hyperdrive = (await api('GET', `${account}/hyperdrive/configs/${manifest.hyperdriveID}`))
    .result;
  assert.equal(hyperdrive.name, manifest.workerName);
  assert.equal(hyperdrive.caching.disabled, true);
  assert.equal(hyperdrive.origin.host, manifest.databaseHost);
  assert.equal(hyperdrive.origin.database, manifest.databaseName);
  assert.equal(hyperdrive.origin.user, manifest.databaseUser);
  assert(['postgres', 'postgresql'].includes(hyperdrive.origin.scheme));
  assert(manifest.databaseName.startsWith('session_sync_loadtest_'));
  const tls = JSON.parse(readFileSync(manifest.databaseEvidenceFile, 'utf8'));
  assert.equal(tls.host, manifest.databaseHost);
  assert.equal(tls.database, manifest.databaseName);
  assert.equal(tls.syntheticOnly, true);
  assert.equal(tls.ssl, true);
  assert.equal(tls.cloudflareOriginTLSVerified, true);
  const managed = (await api('GET', `${account}/r2/buckets/${manifest.r2Bucket}/domains/managed`))
    .result;
  assert.equal(managed.enabled, false);
  assert.equal(managed.bucketId, manifest.r2BucketID);
  const custom = (await api('GET', `${account}/r2/buckets/${manifest.r2Bucket}/domains/custom`))
    .result;
  assert.deepEqual(custom.domains, []);
  for (let page = 1; page <= 100; page++) {
    const domains = await api('GET', `${account}/workers/domains?per_page=100&page=${page}`);
    assert(
      !domains.result.some(row => row.service === manifest.workerName),
      'Dedicated Worker must have no custom domain'
    );
    if (
      domains.result.length < 100 ||
      (domains.result_info?.total_count !== undefined &&
        page * 100 >= domains.result_info.total_count)
    )
      break;
    assert(page < 100, 'Worker domain inventory page budget');
  }
  for (let page = 1; page <= 100; page++) {
    const zones = await api(
      'GET',
      `/zones?account.id=${manifest.accountID}&per_page=50&page=${page}`
    );
    for (const zone of zones.result) {
      const routes = await api('GET', `/zones/${zone.id}/workers/routes`);
      assert(
        !routes.result.some(route => route.script === manifest.workerName),
        'Dedicated Worker must have no zone route'
      );
    }
    if (zones.result.length < 50) break;
    assert(page < 100, 'Zone inventory page budget');
  }
  return {
    runID: manifest.runID,
    workerName: manifest.workerName,
    checkedAt: Date.now(),
    ...current,
    r2BucketID: managed.bucketId,
    r2Private: true,
    databaseTLS: true,
    databaseEvidenceHash: createHash('sha256')
      .update(readFileSync(manifest.databaseEvidenceFile))
      .digest('hex'),
  };
}
export function checkWatchdog(manifest, now = Date.now(), localProcess = false) {
  const ready = JSON.parse(readFileSync(manifest.watchdogReadyFile, 'utf8'));
  assert.equal(ready.runID, manifest.runID);
  assert.equal(ready.workerName, manifest.workerName);
  assert.equal(ready.deploymentID, manifest.deploymentID);
  assert.equal(ready.versionID, manifest.versionID);
  assert.equal(ready.teardownAt, manifest.teardownAt);
  assert.equal(ready.instanceID, manifest.independentWatchdogID);
  assert(
    now >= ready.heartbeatAt && now - ready.heartbeatAt <= 10000,
    'Independent watchdog heartbeat is stale'
  );
  assert(ready.pid > 0);
  if (localProcess) process.kill(ready.pid, 0);
  return ready;
}

export async function resolveOperatorToken(wrangler) {
  assert(
    wrangler.endsWith('/node_modules/.bin/wrangler'),
    'Use the repository-pinned credential resolver'
  );
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  for (const key of [
    'SESSION_SYNC_LOADTEST_CF_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_EMAIL',
  ])
    delete environment[key];
  try {
    const { stdout } = await execute(wrangler, ['auth', 'token', '--json'], {
      env: environment,
      timeout: 10000,
      maxBuffer: 65536,
    });
    const token = JSON.parse(stdout).token;
    assert(typeof token === 'string' && token.length > 0);
    return token;
  } catch {
    throw Error('Pinned operator credential resolver unavailable');
  }
}
