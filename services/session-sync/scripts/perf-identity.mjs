import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
export const approvedAccountID = 'e115e769bcdd4c3d66af59d3332cb394';
const resourceID = /^[a-f0-9]{32}$/;
const atom = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function assertManifestIdentity(manifest, deployed = false) {
  assert.equal(manifest.accountID, approvedAccountID);
  assert(/^(?=.{3,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.runID));
  assert.equal(manifest.workerName, `session-sync-${manifest.runID}-loadtest`);
  assert.equal(manifest.r2Bucket, manifest.workerName);
  for (const key of ['hyperdriveID', 'secretsStoreID'])
    if (deployed || manifest[key] !== undefined) assert(resourceID.test(manifest[key]), key);
  for (const key of ['deploymentID', 'versionID', 'r2BucketID'])
    if (deployed || manifest[key] !== undefined) assert(atom.test(manifest[key]), key);
  for (const id of manifest.namespaceIDs ?? []) assert(resourceID.test(id), 'namespace ID');
  for (const row of manifest.namespaces ?? []) assert(resourceID.test(row.id), 'namespace ID');
  for (const secret of manifest.secrets ?? []) {
    if (deployed || secret.id !== undefined) assert(resourceID.test(secret.id), 'secret ID');
    assert(/^[A-Z0-9_]+_STAGING_LOADTEST$/.test(secret.name), 'secret name');
  }
  for (const name of manifest.secretNames ?? [])
    assert(/^[A-Z0-9_]+_STAGING_LOADTEST$/.test(name), 'secret name');
}
export function assertGenerator(node) {
  assert(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(node.host), 'Reviewed SSH host');
  assert(!['localhost', '127.0.0.1'].includes(node.host), 'Use owned test generator hosts');
  for (const key of ['root', 'repository']) {
    const path = node[key];
    assert(
      typeof path === 'string' &&
        /^\/[a-zA-Z0-9_./-]+$/.test(path) &&
        path !== '/' &&
        posix.normalize(path) === path &&
        !path.split('/').some(part => part === '.' || part === '..'),
      'Reviewed absolute generator path'
    );
  }
}
export async function listWorkerScripts(api) {
  const response = await api('GET', `/accounts/${approvedAccountID}/workers/scripts`);
  assert(!response.absent, 'Inventory unavailable; absence is unproven');
  assert(Array.isArray(response.result), 'Worker scripts inventory response schema changed');
  assert(
    response.result_info == null && response.cursor == null,
    'Worker scripts inventory pagination schema changed; absence is unproven'
  );
  for (const worker of response.result)
    assert(
      typeof worker?.id === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(worker.id),
      'Inventory Worker ID'
    );
  return response.result;
}
export async function inventory(api, path, rows = result => result, perPage = 100) {
  assert(Number.isSafeInteger(perPage) && perPage > 0, 'Inventory page size');
  const found = [];
  const cursors = new Set();
  let cursor;
  for (let page = 1; page <= 100; page++) {
    const query = cursor
      ? `per_page=${perPage}&cursor=${encodeURIComponent(cursor)}`
      : `per_page=${perPage}&page=${page}`;
    const response = await api('GET', `${path}${path.includes('?') ? '&' : '?'}${query}`);
    assert(!response.absent, 'Inventory unavailable; absence is unproven');
    const values = rows(response.result);
    assert(Array.isArray(values), 'Inventory response schema changed');
    found.push(...values);
    const info = response.result_info;
    assert(
      info == null ||
        (typeof info === 'object' &&
          !Array.isArray(info) &&
          Object.keys(info).every(key =>
            ['page', 'per_page', 'count', 'total_count', 'total_pages', 'cursor'].includes(key)
          )),
      'Inventory pagination schema changed; absence is unproven'
    );
    for (const key of ['page', 'per_page', 'count', 'total_count', 'total_pages'])
      if (info?.[key] !== undefined)
        assert(
          Number.isSafeInteger(info[key]) &&
            info[key] >= (key === 'page' || key === 'per_page' ? 1 : 0),
          'Inventory pagination schema changed; absence is unproven'
        );
    cursor = response.result?.cursor ?? info?.cursor;
    assert(
      cursor == null || typeof cursor === 'string',
      'Inventory cursor schema changed; absence is unproven'
    );
    if (cursor) {
      assert(!cursors.has(cursor), 'Inventory cursor repeated; absence is unproven');
      cursors.add(cursor);
      continue;
    }
    if (info?.total_pages !== undefined) {
      if (page >= info.total_pages) return found;
    } else if (values.length < (info?.per_page ?? perPage)) return found;
  }
  throw Error('Inventory page budget exceeded; absence is unproven');
}
export async function assertUnusedLimiters(api, workers, namespaceIDs) {
  const namespaces = new Set(namespaceIDs.map(String));
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, workers.length) }, async () => {
      while (index < workers.length) {
        const worker = workers[index++];
        assert(/^[a-zA-Z0-9_-]{1,255}$/.test(worker.id), 'Inventory Worker ID');
        const settings = await api(
          'GET',
          `/accounts/${approvedAccountID}/workers/scripts/${worker.id}/settings`
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
}
export class OperatorHTTPError extends Error {
  constructor(status) {
    super(`Cloudflare HTTP ${status}`);
    this.status = status;
    this.transient = status === 408 || status === 429 || status >= 500;
  }
}
export async function retryTransient(action, deadline, options = {}) {
  const now = options.now ?? Date.now;
  const delay = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    assert(now() < deadline, 'Teardown deadline exhausted');
    try {
      return await action();
    } catch (error) {
      if (!error.transient || attempt >= 3 || now() + 250 * 2 ** attempt >= deadline) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
}
export function operatorAPI(credentials, options = {}) {
  assert(credentials, 'A scoped operator credential resolver is required');
  const zoneIDs = new Set();
  return async (method, path) => {
    const url = new URL('https://api.cloudflare.com/client/v4' + path);
    assert(
      path.startsWith('/') &&
        !path.includes('#') &&
        !path.includes('\\') &&
        url.origin === 'https://api.cloudflare.com' &&
        url.pathname === '/client/v4' + path.split('?')[0] &&
        !path.split('?')[0].includes('%') &&
        !path
          .split('?')[0]
          .split('/')
          .some(part => part === '.' || part === '..'),
      'Unsafe operator API path'
    );
    const pathname = path.split('?')[0];
    const zonesList =
      pathname === '/zones' && url.searchParams.get('account.id') === approvedAccountID;
    const zoneRoute = /^\/zones\/([a-f0-9]{32})\/workers\/routes$/.exec(pathname);
    const accountPath = pathname.slice(`/accounts/${approvedAccountID}/`.length);
    const accountRead =
      pathname.startsWith(`/accounts/${approvedAccountID}/`) &&
      /^(?:workers\/(?:scripts(?:\/[a-zA-Z0-9_-]{1,255}(?:\/(?:deployments|settings|script-settings|subdomain|versions\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}))?)?|subdomain|domains|durable_objects\/namespaces)|hyperdrive\/configs(?:\/[a-f0-9]{32})?|r2\/buckets(?:\/[a-z0-9][a-z0-9-]{0,62}(?:\/domains\/(?:managed|custom))?)?|secrets_store\/stores\/[a-f0-9]{32}\/secrets(?:\/[a-f0-9]{32})?)$/.test(
        accountPath
      );
    const accountDelete =
      pathname.startsWith(`/accounts/${approvedAccountID}/`) &&
      /^(?:hyperdrive\/configs\/[a-f0-9]{32}|secrets_store\/stores\/[a-f0-9]{32}\/secrets\/[a-f0-9]{32})$/.test(
        accountPath
      );
    assert(
      (method === 'GET' &&
        (accountRead || zonesList || (zoneRoute && zoneIDs.has(zoneRoute[1])))) ||
        (method === 'DELETE' && accountDelete),
      'Operator endpoint is outside the approved account/read-delete scope'
    );
    const token = typeof credentials === 'function' ? await credentials() : credentials;
    const remaining = (options.deadline ?? Infinity) - Date.now();
    assert(remaining > 0, 'Teardown deadline exhausted');
    let response;
    try {
      response = await (options.fetch ?? fetch)(url.href, {
        method,
        redirect: 'error',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining))),
      });
    } catch (cause) {
      throw Object.assign(Error('Operator transport failed'), { transient: true, cause });
    }
    if (response.status === 404) return { absent: true };
    if (!response.ok) {
      await response.body?.cancel();
      throw new OperatorHTTPError(response.status);
    }
    const data = await response.json();
    assert(data.success !== false, 'Cloudflare operation unsuccessful');
    if (zonesList)
      for (const zone of data.result) {
        assert.equal(zone.account.id, approvedAccountID);
        assert(resourceID.test(zone.id), 'zone ID');
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
  assertManifestIdentity(manifest, true);
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
  const version = (await api('GET', `${path}/versions/${manifest.versionID}`)).result;
  assert.equal(version.id, manifest.versionID, 'Unexpected deployed version metadata');
  assert.equal(
    version.annotations?.['workers/tag'],
    manifest.runID,
    'Deployment must carry this run tag'
  );
  const bindingsHash = assertBindings(manifest, version.resources.bindings);
  return { deploymentID: latest.id, versionID: version.id, bindingsHash };
}
export function observabilityIsDisabled(value) {
  if (value == null) return true;
  const levels = [value, value.logs, value.traces];
  return levels.every(
    level =>
      level == null ||
      (typeof level === 'object' &&
        !Array.isArray(level) &&
        (level.enabled === undefined || level.enabled === false))
  );
}

export async function inspectLive(manifest, api) {
  assertManifestIdentity(manifest, true);
  const current = await currentDeployment(manifest, api);
  assert(!current.absent, 'Expected deployment is absent');
  const account = `/accounts/${manifest.accountID}`;
  const subdomain = (await api('GET', `${account}/workers/subdomain`)).result.subdomain;
  const baseURL = `https://${manifest.workerName}.${subdomain}.workers.dev/`;
  const scriptSettings = (
    await api('GET', `${account}/workers/scripts/${manifest.workerName}/script-settings`)
  ).result;
  assert.equal(scriptSettings.logpush, true, 'Load request logs must reach Logpush');
  assert(
    observabilityIsDisabled(scriptSettings.observability),
    'Duplicate stored Worker logs must remain disabled'
  );
  assert.equal(manifest.baseURL, baseURL, 'Worker origin must belong to the inspected account');
  const exposure = (await api('GET', `${account}/workers/scripts/${manifest.workerName}/subdomain`))
    .result;
  assert.equal(exposure.enabled, true);
  const namespaces = (await inventory(api, `${account}/workers/durable_objects/namespaces`)).filter(
    row => row.script === manifest.workerName || row.script_name === manifest.workerName
  );
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
  const domains = await inventory(api, `${account}/workers/domains`);
  assert(
    !domains.some(row => row.service === manifest.workerName),
    'Dedicated Worker must have no custom domain'
  );
  const zones = await inventory(
    api,
    `/zones?account.id=${manifest.accountID}`,
    result => result,
    50
  );
  for (const zone of zones) {
    assert(resourceID.test(zone.id), 'zone ID');
    const routes = await inventory(api, `/zones/${zone.id}/workers/routes`);
    assert(
      !routes.some(route => route.script === manifest.workerName),
      'Dedicated Worker must have no zone route'
    );
  }
  return {
    runID: manifest.runID,
    workerName: manifest.workerName,
    baseURL,
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

export async function resolveOperatorToken(wrangler, deadline = Infinity) {
  assert(
    wrangler.endsWith('/node_modules/.bin/wrangler'),
    'Use the repository-pinned credential resolver'
  );
  assert(Date.now() < deadline, 'Teardown deadline exhausted');
  // Set only by the parent's private wrapper on the reviewed control VM, never a generator.
  if (process.env.SESSION_SYNC_LOADTEST_OPERATOR_TOKEN)
    return process.env.SESSION_SYNC_LOADTEST_OPERATOR_TOKEN;
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  for (const key of [
    'SESSION_SYNC_LOADTEST_CF_TOKEN',
    'SESSION_SYNC_LOADTEST_OPERATOR_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_EMAIL',
  ])
    delete environment[key];
  try {
    const { stdout } = await execute(wrangler, ['auth', 'token', '--json'], {
      env: environment,
      timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
      maxBuffer: 65536,
    });
    const token = JSON.parse(stdout).token;
    assert(typeof token === 'string' && token.length > 0);
    return token;
  } catch {
    throw Error('Pinned operator credential resolver unavailable');
  }
}
