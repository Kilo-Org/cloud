import assert from 'node:assert/strict';
import test from 'node:test';
import {
  event,
  fixture,
  Pending,
  prefix,
  seedText,
  session,
  token,
  validateTarget,
  sha256,
  limiterConfig,
  validateCloudAdmission,
  arrivalAllowed,
  validateReceipt,
  assertReceiptRetry,
  histogram,
  observe,
  summarize,
  populationMatches,
} from './perf-common.mjs';
import { currentDeployment } from './perf-identity.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forecast } from './perf-budget.mjs';

const s = session({ runID: 'qualification' }, 99999);
test('event bodies carry unique source markers in exactly 512 bytes', () => {
  const first = event(s, 1, 1793961200000, 1793961200001);
  const last = event(s, 1100, 1793961255000, 1793961255001);
  assert.equal(Buffer.byteLength(JSON.stringify(first.body)), 512);
  assert.equal(Buffer.byteLength(JSON.stringify(last.body)), 512);
  assert.notEqual(first.body.data.id, last.body.data.id);
  assert.equal(last.body.data.data.delta, token(1100));
});
test('durable fixtures contain every committed token and explicit coverage', () => {
  const value = fixture(s, 1100);
  assert.equal(value.sourceSequence, 1100);
  assert.equal(value.message.content[0].text, seedText(s) + prefix(1100));
  assert(Buffer.byteLength(JSON.stringify(value)) <= 8192);
  assert.equal(Buffer.byteLength(JSON.stringify(fixture(s, 0))), 2048);
  assert.match(s.source, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
});
test('pending observations expire and refuse excess population', () => {
  const pending = new Pending(2, 100);
  pending.add('a', 0);
  pending.add('b', 10);
  assert.throws(() => pending.add('c', 20), /budget/);
  pending.expire(105);
  assert.equal(pending.expired, 1);
  assert.equal(pending.take('b'), 10);
  assert.equal(pending.entries.size, 0);
});
const empty = {
  name: 'probe',
  registrations: 0,
  streamingSources: 0,
  sourceTrafficMode: 'all-streaming-sources',
  watched: 0,
  sdkViewers: 0,
  viewerConnections: 0,
  eventHz: 0,
  seeds: 0,
  checkpoints: 0,
  finalCheckpoints: 0,
  receiptRetries: 0,
  reconciliationReads: 0,
  ticketRequests: 0,
  exchanges: 0,
  socketUpgrades: 0,
  incomingWebSocketMessages: 0,
  workerCPUms: 0,
  sqlRowsRead: 0,
  sqlRowsWritten: 0,
  expectedActiveActorSeconds: 1,
  pessimisticActiveActorSeconds: 8000000,
  r2ClassA: 1,
  r2ClassB: 1,
  logpushEvents: 0,
  analyticsPoints: 0,
};
const plan = {
  version: 1,
  stages: [empty],
  vmInstances: 4,
  vmHourlyUSD: 0.776,
  vmHoursEach: 0.5,
  qualificationVMUSD: 1,
  vmDiskAndEgressUSD: 1,
  r2StorageUSD: 0.1,
  sqlStorageUSD: 0.5,
  analyticsUSD: 0.1,
  downstreamLogsUSD: 0.5,
  delayedBillingReserveUSD: 10,
  alreadySpentUSD: 0,
  hardLimitUSD: 50,
  workerStoredLogsEnabled: false,
  absoluteResourceDeadlineSeconds: 300,
};
test('gross forecast rounds DO duration and R2 units upward', () => {
  const result = forecast(plan);
  assert.equal(result.durationExpectedUSD, 12.5);
  assert.equal(result.durationPessimisticUSD, 25);
  assert.equal(result.fixed.r2ClassA + result.fixed.r2ClassB, 4.86);
  assert.equal(result.invoiceGuarantee, false);
});
test('pessimistic ceiling includes VM time and delayed billing reserve', () => {
  const result = forecast({ ...plan, stages: [{ ...empty, sqlRowsWritten: 15000000 }] });
  assert.equal(result.passed, false);
  assert(result.committedCeilingUSD > 50);
  assert(result.vmUSD > 3);
});

test('forecast caps retain legacy defaults and bound explicit allocations', () => {
  const legacy = { ...plan };
  delete legacy.hardLimitUSD;
  assert.equal(forecast(legacy).hardLimitUSD, 50);
  for (const funds of [{}, { alreadySpentUSD: 7.25, delayedBillingReserveUSD: 20 }]) {
    const result = forecast({ ...plan, ...funds });
    assert(
      Math.abs(
        result.targets.cloudflareUSD +
          result.targets.vmUSD +
          result.targets.delayedReserveUSD +
          result.alreadySpentUSD -
          result.hardLimitUSD
      ) < 1e-9
    );
  }
  for (const cap of [49, 100.01, Infinity]) {
    assert.throws(() => forecast({ ...plan, hardLimitUSD: cap }));
  }
  const input = {
    ...plan,
    hardLimitUSD: 100,
    stages: [{ ...empty, sqlRowsWritten: 50000000 }],
  };
  const result = forecast(input);
  assert.equal(result.passed, true);
  assert.equal(result.hardLimitUSD, 100);
  assert.equal(result.targets.cloudflareUSD, 85);
  assert.equal(forecast({ ...input, hardLimitUSD: 50 }).passed, false);
  const remaining = result.targets.cloudflareUSD - result.pessimisticCFUSD;
  assert.equal(forecast({ ...input, alreadySpentUSD: remaining }).passed, true);
  assert.equal(forecast({ ...input, alreadySpentUSD: remaining + 0.01 }).passed, false);
  assert.equal(
    forecast({ ...input, stages: [{ ...empty, sqlRowsWritten: 80000000 }] }).passed,
    false
  );
  assert.equal(forecast({ ...input, qualificationVMUSD: 6 }).passed, false);
});

test('reserved and spent funds cannot be reused by the Cloudflare target', () => {
  const input = { ...plan, hardLimitUSD: 100, alreadySpentUSD: 7.25, delayedBillingReserveUSD: 20 };
  const initial = forecast(input);
  const result = forecast({
    ...input,
    stages: [
      {
        ...empty,
        sqlRowsWritten: (initial.targets.cloudflareUSD + 0.01 - initial.pessimisticCFUSD) * 1e6,
      },
    ],
  });
  assert(result.committedCeilingUSD < result.hardLimitUSD);
  assert.equal(result.passed, false);
});

function targetFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-load-guard-'));
  const now = Date.now();
  const runID = 'guard-check';
  const name = `session-sync-${runID}-loadtest`;
  const configFile = join(root, 'config.json');
  const evidenceFile = join(root, 'evidence.json');
  const preProvisionEvidenceFile = join(root, 'absent.json');
  const watchdogReadyFile = join(root, 'watchdog.json');
  const rendered = {
    name,
    account_id: 'e115e769bcdd4c3d66af59d3332cb394',
    workers_dev: true,
    observability: { enabled: false },
    logpush: true,
    vars: {
      ENVIRONMENT: 'staging',
      USER_TENANT_SESSIONS: '10000',
      USER_TENANT_BYTES: '107374182400',
      ORGANIZATION_TENANT_SESSIONS: '200000',
      ORGANIZATION_TENANT_BYTES: '2199023255552',
    },
    ratelimits: limiterConfig(runID),
    hyperdrive: [{ binding: 'HYPERDRIVE', id: 'bb58259a7dd9454487b333b6b10dfafe' }],
    r2_buckets: [{ binding: 'SESSION_SYNC_R2', bucket_name: name }],
    analytics_engine_datasets: [
      { binding: 'SESSION_SYNC_METRICS', dataset: 'session_sync_guard_check_loadtest_metrics' },
    ],
    durable_objects: {
      bindings: [
        { name: 'SESSION_SYNC_DO', class_name: 'SessionSyncDO' },
        { name: 'SESSION_SYNC_TENANT_DO', class_name: 'SessionSyncTenantDO' },
        { name: 'SESSION_RELAY_DO', class_name: 'SessionRelayDO' },
        { name: 'SESSION_PRESENCE_DO', class_name: 'SessionPresenceDO' },
      ],
    },
    secrets_store_secrets: [
      'NEXTAUTH_SECRET',
      'SESSION_SYNC_SECRET',
      'INTERNAL_API_SECRET_PROD',
    ].map(binding => ({
      binding,
      store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
      secret_name: binding + '_STAGING_LOADTEST',
    })),
  };
  const inventory = {
    runID,
    workerName: name,
    checkedAt: now - 2000,
    workerAbsent: true,
    bucketAbsent: true,
    hyperdriveAbsent: true,
    secretsAbsent: true,
    limiterNamespacesUnused: true,
  };
  const inspection = {
    runID,
    workerName: name,
    baseURL: `https://${name}.synthetic.workers.dev/`,
    checkedAt: now - 1,
    deploymentID: 'owned-deployment',
    versionID: 'owned-version',
    r2BucketID: 'owned-bucket',
    r2Private: true,
    databaseTLS: true,
  };
  writeFileSync(preProvisionEvidenceFile, JSON.stringify(inventory));
  writeFileSync(evidenceFile, JSON.stringify(inspection));
  const namespaces = rendered.durable_objects.bindings.map((binding, index) => ({
    binding: binding.name,
    id: String(index + 1).repeat(32),
  }));
  const manifest = {
    runID,
    accountID: rendered.account_id,
    workerName: name,
    baseURL: `https://${name}.synthetic.workers.dev/`,
    productionBindings: false,
    syntheticDatabase: true,
    independentSigningSecrets: true,
    hyperdriveCaching: false,
    r2Bucket: name,
    routes: [],
    services: [],
    secretNames: rendered.secrets_store_secrets.map(row => row.secret_name),
    hyperdriveID: rendered.hyperdrive[0].id,
    secretsStoreID: '342a86d9e3a94da698e82d0c6e2a36f0',
    configFile,
    evidenceFile,
    evidenceHash: sha256(JSON.stringify(inspection)),
    preProvisionEvidenceFile,
    preProvisionEvidenceHash: sha256(JSON.stringify(inventory)),
    independentWatchdogID: 'owned-watchdog',
    watchdogReadyFile,
    resourceCreatedAt: now - 1000,
    teardownArmedAt: now - 1,
    teardownAt: now + 120000,
    teardownTailSeconds: 150,
    namespaces,
    namespaceIDs: namespaces.map(row => row.id),
    deploymentID: inspection.deploymentID,
    versionID: inspection.versionID,
    r2BucketID: inspection.r2BucketID,
  };
  const config = {
    runID,
    baseURL: manifest.baseURL,
    stopAt: manifest.teardownAt,
    budgetStage: 'unit',
    sessions: 1,
    streamingSources: 1,
    sourceTrafficMode: 'all-streaming-sources',
    watched: 1,
    sdkViewers: 1,
    eventHz: 10,
    warmSeconds: 10,
    measuredSeconds: 45,
  };
  const ready = (value = manifest, at = now) =>
    writeFileSync(
      watchdogReadyFile,
      JSON.stringify({
        runID,
        workerName: name,
        deploymentID: value.deploymentID,
        versionID: value.versionID,
        instanceID: value.independentWatchdogID,
        pid: process.pid,
        heartbeatAt: at,
        teardownAt: value.teardownAt,
      })
    );
  ready();
  const validate = value => {
    const bytes = JSON.stringify(value);
    writeFileSync(configFile, bytes);
    validateTarget(config, { ...manifest, configHash: sha256(bytes) });
  };
  validate(rendered);
  return {
    root,
    manifest,
    config,
    rendered,
    validate,
    ready,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('cloud identity guard rejects aliases and duplicate log storage', () => {
  const f = targetFixture();
  try {
    assert.throws(() =>
      f.validate({ ...f.rendered, kv_namespaces: [{ binding: 'UNREVIEWED', id: 'remote' }] })
    );
    assert.throws(() =>
      f.validate({
        ...f.rendered,
        analytics_engine_datasets: [{ binding: 'SESSION_SYNC_METRICS', dataset: 'unapproved' }],
      })
    );
    assert.throws(() => f.validate({ ...f.rendered, observability: { enabled: true } }));
  } finally {
    f.dispose();
  }
});

test('limiter admission rejects shared namespaces and changed policy', () => {
  const f = targetFixture();
  try {
    const shared = structuredClone(f.rendered.ratelimits);
    shared[0].namespace_id = '1020';
    assert.throws(() => f.validate({ ...f.rendered, ratelimits: shared }), /limiter policies/);
    const raised = structuredClone(f.rendered.ratelimits);
    raised[0].simple.limit++;
    assert.throws(() => f.validate({ ...f.rendered, ratelimits: raised }), /limiter policies/);
  } finally {
    f.dispose();
  }
});

const allowedBudget = {
  passed: true,
  pessimisticCFUSD: 30,
  vmUSD: 4,
  reserveUSD: 10,
  alreadySpentUSD: 0,
  committedCeilingUSD: 44,
  absoluteResourceDeadlineSeconds: 300,
  workloadBounds: [
    {
      name: 'unit',
      sessions: 1,
      streamingSources: 1,
      sourceTrafficMode: 'all-streaming-sources',
      watched: 1,
      sdkViewers: 1,
      viewerConnections: 1,
      eventHz: 10,
      checkpoints: 11,
      finalCheckpoints: 1,
      incomingWebSocketMessages: 600,
      ticketRequests: 4,
    },
  ],
};
test('cloud admission enforces bounded cumulative caps, not just passed', () => {
  const f = targetFixture();
  try {
    const budget = {
      ...allowedBudget,
      hardLimitUSD: 100,
      pessimisticCFUSD: 85,
      vmUSD: 5,
      reserveUSD: 10,
      alreadySpentUSD: 0,
      committedCeilingUSD: 100,
    };
    for (const change of [
      { hardLimitUSD: 50 },
      { hardLimitUSD: 101 },
      { hardLimitUSD: NaN },
      { pessimisticCFUSD: 85.01 },
      { vmUSD: 5.01 },
      { reserveUSD: 9.99 },
      { alreadySpentUSD: 0.01 },
      { alreadySpentUSD: -1 },
      { alreadySpentUSD: undefined },
      { alreadySpentUSD: NaN },
      { reserveUSD: Infinity },
      { committedCeilingUSD: 100.01 },
    ]) {
      assert.throws(() => validateCloudAdmission(f.config, f.manifest, { ...budget, ...change }));
    }
  } finally {
    f.dispose();
  }
});
test('cloud admission requires a matching live watchdog heartbeat', () => {
  const f = targetFixture();
  try {
    rmSync(f.manifest.watchdogReadyFile);
    assert.throws(() => validateCloudAdmission(f.config, f.manifest, allowedBudget), /ENOENT/);
    f.ready(f.manifest, Date.now() - 11000);
    assert.throws(
      () => validateCloudAdmission(f.config, f.manifest, allowedBudget),
      /heartbeat is stale/
    );
    f.ready({ ...f.manifest, independentWatchdogID: 'another-watchdog' });
    assert.throws(() => validateCloudAdmission(f.config, f.manifest, allowedBudget));
  } finally {
    f.dispose();
  }
});
test('resource deadline and teardown tail fit the priced lifetime', () => {
  const f = targetFixture();
  try {
    const extended = { ...f.manifest, teardownAt: Date.now() + 600000 };
    f.ready(extended);
    assert.throws(
      () =>
        validateCloudAdmission(
          { ...f.config, stopAt: extended.teardownAt },
          extended,
          allowedBudget
        ),
      /Resource lifetime/
    );
    f.ready();
    assert.throws(() =>
      validateCloudAdmission(f.config, f.manifest, { ...allowedBudget, passed: false })
    );
  } finally {
    f.dispose();
  }
});
test('fixed drain excludes wire and projection completion at or after cutoff', () => {
  const window = { drainAt: 100 };
  let accepted = 0;
  for (const at of [99, 100, 101]) if (arrivalAllowed(window, at)) accepted++;
  assert.equal(accepted, 1);
  assert.equal(arrivalAllowed(window, 100), false);
});
test('exact durable receipt validates request bytes and original retry response', () => {
  const source = { id: 'ses_receipt', revision: 4 };
  const batch = {
    batchID: '2ca8a62b-d277-47c8-b70a-447a20d3b0c0',
    after: 3,
    through: 4,
    changes: [],
  };
  const value = {
    version: 1,
    sessionID: source.id,
    batchID: batch.batchID,
    after: 3,
    through: 4,
    revision: 5,
    changes: 0,
    digest: sha256(JSON.stringify(batch)),
    committedAt: 123,
  };
  const original = validateReceipt(source, batch, value);
  for (const field of ['after', 'revision', 'changes', 'committedAt'])
    assert.throws(() => assertReceiptRetry(original, { ...value, [field]: value[field] + 1 }));
  assert.throws(() => validateReceipt(source, batch, { ...value, digest: 'f'.repeat(64) }));
});
function targetFixtureForIdentity() {
  return {
    accountID: 'e115e769bcdd4c3d66af59d3332cb394',
    runID: 'identity-probe',
    workerName: 'session-sync-identity-probe-loadtest',
    r2Bucket: 'session-sync-identity-probe-loadtest',
    hyperdriveID: 'a'.repeat(32),
    secretsStoreID: 'b'.repeat(32),
    versionID: 'owned-version',
    r2BucketID: 'owned-bucket',
  };
}
test('replacement deployment is refused before settings or deletion', async () => {
  let calls = 0;
  await assert.rejects(
    currentDeployment({ ...targetFixtureForIdentity(), deploymentID: 'original' }, async () => {
      calls++;
      return {
        result: {
          deployments: [{ id: 'replacement', created_on: '2026-11-06T00:00:00Z', versions: [] }],
        },
      };
    }),
    /ownership changed/
  );
  assert.equal(calls, 1);
});
test('latency summaries retain negative clock and overflow counts', () => {
  const h = histogram();
  observe(h, -2);
  observe(h, 12000);
  const result = summarize(h);
  assert.equal(result.negative, 1);
  assert.equal(result.overflow, 1);
  assert.equal(result.max, 12000);
});

test('full cloud plan keeps one SDK viewer per watched session and creates no GO', () => {
  const f = targetFixture();
  try {
    const budgetFile = join(f.root, 'budget.json');
    writeFileSync(budgetFile, JSON.stringify({ ...allowedBudget, passed: false }));
    const manifestFile = join(f.root, 'manifest.json');
    const manifest = {
      ...f.manifest,
      configHash: sha256(readFileSync(f.manifest.configFile)),
      budgetFile,
      sdkModuleHash: 'a'.repeat(64),
      clockErrorBoundMs: 5,
      clockEvidenceFile: join(f.root, 'clock.json'),
      generators: Array.from({ length: 4 }, (_, index) => ({
        host: `igor-loadtest-${index}.us-central1-a.kilocode`,
        repository: '/home/igor/work/load',
        root: '/home/igor/work/load/run-guard',
      })),
    };
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const output = join(f.root, 'plan');
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./perf-plan.mjs', import.meta.url)), 'full', manifestFile, output],
      { encoding: 'utf8' }
    );
    assert.equal(child.status, 0, child.stderr);
    const cluster = JSON.parse(readFileSync(join(output, 'cluster.json'), 'utf8'));
    assert.equal(cluster.viewerConnections, 10000);
    assert.equal(cluster.streamingSources, 100000);
    assert.equal(cluster.watched, 10000);
    assert.equal(cluster.sdkViewers, 10000);
    assert.equal(cluster.eventHz, 10);
    assert.equal(cluster.sourceTrafficMode, 'all-streaming-sources');
    const ownership = new Uint8Array(cluster.sessions);
    let assignedViewers = 0;
    let assignedStreamingSources = 0;
    for (const [nodeIndex, node] of cluster.nodes.entries()) {
      for (const shard of node.shards) {
        const part = JSON.parse(
          readFileSync(join(output, `node-${nodeIndex}/config-${shard}.json`), 'utf8')
        );
        for (let index = part.shard; index < part.sessions; index += part.shards) {
          ownership[index]++;
          if (index < part.sdkViewers) assignedViewers++;
          if (index < part.streamingSources) assignedStreamingSources++;
        }
      }
    }
    assert(
      ownership.every(count => count === 1),
      'Every session must have exactly one publisher'
    );
    assert.equal(assignedViewers, 10000);
    assert.equal(assignedStreamingSources, 100000);
    const config = JSON.parse(readFileSync(join(output, 'node-0/config-0.json'), 'utf8'));
    assert.equal(config.sdkViewers, config.watched);
    assert.equal(config.streamingSources, 100000);
    assert.equal(config.sourceTrafficMode, 'all-streaming-sources');
    assert.equal(existsSync(join(output, 'node-0/go.json')), false);
    const fundedBudget = {
      ...allowedBudget,
      hardLimitUSD: 100,
      pessimisticCFUSD: 50,
      vmUSD: 5,
      reserveUSD: 20,
      alreadySpentUSD: 25,
      committedCeilingUSD: 100,
      workloadBounds: [
        {
          name: '100k-streaming-10k-sdk-10hz-512b-10warm-45measure-10drain',
          sessions: 100000,
          streamingSources: 100000,
          sourceTrafficMode: 'all-streaming-sources',
          watched: 10000,
          sdkViewers: 10000,
          viewerConnections: 10000,
          eventHz: 10,
          checkpoints: 1100000,
          finalCheckpoints: 100000,
          incomingWebSocketMessages: 55000000,
          ticketRequests: 260000,
        },
      ],
    };
    const fundedBudgetFile = join(f.root, 'funded-budget.json');
    writeFileSync(fundedBudgetFile, JSON.stringify(fundedBudget));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, budgetFile: fundedBudgetFile }));
    const planURL = new URL('./perf-plan.mjs', import.meta.url);
    const identityURL = new URL('./perf-identity.mjs', import.meta.url);
    // Only external deployment metadata is a fixture; planner and admission remain real.
    const metadata =
      'data:text/javascript,' +
      encodeURIComponent(`
      export * from ${JSON.stringify(identityURL.href)};
      import { readFileSync } from 'node:fs';
      export async function inspectLive(manifest) {
        return JSON.parse(readFileSync(manifest.evidenceFile, 'utf8'));
      }
    `);
    const preload =
      'data:text/javascript,' +
      encodeURIComponent(`
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === './perf-identity.mjs' && context.parentURL === ${JSON.stringify(planURL.href)})
          return { url: ${JSON.stringify(metadata)}, shortCircuit: true };
        return next(specifier, context);
      }});
    `);
    const runPlan = (mode, destination) =>
      spawnSync(
        process.execPath,
        ['--import', preload, fileURLToPath(planURL), mode, manifestFile, destination],
        { encoding: 'utf8' }
      );
    const funded = join(f.root, 'funded-plan');
    const prepared = runPlan('full', funded);
    assert.equal(prepared.status, 0, prepared.stderr);
    const admitted = runPlan('refresh', funded);
    assert.equal(admitted.status, 0, admitted.stderr);
    const attestation = JSON.parse(readFileSync(join(funded, 'node-0/attestation.json'), 'utf8'));
    assert.equal(attestation.budgetHash, sha256(JSON.stringify(fundedBudget)));
    assert.equal(existsSync(join(funded, 'node-0/go.json')), false);
    delete fundedBudget.alreadySpentUSD;
    writeFileSync(fundedBudgetFile, JSON.stringify(fundedBudget));
    const rejected = join(f.root, 'missing-spend-plan');
    const unapproved = runPlan('full', rejected);
    assert.equal(unapproved.status, 0, unapproved.stderr);
    const denied = runPlan('refresh', rejected);
    assert.notEqual(denied.status, 0);
    assert.equal(existsSync(join(rejected, 'node-0/attestation.json')), false);
  } finally {
    f.dispose();
  }
});

test('cloud origin must match the live account inspection', () => {
  const f = targetFixture();
  try {
    const evidence = JSON.parse(readFileSync(f.manifest.evidenceFile, 'utf8'));
    writeFileSync(
      f.manifest.evidenceFile,
      JSON.stringify({ ...evidence, baseURL: 'https://unowned.workers.dev/' })
    );
    assert.throws(
      () => validateCloudAdmission(f.config, f.manifest, allowedBudget),
      /Origin differs/
    );
  } finally {
    f.dispose();
  }
});

test('forecast retains independent source and consumer population metadata', () => {
  const workload = {
    ...empty,
    registrations: 100000,
    streamingSources: 100000,
    watched: 10000,
    sdkViewers: 10000,
    viewerConnections: 10000,
    eventHz: 10,
  };
  const bound = forecast({ ...plan, stages: [workload] }).workloadBounds[0];
  assert.equal(bound.streamingSources, 100000);
  assert.equal(bound.watched, 10000);
  assert.equal(bound.sdkViewers, 10000);
  assert.equal(bound.viewerConnections, 10000);
  assert.equal(bound.sourceTrafficMode, 'all-streaming-sources');
  assert.equal(bound.eventHz, 10);
});

test('cloud admission rejects watched-only budgets for the full streaming-source workload', () => {
  const f = targetFixture();
  try {
    const config = {
      ...f.config,
      sessions: 100000,
      streamingSources: 100000,
      watched: 10000,
      sdkViewers: 10000,
    };
    const stage = {
      name: config.budgetStage,
      sessions: 100000,
      streamingSources: 100000,
      sourceTrafficMode: 'all-streaming-sources',
      watched: 10000,
      sdkViewers: 10000,
      viewerConnections: 10000,
      eventHz: 10,
      checkpoints: 1100000,
      finalCheckpoints: 100000,
      incomingWebSocketMessages: 55000000,
      ticketRequests: 210000,
    };
    const admit = change =>
      validateCloudAdmission(config, f.manifest, {
        ...allowedBudget,
        workloadBounds: [{ ...stage, ...change }],
      });
    assert.doesNotThrow(() => admit({}));
    for (const change of [
      { streamingSources: 10000 },
      { sourceTrafficMode: undefined },
      { sdkViewers: 0 },
      { viewerConnections: 9999 },
      { incomingWebSocketMessages: 5500000 },
      { ticketRequests: 120000 },
    ])
      assert.throws(() => admit(change));
    const ready = {
      presence: 100000,
      runners: 100000,
      streamingSources: 100000,
      watched: 10000,
      sdkViewers: 10000,
      viewers: 10000,
    };
    assert.equal(populationMatches(ready, ready), true);
    for (const key of Object.keys(ready)) {
      assert.equal(populationMatches({ ...ready, [key]: ready[key] - 1 }, ready), false);
    }
  } finally {
    f.dispose();
  }
});
