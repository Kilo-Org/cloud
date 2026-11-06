import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvedAccountID,
  assertGenerator,
  assertManifestIdentity,
  assertUnusedLimiters,
  currentDeployment,
  inventory,
  listWorkerScripts,
  observabilityIsDisabled,
  operatorAPI,
  OperatorHTTPError,
  retryTransient,
} from './perf-identity.mjs';
import {
  finalizeClusterResult,
  limiterConfig,
  sha256,
  validateAttestation,
} from './perf-common.mjs';
import { cleanupOwned, runOperatorCLI } from './perf-teardown.mjs';

const account = `/accounts/${approvedAccountID}`;
function identity() {
  const runID = 'operator-probe';
  return {
    accountID: approvedAccountID,
    runID,
    workerName: `session-sync-${runID}-loadtest`,
    r2Bucket: `session-sync-${runID}-loadtest`,
    hyperdriveID: 'a'.repeat(32),
    secretsStoreID: 'b'.repeat(32),
    deploymentID: 'owned-deployment',
    versionID: 'owned-version',
    r2BucketID: 'owned-bucket',
    namespaceIDs: ['1', '2', '3', '4'].map(value => value.repeat(32)),
    secrets: [{ id: 'c'.repeat(32), name: 'SESSION_SYNC_SECRET_STAGING_LOADTEST' }],
    secretNames: ['SESSION_SYNC_SECRET_STAGING_LOADTEST'],
    teardownAt: Date.now() + 10000,
    teardownTailSeconds: 150,
  };
}
async function stub(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    const result = await handler(request);
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body ?? { success: true, result: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    fetch: (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, 'https://api.cloudflare.com');
      return fetch(origin + target.pathname.slice('/client/v4'.length) + target.search, options);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('remote observability defaults reject any explicit logging or tracing enablement', () => {
  for (const value of [
    undefined,
    null,
    {},
    { enabled: false },
    { logs: { enabled: false } },
    { enabled: false, logs: { persist: true } },
  ])
    assert.equal(observabilityIsDisabled(value), true);
  for (const value of [
    true,
    [],
    'disabled',
    { enabled: true },
    { enabled: 'false' },
    { enabled: false, logs: { enabled: true } },
    { enabled: false, traces: { enabled: true } },
    { logs: true },
  ])
    assert.equal(observabilityIsDisabled(value), false);
});

test('deployed version metadata fences ownership without legacy settings annotations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-version-contract-'));
  const manifest = { ...identity(), namespaces: [], configFile: join(root, 'wrangler.json') };
  writeFileSync(
    manifest.configFile,
    JSON.stringify({
      vars: {},
      hyperdrive: [],
      r2_buckets: [],
      analytics_engine_datasets: [],
      secrets_store_secrets: [],
      ratelimits: [],
    })
  );
  const version = {
    id: manifest.versionID,
    annotations: { 'workers/tag': manifest.runID },
    resources: { bindings: [] },
  };
  const local = await stub(request => {
    if (request.url.endsWith('/deployments'))
      return {
        body: {
          result: {
            deployments: [
              {
                id: manifest.deploymentID,
                created_on: '2026-11-06',
                versions: [{ percentage: 100, version_id: manifest.versionID }],
              },
            ],
          },
        },
      };
    if (request.url.endsWith(`/versions/${manifest.versionID}`))
      return { body: { result: version } };
    if (request.url.endsWith('/settings')) return { body: { result: { bindings: [] } } };
    return { status: 404 };
  });
  try {
    const api = operatorAPI('synthetic-only', { fetch: local.fetch });
    assert.equal((await currentDeployment(manifest, api)).versionID, manifest.versionID);
    version.annotations['workers/tag'] = 'another-run';
    await assert.rejects(currentDeployment(manifest, api), /run tag/);
    version.annotations['workers/tag'] = manifest.runID;
    version.resources.bindings.push({ name: 'UNREVIEWED', type: 'plain_text', text: 'unreviewed' });
    await assert.rejects(currentDeployment(manifest, api), /deployed bindings/);
    version.resources.bindings.length = 0;
    version.id = 'another-version';
    await assert.rejects(currentDeployment(manifest, api), /version metadata/);
  } finally {
    await local.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('escaped/account-external operator paths never resolve credentials or reach HTTP', async () => {
  const local = await stub(() => ({ body: { success: true, result: [] } }));
  let credentials = 0;
  try {
    const api = operatorAPI(
      () => {
        credentials++;
        return 'synthetic-only';
      },
      { fetch: local.fetch }
    );
    for (const path of [
      `${account}/../other-account/workers/scripts`,
      `${account}/workers/./scripts`,
      `${account}/workers/scripts/../../../../other-account/workers/scripts`,
      `${account}/workers/scripts/%2e%2e/settings`,
      `${account}/workers/scripts/%252e%252e/settings`,
      `${account}/workers/scripts/owned\\..\\other/settings`,
      `${account}/hyperdrive/configs/${'a'.repeat(32)}/../${'d'.repeat(32)}`,
      `/accounts/${'f'.repeat(32)}/workers/scripts`,
      `${account}/workers/scripts#ignored`,
    ])
      await assert.rejects(api('GET', path));
    await assert.rejects(api('DELETE', `${account}/workers/scripts/session-sync-production`));
    assert.equal(credentials, 0);
    assert.equal(local.requests.length, 0);
    await api('GET', `${account}/workers/scripts`);
    assert.equal(credentials, 1);
    assert.equal(local.requests.length, 1);
  } finally {
    await local.close();
  }
});

test('every manifest endpoint identifier is validated before an API call', async () => {
  for (const change of [
    { accountID: approvedAccountID + '/..' },
    { runID: '../escape' },
    { workerName: 'session-sync-operator-probe-loadtest/../../production' },
    { hyperdriveID: '../escape' },
    { secretsStoreID: '%2e%2e' },
    { deploymentID: '../replacement' },
    { versionID: 'x/y' },
    { r2BucketID: '..' },
    { namespaceIDs: ['../escape'] },
    { namespaces: [{ id: '../escape' }] },
    { secrets: [{ id: '../escape', name: 'SESSION_SYNC_SECRET_STAGING_LOADTEST' }] },
  ]) {
    let calls = 0;
    await assert.rejects(
      currentDeployment({ ...identity(), ...change }, async () => {
        calls++;
      })
    );
    assert.equal(calls, 0);
  }
  assert.doesNotThrow(() => assertManifestIdentity(identity(), true));
});

test('transient ownership reads and deletes retry finitely then complete full paginated cleanup', async () => {
  const manifest = identity();
  const secretPath = `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`;
  let ownershipReads = 0;
  let hyperdriveDeletes = 0;
  let hyperdrivePresent = true;
  let secretPresent = true;
  const local = await stub(request => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (path.endsWith('/deployments')) return { status: ++ownershipReads === 1 ? 503 : 404 };
    if (path.includes('/r2/buckets/')) return { status: 404 };
    if (path === `${account}/hyperdrive/configs/${manifest.hyperdriveID}`) {
      if (request.method === 'DELETE') {
        if (++hyperdriveDeletes === 1) return { status: 502 };
        hyperdrivePresent = false;
        return {};
      }
      return hyperdrivePresent
        ? { body: { result: { name: manifest.workerName } } }
        : { status: 404 };
    }
    if (request.method === 'DELETE' && path === `${secretPath}/${manifest.secrets[0].id}`) {
      secretPresent = false;
      return {};
    }
    if (path === `${account}/workers/scripts`) return { body: { result: [] } };
    if (path === secretPath)
      return {
        body: {
          result: {
            secrets:
              url.searchParams.get('page') === '1'
                ? Array.from({ length: 100 }, (_, index) => ({
                    id: `unrelated-${index}`,
                    name: 'UNRELATED',
                  }))
                : secretPresent
                  ? manifest.secrets
                  : [],
          },
          result_info: { total_pages: 2 },
        },
      };
    return { body: { result: [], result_info: { total_pages: 1 } } };
  });
  try {
    const raw = operatorAPI('synthetic-only', { fetch: local.fetch });
    const api = (method, path) =>
      retryTransient(() => raw(method, path), Date.now() + 10000, { sleep: async () => {} });
    const proof = { operations: [], errors: [] };
    await cleanupOwned(
      manifest,
      api,
      async () => assert.fail('Absent worker/bucket must not invoke CLI'),
      proof,
      () => {}
    );
    assert.deepEqual(proof.errors, []);
    assert.equal(ownershipReads, 2);
    assert.equal(hyperdriveDeletes, 2);
    assert.equal(secretPresent, false);
    assert(
      local.requests.some(
        row => row.method === 'DELETE' && row.path === `${secretPath}/${manifest.secrets[0].id}`
      )
    );
    assert(
      local.requests.filter(row => row.path.includes('/secrets?per_page=100&page=2')).length >= 2
    );
    assert(proof.operations.some(row => row.name === 'verify_worker_absent'));
  } finally {
    await local.close();
  }
});

test('single-page Worker and late-page secret remnants cannot produce clean teardown', async () => {
  const manifest = identity();
  const apiWorkerName = 'Mixed_worker_' + 'a'.repeat(242);
  const local = await stub(request => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (
      url.pathname.endsWith('/deployments') ||
      url.pathname.includes('/r2/buckets/') ||
      url.pathname.includes('/hyperdrive/configs/')
    )
      return { status: 404 };
    if (url.pathname === `${account}/workers/scripts`)
      return {
        body: {
          result: [
            ...Array.from({ length: 150 }, (_, index) => ({
              id: index === 0 ? apiWorkerName : `unrelated-${index}`,
            })),
            { id: manifest.workerName },
          ],
        },
      };
    if (url.pathname.endsWith('/secrets'))
      return {
        body: {
          result:
            url.searchParams.get('page') === '1'
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: `unrelated-${index}`,
                  name: 'OTHER',
                }))
              : [{ id: 'replacement-id', name: manifest.secretNames[0] }],
          result_info: { total_pages: 2 },
        },
      };
    return { body: { result: [] } };
  });
  try {
    const proof = { operations: [], errors: [] };
    await cleanupOwned(
      manifest,
      operatorAPI('synthetic-only', { fetch: local.fetch }),
      async () => assert.fail('No CLI permitted'),
      proof,
      () => {}
    );
    assert(proof.errors.some(row => row.name === 'verify_worker_absent'));
    assert(proof.errors.some(row => row.name === 'verify_secrets_absent'));
    assert.deepEqual(proof.remaining.worker, [manifest.workerName]);
    assert.deepEqual(proof.remaining.secrets, [
      { id: 'replacement-id', name: manifest.secretNames[0] },
    ]);
    assert.deepEqual(
      local.requests.filter(row => row.path.startsWith(`${account}/workers/scripts`)),
      [
        { method: 'GET', path: `${account}/workers/scripts/${manifest.workerName}/deployments` },
        { method: 'GET', path: `${account}/workers/scripts` },
      ]
    );
    assert(local.requests.some(row => row.path.endsWith('/secrets?per_page=100&page=2')));
    assert(!local.requests.some(row => row.method === 'DELETE'));
  } finally {
    await local.close();
  }
});

test('permission denial and replacement deployment never retry or delete', async () => {
  for (const replacement of [false, true]) {
    const local = await stub(() =>
      replacement
        ? {
            body: {
              result: {
                deployments: [{ id: 'replacement', created_on: '2026-11-06', versions: [] }],
              },
            },
          }
        : { status: 403 }
    );
    try {
      const raw = operatorAPI('synthetic-only', { fetch: local.fetch });
      const api = (method, path) =>
        retryTransient(() => raw(method, path), Date.now() + 10000, { sleep: async () => {} });
      const proof = { operations: [], errors: [] };
      await cleanupOwned(
        identity(),
        api,
        async () => assert.fail('No CLI permitted'),
        proof,
        () => {}
      );
      assert.equal(local.requests.filter(row => row.path.endsWith('/deployments')).length, 1);
      assert.equal(proof.errors[0].name, 'delete_worker');
      assert(!local.requests.some(row => row.method === 'DELETE'));
    } finally {
      await local.close();
    }
  }
});

test('retry attempts and priced-tail deadline are hard finite limits', async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        attempts++;
        throw new OperatorHTTPError(503);
      },
      10000,
      { now: () => 0, sleep: async () => {} }
    )
  );
  assert.equal(attempts, 4);
  attempts = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        attempts++;
        throw new OperatorHTTPError(503);
      },
      200,
      { now: () => 0, sleep: async () => {} }
    )
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    retryTransient(
      async () => {
        attempts++;
      },
      200,
      { now: () => 200 }
    ),
    /deadline/
  );
  assert.equal(attempts, 1);
});

for (const scenario of [
  {
    name: 'short first page with a stale high count',
    counts: [68],
    perPage: 100,
    totalCount: 71,
  },
  {
    name: 'empty first page with a stale high count',
    counts: [0],
    perPage: 100,
    totalCount: 71,
  },
  {
    name: 'empty second page with a stale high count',
    counts: [2, 0],
    perPage: 2,
    totalCount: 71,
  },
  {
    name: 'full additional page with a stale low count',
    counts: [2, 2, 1],
    perPage: 2,
    totalCount: 1,
  },
]) {
  test(`numbered inventory follows actual page size: ${scenario.name}`, async () => {
    const manifest = identity();
    const path = `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`;
    const pages = scenario.counts.map((count, page) => ({
      result: {
        secrets: Array.from({ length: count }, (_, index) =>
          page === scenario.counts.length - 1 && index === count - 1
            ? manifest.secrets[0]
            : { id: `unrelated-${page}-${index}`, name: 'OTHER' }
        ),
      },
      result_info: {
        page: page + 1,
        per_page: scenario.perPage,
        count,
        total_count: scenario.totalCount,
      },
    }));
    const local = await stub(request => {
      const page = Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('page'));
      return pages[page - 1] ? { body: pages[page - 1] } : { status: 503 };
    });
    try {
      const values = await inventory(
        operatorAPI('synthetic-only', { fetch: local.fetch }),
        path,
        result => result.secrets
      );
      assert.deepEqual(
        values,
        pages.flatMap(page => page.result.secrets)
      );
      assert.deepEqual(
        local.requests,
        pages.map((_, index) => ({
          method: 'GET',
          path: `${path}?per_page=100&page=${index + 1}`,
        }))
      );
      if (scenario.counts.at(-1) > 0) assert(values.some(row => row.id === manifest.secrets[0].id));
    } finally {
      await local.close();
    }
  });
}

test('explicit total pages visits short and empty pages before the final owned secret', async () => {
  const manifest = identity();
  const path = `${account}/secrets_store/stores/${manifest.secretsStoreID}/secrets`;
  const pages = [[{ id: 'unrelated', name: 'OTHER' }], [], manifest.secrets];
  const local = await stub(request => {
    const page = Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('page'));
    return pages[page - 1]
      ? {
          body: {
            result: pages[page - 1],
            result_info: { per_page: 100, total_pages: 3, total_count: 1 },
          },
        }
      : { status: 503 };
  });
  try {
    const values = await inventory(operatorAPI('synthetic-only', { fetch: local.fetch }), path);
    assert.deepEqual(values, pages.flat());
    assert.equal(local.requests.length, 3);
    assert.equal(local.requests.at(-1).path, `${path}?per_page=100&page=3`);
  } finally {
    await local.close();
  }
});

test('numbered inventory rejects unknown pagination and changed response schemas', async () => {
  for (const body of [
    { result: {} },
    { result: [], result_info: [] },
    { result: [], result_info: { next_cursor: 'next-page' } },
    { result: [], result_info: { total_pages: '2' } },
    { result: [], result_info: { total_pages: -1 } },
    { result: [], result_info: { total_count: -1 } },
    { result: [], result_info: { per_page: 0 } },
    { result: [], result_info: { cursor: 123 } },
  ]) {
    const local = await stub(() => ({ body }));
    try {
      await assert.rejects(
        inventory(
          operatorAPI('synthetic-only', { fetch: local.fetch }),
          `${account}/secrets_store/stores/${'b'.repeat(32)}/secrets`
        ),
        /schema changed/
      );
      assert.equal(local.requests.length, 1);
    } finally {
      await local.close();
    }
  }
});

test('Worker script listing rejects unavailable, paginated, and changed inventories', async () => {
  for (const scenario of [
    { status: 404, error: /Inventory unavailable/ },
    { status: 503, error: /Cloudflare HTTP 503/ },
    { body: { result: { scripts: [] } }, error: /response schema changed/ },
    { body: { result: [{}] }, error: /Inventory Worker ID/ },
    { body: { result: [], cursor: 'next-page' }, error: /pagination schema changed/ },
    {
      body: { result: [], result_info: { total_pages: 2 } },
      error: /pagination schema changed/,
    },
    {
      body: { result: [], result_info: { next_cursor: 'next-page' } },
      error: /pagination schema changed/,
    },
  ]) {
    const local = await stub(() => scenario);
    try {
      await assert.rejects(
        listWorkerScripts(operatorAPI('synthetic-only', { fetch: local.fetch })),
        scenario.error
      );
      assert.deepEqual(local.requests, [{ method: 'GET', path: `${account}/workers/scripts` }]);
    } finally {
      await local.close();
    }
  }
});

test('cursor pagination visits all pages and rejects repeated cursors', async () => {
  const paths = [];
  const values = await inventory(
    async (_method, path) => {
      paths.push(path);
      return paths.length === 1
        ? { result: { secrets: [{ id: 'first' }], cursor: 'next/page' } }
        : { result: { secrets: [{ id: 'last' }] } };
    },
    `${account}/secrets_store/stores/${'a'.repeat(32)}/secrets`,
    result => result.secrets
  );
  assert.deepEqual(
    values.map(row => row.id),
    ['first', 'last']
  );
  assert(paths[1].includes('cursor=next%2Fpage'));
  await assert.rejects(
    inventory(
      async () => ({ result: [], result_info: { cursor: 'repeat' } }),
      `${account}/secrets_store/stores/${'a'.repeat(32)}/secrets`
    ),
    /cursor repeated/
  );
});

test('cluster persists PASS only after cleanup and records cleanup failure despite workload success', async () => {
  const writes = [];
  let finish;
  const pending = finalizeClusterResult(
    { workloadPassed: true, passed: false },
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    value => writes.push(structuredClone(value))
  );
  assert.equal(writes.length, 0);
  finish();
  await pending;
  assert.equal(writes[0].passed, true);
  await finalizeClusterResult(
    { workloadPassed: true },
    async () => {
      throw Error('teardown failed');
    },
    value => writes.push(value)
  );
  assert.equal(writes[1].passed, false);
  assert.equal(writes[1].cleanup.error, 'teardown failed');
});

test('attestation refresh demands renewed explicit GO without changing frozen source/lifetime/budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-attestation-'));
  try {
    const configFile = join(root, 'config.json');
    const attestationFile = join(root, 'attestation.json');
    writeFileSync(configFile, 'frozen-workload');
    const manifest = {
      runID: 'operator-probe',
      configHash: 'config',
      resourceCreatedAt: 123,
      independentWatchdogID: 'watchdog',
    };
    const config = {
      runID: manifest.runID,
      attestationFile,
      sdkModuleHash: 'sdk',
      nativeModuleHash: 'native',
      stopAt: 456,
    };
    const value = {
      runID: manifest.runID,
      issuedAt: Date.now(),
      targetManifestHash: 'target',
      configHashes: [sha256(readFileSync(configFile))],
      budgetHash: 'budget',
      configHash: 'config',
      sdkModuleHash: 'sdk',
      nativeModuleHash: 'native',
      resourceCreatedAt: 123,
      teardownAt: 456,
      watchdogInstanceID: 'watchdog',
      inspection: { checkedAt: Date.now() },
    };
    const save = input => {
      writeFileSync(attestationFile, JSON.stringify(input));
      return sha256(readFileSync(attestationFile));
    };
    const go = { targetManifestHash: 'target', budgetHash: 'budget', attestationHash: save(value) };
    assert.doesNotThrow(() => validateAttestation(config, manifest, go, configFile));
    const renewedHash = save({
      ...value,
      issuedAt: Date.now() + 1,
      inspection: { checkedAt: Date.now(), refreshed: true },
    });
    assert.throws(
      () => validateAttestation(config, manifest, go, configFile),
      /Parent GO must renew/
    );
    save(value);
    for (const change of [
      { budgetHash: 'different' },
      { configHash: 'different' },
      { sdkModuleHash: 'different' },
      { teardownAt: 457 },
      { resourceCreatedAt: 124 },
      { issuedAt: Date.now() - 60001 },
    ]) {
      go.attestationHash = save({ ...value, ...change });
      assert.throws(() => validateAttestation(config, manifest, go, configFile));
    }
    go.attestationHash = save({ ...value, inspection: { refreshed: true } });
    assert.notEqual(go.attestationHash, renewedHash);
    assert.equal(validateAttestation(config, manifest, go, configFile).refreshed, true);
    writeFileSync(configFile, 'changed-workload');
    assert.throws(() => validateAttestation(config, manifest, go, configFile));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable reviewed generator paths and signed-31-bit unchanged limiter policies', () => {
  assert.doesNotThrow(() =>
    assertGenerator({
      host: 'owned-load.example.test',
      root: '/srv/load/run-123',
      repository: '/opt/source/cloud',
    })
  );
  for (const root of ['/srv/load/../other', '/srv/load/./run', '/srv/load//run', '/'])
    assert.throws(() =>
      assertGenerator({ host: 'owned-load.example.test', root, repository: '/opt/source/cloud' })
    );
  assert.throws(() =>
    assertGenerator({
      host: '-oProxyCommand=evil',
      root: '/srv/load/run',
      repository: '/opt/source/cloud',
    })
  );
  for (let index = 0; index < 1000; index++) {
    const rows = limiterConfig(`operator-${index}`);
    assert.equal(new Set(rows.map(row => row.namespace_id)).size, 5);
    assert(
      rows.every(row => Number(row.namespace_id) > 0 && Number(row.namespace_id) <= 2147483647)
    );
    assert.deepEqual(
      rows.map(row => row.simple),
      [120, 60, 1200, 300, 120].map(limit => ({ limit, period: 60 }))
    );
  }
});

test('deployed limiter collision refuses admission instead of changing limits or IDs', async () => {
  const namespaceIDs = limiterConfig('operator-probe').map(row => row.namespace_id);
  const local = await stub(() => ({
    body: { result: { bindings: [{ type: 'ratelimit', namespace_id: namespaceIDs[0] }] } },
  }));
  try {
    await assert.rejects(
      assertUnusedLimiters(
        operatorAPI('synthetic-only', { fetch: local.fetch }),
        [{ id: 'Mixed_worker_' + 'a'.repeat(242) }],
        namespaceIDs
      ),
      /already shared/
    );
    assert.equal(local.requests.length, 1);
    assert.equal(local.requests[0].method, 'GET');
  } finally {
    await local.close();
  }
});

test('unavailable bucket metadata cannot prevent already-verified owned Worker cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-independent-cleanup-'));
  const manifest = { ...identity(), configFile: join(root, 'wrangler.json'), namespaces: [] };
  writeFileSync(
    manifest.configFile,
    JSON.stringify({
      vars: {},
      hyperdrive: [],
      r2_buckets: [],
      analytics_engine_datasets: [],
      secrets_store_secrets: [],
      ratelimits: [],
    })
  );
  let workerDeleted = false;
  const order = [];
  const local = await stub(request => {
    order.push(request.url);
    if (request.url.endsWith('/deployments'))
      return {
        body: {
          result: {
            deployments: [
              {
                id: manifest.deploymentID,
                created_on: '2026-11-06',
                versions: [{ percentage: 100, version_id: manifest.versionID }],
              },
            ],
          },
        },
      };
    if (request.url.endsWith(`/versions/${manifest.versionID}`))
      return {
        body: {
          result: {
            id: manifest.versionID,
            annotations: { 'workers/tag': manifest.runID },
            resources: { bindings: [] },
          },
        },
      };
    if (request.url.includes('/r2/buckets/')) return { status: 503 };
    if (request.url.includes('/hyperdrive/configs/')) return { status: 404 };
    return { body: { result: [] } };
  });
  try {
    const deadline = Date.now() + 10000;
    const raw = operatorAPI('synthetic-only', { fetch: local.fetch, deadline });
    const api = (method, path) =>
      retryTransient(() => raw(method, path), deadline, { sleep: async () => {} });
    const proof = { operations: [], errors: [] };
    await cleanupOwned(
      manifest,
      api,
      async args => {
        assert.equal(args[0], 'delete');
        assert.equal(args[1], manifest.workerName);
        assert(!order.some(path => path.includes('/r2/buckets/')));
        workerDeleted = true;
      },
      proof,
      () => {}
    );
    assert.equal(workerDeleted, true);
    assert(proof.operations.some(row => row.name === 'delete_worker'));
    assert(proof.errors.some(row => row.name === 'delete_bucket'));
    assert.equal(proof.remaining.bucket, null);
    assert.deepEqual(proof.remaining.worker, []);
  } finally {
    await local.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('multiple cleanup resources consume one shared tail rather than fresh per-resource deadlines', async () => {
  let now = 0;
  let attempts = 0;
  const options = {
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
  };
  const action = async () => {
    attempts++;
    throw new OperatorHTTPError(503);
  };
  const deadline = 2000;
  await assert.rejects(retryTransient(action, deadline, options));
  assert.equal(now, 1750);
  assert.equal(attempts, 4);
  await assert.rejects(retryTransient(action, deadline, options));
  assert.equal(attempts, 5);
  now = deadline;
  await assert.rejects(retryTransient(action, deadline, options), /deadline/);
  assert.equal(attempts, 5);
});

async function cliFixture(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'operator-spawned-cli-'));
  const bin = join(root, 'node_modules/.bin/wrangler');
  const stateFile = join(root, 'state.json');
  const state = {
    calls: [],
    workerPresent: true,
    bucketPresent: ['transient', 'ambiguous'].includes(scenario),
    objectPresent: true,
    replacement: false,
  };
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)};
const scenario = ${JSON.stringify(scenario)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(4);
const kind = args[0] === 'delete' ? 'worker' : args[1] === 'object' ? (args[2] === 'get' ? 'object_get' : 'object') : 'bucket';
state.calls.push(kind);
const attempt = state.calls.filter(value => value === kind).length;
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const fail = text => { save(); console.error('SYNTHETIC_PRIVATE_CLI_MARKER ' + text); process.exitCode = 1; };
if (kind === 'object_get') {
  if (!state.objectPresent) fail('HTTP 404 NoSuchKey');
  else {
    save();
    const body = Buffer.alloc(8 * 1024 * 1024, 's');
    const destination = args.indexOf('--file');
    if (destination >= 0) {
      fs.writeFileSync(args[destination + 1], body);
      process.stdout.write('Downloaded synthetic object');
    } else process.stdout.write(body);
  }
} else if (['authorization', 'syntax', 'unknown', 'overflow'].includes(scenario)) {
  fail(scenario === 'authorization' ? 'HTTP 503 HTTP 403 permission denied' : scenario === 'syntax' ? 'HTTP 503 Unknown argument' : scenario === 'overflow' ? 'x'.repeat(131072) + ' HTTP 503' : 'unclassified failure');
} else if (scenario === 'timeout' && attempt === 1) {
  save(); setTimeout(() => {}, 10000);
} else if (scenario === 'replacement') {
  state.replacement = true; fail('HTTP 503');
} else if (scenario === 'transient' && attempt === 1) {
  fail('HTTP 503');
} else {
  state[kind + 'Present'] = false;
  if (scenario === 'ambiguous' && attempt === 1) fail('HTTP 503');
  else { save(); process.exitCode = 0; }
}
`
  );
  chmodSync(bin, 0o700);
  const manifest = {
    ...identity(),
    configFile: join(root, 'wrangler.json'),
    namespaces: [],
    wrangler: bin,
    r2Keys: state.bucketPresent ? ['synthetic/object.json'] : [],
  };
  writeFileSync(
    manifest.configFile,
    JSON.stringify({
      vars: {},
      hyperdrive: [],
      r2_buckets: [],
      analytics_engine_datasets: [],
      secrets_store_secrets: [],
      ratelimits: [],
    })
  );
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const local = await stub(request => {
    const state = readState();
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path.endsWith('/deployments'))
      return state.workerPresent
        ? {
            body: {
              result: {
                deployments: [
                  {
                    id: state.replacement ? 'replacement' : manifest.deploymentID,
                    created_on: '2026-11-06',
                    versions: [{ percentage: 100, version_id: manifest.versionID }],
                  },
                ],
              },
            },
          }
        : { status: 404 };
    if (path.endsWith(`/versions/${manifest.versionID}`))
      return {
        body: {
          result: {
            id: manifest.versionID,
            annotations: { 'workers/tag': manifest.runID },
            resources: { bindings: [] },
          },
        },
      };
    if (path.includes('/r2/buckets/'))
      return state.bucketPresent
        ? { body: { result: { bucketId: manifest.r2BucketID } } }
        : { status: 404 };
    if (path.includes('/hyperdrive/configs/')) return { status: 404 };
    if (path.endsWith('/workers/scripts'))
      return { body: { result: state.workerPresent ? [{ id: manifest.workerName }] : [] } };
    return { body: { result: [] } };
  });
  return {
    manifest,
    readState,
    requests: local.requests,
    run: async (timeoutMs = 30000) => {
      const deadline = Date.now() + 10000;
      const proof = { deadline, operations: [], errors: [] };
      const raw = operatorAPI('synthetic-only', { fetch: local.fetch, deadline });
      const api = (method, path) => retryTransient(() => raw(method, path), deadline);
      await cleanupOwned(
        manifest,
        api,
        (args, options) =>
          runOperatorCLI(manifest, args, deadline, {
            ...options,
            timeoutMs,
            resolveToken: async () => 'synthetic-only-private-token',
          }),
        proof,
        () => {}
      );
      assert(!JSON.stringify(proof).includes('SYNTHETIC_PRIVATE_CLI_MARKER'));
      assert(!JSON.stringify(proof).includes('synthetic-only-private-token'));
      return proof;
    },
    close: async () => {
      await local.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('spawned private CLI retries deletions with ownership checks and a large object', async () => {
  const fixture = await cliFixture('transient');
  try {
    const proof = await fixture.run();
    assert.deepEqual(proof.errors, []);
    const calls = fixture.readState().calls;
    for (const kind of ['worker', 'object', 'bucket'])
      assert.equal(calls.filter(value => value === kind).length, 2);
    assert.equal(calls.filter(value => value === 'object_get').length, 1);
    assert.equal(fixture.requests.filter(row => row.path.endsWith('/deployments')).length, 2);
    assert.deepEqual(proof.remaining, {
      worker: [],
      namespaces: [],
      bucket: [],
      hyperdrive: [],
      secrets: [],
    });
  } finally {
    await fixture.close();
  }
});

test('ambiguous successful deletes are rechecked absent rather than deleting again', async () => {
  const fixture = await cliFixture('ambiguous');
  try {
    const proof = await fixture.run();
    assert.deepEqual(proof.errors, []);
    const calls = fixture.readState().calls;
    for (const kind of ['worker', 'object', 'bucket'])
      assert.equal(calls.filter(value => value === kind).length, 1);
    assert.equal(calls.filter(value => value === 'object_get').length, 1);
    assert.equal(fixture.requests.filter(row => row.path.endsWith('/deployments')).length, 2);
  } finally {
    await fixture.close();
  }
});

test('replacement between CLI attempts refuses the second delete', async () => {
  const fixture = await cliFixture('replacement');
  try {
    const proof = await fixture.run();
    assert.deepEqual(fixture.readState().calls, ['worker']);
    assert(
      proof.errors.some(
        row => row.name === 'delete_worker' && row.error.includes('ownership changed')
      )
    );
    assert.deepEqual(proof.remaining.worker, [fixture.manifest.workerName]);
  } finally {
    await fixture.close();
  }
});

test('spawned CLI authorization/syntax/unknown/overflow failures are sanitized and never retried', async () => {
  for (const scenario of ['authorization', 'syntax', 'unknown', 'overflow']) {
    const fixture = await cliFixture(scenario);
    try {
      const proof = await fixture.run();
      assert.deepEqual(fixture.readState().calls, ['worker']);
      const error = proof.errors.find(row => row.name === 'delete_worker').error;
      assert.match(
        error,
        /^Operator CLI (authorization_denied|invalid_command|permanent_failure|output_limit)$/
      );
    } finally {
      await fixture.close();
    }
  }
});

test('spawned CLI timeout is bounded and retries only after renewed ownership verification', async () => {
  const fixture = await cliFixture('timeout');
  try {
    const proof = await fixture.run(500);
    assert.deepEqual(proof.errors, []);
    assert.deepEqual(fixture.readState().calls, ['worker', 'worker']);
    assert.equal(fixture.requests.filter(row => row.path.endsWith('/deployments')).length, 2);
  } finally {
    await fixture.close();
  }
});
