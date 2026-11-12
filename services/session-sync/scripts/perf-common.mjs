import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { assertManifestIdentity, checkWatchdog } from './perf-identity.mjs';

export const nativeSHA = '5b3069885d3223b96fdf1b1db51a7bda54e566e8';
export const nativeBundleHash = '9388572658ea4c0a6a3184e872485f51e4959637cafd369fea4d4b70885b6120';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const receiptSchema = z.strictObject({
  version: z.literal(1),
  sessionID: z.string(),
  batchID: z.uuid(),
  after: z.number().int().nonnegative(),
  through: z.number().int().positive(),
  revision: z.number().int().positive(),
  changes: z.number().int().nonnegative(),
  digest,
  committedAt: z.number().int(),
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  runID: z.string().regex(/^[a-z0-9-]{3,32}$/),
  mode: z.enum(['local', 'cloud']),
  baseURL: z.url(),
  nativeSHA: z.literal(nativeSHA),
  nativeModule: z.string(),
  nativeModuleHash: z.literal(nativeBundleHash),
  sdkModule: z.string(),
  sdkModuleHash: digest,
  instrumentSDK: z.boolean().default(false),
  root: z.string(),
  keysFile: z.string(),
  sessions: positive.max(100000),
  streamingSources: positive.max(100000),
  sourceTrafficMode: z.literal('all-streaming-sources'),
  watched: positive.max(10000),
  sdkViewers: z.number().int().min(0).max(10000),
  rawViewers: z.number().int().min(0).max(10000).default(0),
  rawMirror: z.boolean().default(false),
  shard: z.number().int().min(0),
  shards: positive.max(64),
  eventHz: positive.max(20),
  warmSeconds: positive.max(10),
  measuredSeconds: positive.max(45),
  drainSeconds: positive.max(10),
  startAt: positive,
  stopAt: positive,
  checkpointSeconds: z.literal(5),
  maxRequests: positive,
  requestConcurrency: positive.min(65).max(512),
  pendingLimit: positive.max(200000),
  pendingTTLms: positive.max(10000),
  maxBufferedBytes: positive.max(1048576),
  audience: z.enum(['development', 'staging']),
  organizationID: z.string().optional(),
  rawCopies: positive.max(100).default(1),
  rawPauseSeconds: z.number().int().min(0).max(30).default(0),
  grantTTLseconds: positive.min(35).max(300).default(300),
  targetManifest: z.string().optional(),
  budgetStage: z.string().optional(),
  goFile: z.string().optional(),
  attestationFile: z.string().optional(),
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function populationMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function readConfig(path) {
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const url = new URL(config.baseURL);
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
  assert(
    config.watched <= config.streamingSources &&
      config.streamingSources <= config.sessions &&
      config.sdkViewers <= config.watched,
    'Viewer-backed sessions must be streaming sources within the registered population'
  );
  assert.equal(
    config.rawMirror
      ? Math.max(config.sdkViewers, config.rawViewers)
      : config.sdkViewers + config.rawViewers,
    config.watched,
    'Every watched session must have its declared viewer'
  );
  assert(config.shard < config.shards);
  assert(config.stopAt > Date.now() && config.stopAt - Date.now() <= 15 * 60 * 1000);
  assert(
    config.startAt + (config.warmSeconds + config.measuredSeconds + config.drainSeconds) * 1000 <=
      config.stopAt
  );
  assert.equal(statSync(config.keysFile).mode & 0o077, 0, 'Keys must be private');
  for (const [file, hash] of [
    [config.nativeModule, config.nativeModuleHash],
    [config.sdkModule, config.sdkModuleHash],
  ]) {
    assert.equal(sha256(readFileSync(file)), hash, 'Pinned source digest mismatch');
  }
  if (config.mode === 'local') {
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, 'http:');
    assert.equal(config.audience, 'development');
  } else {
    assert.equal(config.audience, 'staging');
    assert(
      config.targetManifest && config.goFile,
      'Cloud execution requires isolation evidence and parent GO'
    );
    const manifest = JSON.parse(readFileSync(config.targetManifest, 'utf8'));
    validateTarget(config, manifest);
    const go = JSON.parse(readFileSync(config.goFile, 'utf8'));
    assert.equal(go.runID, config.runID);
    assert(
      Array.isArray(go.configHashes) && go.configHashes.includes(sha256(readFileSync(path))),
      'Parent GO must match this exact workload configuration'
    );
    assert.equal(go.targetManifestHash, sha256(readFileSync(config.targetManifest)));
    assert.equal(go.approvedByParent, true);
    assert(go.expiresAt >= config.stopAt && go.expiresAt > Date.now());
    assert.equal(go.budgetHash, sha256(readFileSync(go.budgetFile)));
    const budget = JSON.parse(readFileSync(go.budgetFile, 'utf8'));
    assert.equal(
      go.hardLimitUSD,
      budget.hardLimitUSD ?? 50,
      'Parent GO cap must equal the hashed forecast cap'
    );
    const inspection = validateAttestation(config, manifest, go, path);
    validateCloudAdmission(config, manifest, budget, Date.now(), inspection);
  }
  event(
    { ...session(config, config.sessions - 1), position: 13 },
    (config.warmSeconds + config.measuredSeconds) * config.eventHz,
    config.startAt,
    config.stopAt
  );
  return config;
}

export function validateTarget(config, manifest) {
  assertManifestIdentity(manifest, true);
  assert.equal(manifest.accountID, 'e115e769bcdd4c3d66af59d3332cb394');
  assert.equal(manifest.runID, config.runID);
  assert.equal(manifest.workerName, `session-sync-${config.runID}-loadtest`);
  const target = new URL(config.baseURL);
  assert.equal(target.href, manifest.baseURL);
  assert.equal(target.protocol, 'https:');
  assert(
    target.hostname.startsWith(manifest.workerName + '.') &&
      /^[a-z0-9-]+\.workers\.dev$/.test(target.hostname.slice(manifest.workerName.length + 1))
  );
  assert.equal(manifest.productionBindings, false);
  assert.equal(manifest.syntheticDatabase, true);
  assert.equal(manifest.independentSigningSecrets, true);
  assert.equal(manifest.hyperdriveCaching, false);
  assert.equal(manifest.r2Bucket, manifest.workerName);
  assert(Array.isArray(manifest.routes) && manifest.routes.length === 0);
  assert(Array.isArray(manifest.services) && manifest.services.length === 0);
  assert(
    manifest.secretNames.length > 0 &&
      manifest.secretNames.every(name => name.endsWith('_STAGING_LOADTEST'))
  );
  assert(
    !['624ec80650dd414199349f4e217ddb10', '2dd5d842a72e432c96b83f8757585ddc'].includes(
      manifest.hyperdriveID
    )
  );
  assert(/^[a-f0-9]{32}$/.test(manifest.hyperdriveID));
  assert.equal(manifest.configHash, sha256(readFileSync(manifest.configFile)));
  const rendered = JSON.parse(readFileSync(manifest.configFile, 'utf8'));
  const allowedKeys = new Set([
    '$schema',
    'name',
    'account_id',
    'main',
    'compatibility_date',
    'compatibility_flags',
    'rules',
    'observability',
    'logpush',
    'workers_dev',
    'preview_urls',
    'vars',
    'ratelimits',
    'analytics_engine_datasets',
    'durable_objects',
    'migrations',
    'hyperdrive',
    'r2_buckets',
    'secrets_store_secrets',
  ]);
  assert(
    Object.keys(rendered).every(key => allowedKeys.has(key)),
    'Unexpected resource binding or configuration'
  );
  assert(
    rendered.observability?.enabled === false && rendered.logpush === true,
    'Use Logpush without duplicate stored Workers logs'
  );
  assert.deepEqual(rendered.vars, {
    ENVIRONMENT: 'staging',
    USER_TENANT_SESSIONS: '10000',
    USER_TENANT_BYTES: '107374182400',
    ORGANIZATION_TENANT_SESSIONS: '200000',
    ORGANIZATION_TENANT_BYTES: '2199023255552',
  });
  assert.deepEqual(
    rendered.ratelimits,
    limiterConfig(config.runID),
    'Only dedicated unchanged limiter policies are allowed'
  );
  assert.equal(rendered.name, manifest.workerName);
  assert.equal(rendered.account_id, manifest.accountID);
  assert.equal(rendered.vars.ENVIRONMENT, 'staging');
  assert.equal(rendered.workers_dev, true);
  assert(!rendered.routes?.length && !rendered.services?.length && !rendered.env);
  assert.deepEqual(rendered.hyperdrive, [{ binding: 'HYPERDRIVE', id: manifest.hyperdriveID }]);
  assert.deepEqual(rendered.r2_buckets, [
    { binding: 'SESSION_SYNC_R2', bucket_name: manifest.r2Bucket },
  ]);
  assert.deepEqual(rendered.analytics_engine_datasets, [
    {
      binding: 'SESSION_SYNC_METRICS',
      dataset: `session_sync_${config.runID.replaceAll('-', '_')}_loadtest_metrics`,
    },
  ]);
  assert.deepEqual(rendered.durable_objects.bindings, [
    { name: 'SESSION_SYNC_DO', class_name: 'SessionSyncDO' },
    { name: 'SESSION_SYNC_TENANT_DO', class_name: 'SessionSyncTenantDO' },
    { name: 'SESSION_RELAY_DO', class_name: 'SessionRelayDO' },
    { name: 'SESSION_PRESENCE_DO', class_name: 'SessionPresenceDO' },
  ]);
  assert(/^[a-f0-9]{32}$/.test(manifest.secretsStoreID));
  assert.equal(rendered.secrets_store_secrets.length, 3);
  assert.deepEqual(rendered.secrets_store_secrets.map(secret => secret.binding).sort(), [
    'INTERNAL_API_SECRET_PROD',
    'NEXTAUTH_SECRET',
    'SESSION_SYNC_SECRET',
  ]);
  assert(
    rendered.secrets_store_secrets.every(
      secret =>
        secret.store_id === manifest.secretsStoreID &&
        manifest.secretNames.includes(secret.secret_name)
    )
  );
  assert(Number.isFinite(manifest.resourceCreatedAt) && manifest.resourceCreatedAt > 0);
  assert(manifest.teardownArmedAt < Date.now() && manifest.teardownAt === config.stopAt);
  assert(manifest.teardownAt > manifest.resourceCreatedAt);
  assert.equal(manifest.teardownTailSeconds, 150);
  const inventoryBytes = readFileSync(manifest.preProvisionEvidenceFile);
  assert.equal(manifest.preProvisionEvidenceHash, sha256(inventoryBytes));
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.runID, config.runID);
  assert.equal(inventory.workerName, manifest.workerName);
  assert(
    inventory.workerAbsent &&
      inventory.bucketAbsent &&
      inventory.hyperdriveAbsent &&
      inventory.secretsAbsent &&
      inventory.limiterNamespacesUnused
  );
  assert(
    inventory.checkedAt <= manifest.resourceCreatedAt &&
      manifest.resourceCreatedAt - inventory.checkedAt <= 900000
  );
  assert.equal(manifest.namespaces.length, 4);
  assert.deepEqual(
    manifest.namespaces.map(row => row.id).sort(),
    [...manifest.namespaceIDs].sort()
  );
  assert.equal(new Set(manifest.namespaceIDs).size, 4);
  assert.deepEqual(
    manifest.namespaces.map(row => row.binding).sort(),
    rendered.durable_objects.bindings.map(row => row.name).sort()
  );
  assert(manifest.namespaceIDs.every(id => /^[a-f0-9]{32}$/.test(id)));
  assert(manifest.evidenceFile && manifest.independentWatchdogID);
  assert.equal(manifest.evidenceHash, sha256(readFileSync(manifest.evidenceFile)));
}

export function session(config, index) {
  return {
    index,
    id: `ses_${config.runID}_${index}`,
    user: `load-${config.runID}-${index}`,
    source: sha256(`${config.runID}:${index}`)
      .slice(0, 32)
      .replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-4$3-8$4-$5'),
    messageID: `msg_${index}`,
    position: 0,
    counter: 0,
    committed: 0,
  };
}
export function token(sequence) {
  assert(sequence > 0 && sequence < 36 ** 4);
  return '~' + sequence.toString(36).padStart(4, '0');
}
export function prefix(sequence) {
  let result = '';
  for (let i = 1; i <= sequence; i++) result += token(i);
  return result;
}
export function seedText(s) {
  const envelope = {
    seq: 1,
    message: { id: s.messageID, type: 'assistant', content: [{ type: 'text', text: '' }] },
    sourceSequence: 0,
  };
  return '.'.repeat(2048 - Buffer.byteLength(JSON.stringify(envelope)));
}
export function fixture(s, through = s.counter) {
  const value = {
    seq: 1,
    message: {
      id: s.messageID,
      type: 'assistant',
      content: [{ type: 'text', text: seedText(s) + prefix(through) }],
    },
    sourceSequence: through,
  };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  assert(bytes >= 2048 && bytes <= 8192, 'Durable message must be 2–8 KiB');
  return value;
}
export function event(s, sequence, scheduled, sent) {
  const type = 'session.text.delta';
  const body = {
    version: 1,
    syncPosition: s.position,
    sourceID: s.source,
    incarnation: 'load',
    runID: 'load',
    data: {
      id: `${s.index}:${sequence}`,
      type,
      created: sent,
      data: {
        sessionID: s.id,
        assistantMessageID: s.messageID,
        ordinal: 0,
        delta: token(sequence),
      },
    },
    load: { sequence, scheduled, sent },
    padding: '',
  };
  const padding = 512 - Buffer.byteLength(JSON.stringify(body));
  assert(padding >= 0, 'Envelope exceeds 512 bytes');
  body.padding = '.'.repeat(padding);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 512);
  return { channel: 'events', type, body };
}
export function grant(s, secret, environment, organizationID, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const input =
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') +
    '.' +
    Buffer.from(
      JSON.stringify({
        version: 1,
        iss: 'session-sync',
        aud: 'session-sync',
        sub: s.user,
        iat: now,
        exp: now + ttlSeconds,
        env: environment,
        tenant: organizationID
          ? { type: 'organization', id: organizationID }
          : { type: 'user', id: s.user },
      })
    ).toString('base64url');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
export function histogram() {
  return { count: 0, sum: 0, max: 0, negative: 0, bins: new Uint32Array(10002) };
}
export function observe(hist, ms) {
  hist.count++;
  hist.sum += ms;
  hist.max = Math.max(hist.max, ms);
  if (ms < 0) hist.negative++;
  hist.bins[Math.max(0, Math.min(10001, Math.ceil(ms)))]++;
}
export function summarize(hist) {
  const percentile = p => {
    if (!hist.count) return null;
    let count = 0;
    for (let i = 0; i < hist.bins.length; i++) {
      count += hist.bins[i];
      if (count >= Math.ceil(hist.count * p)) return i;
    }
    return null;
  };
  return {
    count: hist.count,
    mean: hist.count ? hist.sum / hist.count : null,
    max: hist.max,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    overflow: hist.bins[10001],
    negative: hist.negative,
    percentileUnit: 'ceil milliseconds; 10001 denotes overflow, not a measured latency',
  };
}

export class Pending {
  constructor(limit, ttl) {
    this.limit = limit;
    this.ttl = ttl;
    this.entries = new Map();
    this.expired = 0;
    this.peak = 0;
  }
  add(id, at) {
    this.expire(at);
    assert(this.entries.size < this.limit, 'Pending tracking budget exceeded');
    this.entries.set(id, at);
    this.peak = Math.max(this.peak, this.entries.size);
  }
  take(id) {
    const at = this.entries.get(id);
    this.entries.delete(id);
    return at;
  }
  expire(now) {
    for (const [id, at] of this.entries) {
      if (now - at <= this.ttl) break;
      this.entries.delete(id);
      this.expired++;
    }
  }
}

export function limiterConfig(runID) {
  assert(/^[a-z0-9-]{3,32}$/.test(runID));
  // Five adjacent IDs in the positive signed-31-bit range; inventory still refuses collisions.
  const base = 1000000000 + (Number.parseInt(sha256(runID).slice(0, 8), 16) % 143435456) * 8;
  return [
    ['EXCHANGE_IP_LIMITER', 120],
    ['EXCHANGE_ACCOUNT_LIMITER', 60],
    ['USER_REQUEST_LIMITER', 1200],
    ['USER_BLOB_LIMITER', 300],
    ['USER_DATA_BLOCK_LIMITER', 120],
  ].map(([name, limit], index) => ({
    name,
    namespace_id: String(base + index),
    simple: { limit, period: 60 },
  }));
}

export function validateAttestation(config, manifest, go, configFile) {
  assert(config.attestationFile, 'Current attestation and renewed parent GO are required');
  const bytes = readFileSync(config.attestationFile);
  assert.equal(go.attestationHash, sha256(bytes), 'Parent GO must renew this exact attestation');
  const attestation = JSON.parse(bytes);
  assert.equal(attestation.runID, config.runID);
  assert.equal(attestation.targetManifestHash, go.targetManifestHash);
  assert(attestation.configHashes.includes(sha256(readFileSync(configFile))));
  assert.equal(attestation.budgetHash, go.budgetHash);
  assert.equal(attestation.configHash, manifest.configHash);
  assert.equal(attestation.sdkModuleHash, config.sdkModuleHash);
  assert.equal(attestation.nativeModuleHash, config.nativeModuleHash);
  assert.equal(attestation.resourceCreatedAt, manifest.resourceCreatedAt);
  assert.equal(attestation.teardownAt, config.stopAt);
  assert(
    attestation.issuedAt <= Date.now() && Date.now() - attestation.issuedAt <= 60000,
    'Attestation is stale; refresh evidence and obtain renewed parent GO'
  );
  assert.equal(attestation.watchdogInstanceID, manifest.independentWatchdogID);
  return attestation.inspection;
}
export function validateReceipt(s, batch, value) {
  const receipt = receiptSchema.parse(value);
  assert.equal(receipt.sessionID, s.id);
  assert.equal(receipt.batchID, batch.batchID);
  assert.equal(receipt.after, batch.after);
  assert.equal(receipt.through, batch.through);
  assert.equal(receipt.changes, batch.changes.length);
  assert.equal(receipt.revision, (s.revision ?? 0) + 1);
  assert.equal(receipt.digest, sha256(JSON.stringify(batch)));
  return receipt;
}

export function arrivalAllowed(window, at) {
  return !window || at < window.drainAt;
}

export function validateCloudAdmission(
  config,
  manifest,
  budget,
  now = Date.now(),
  currentInspection
) {
  checkWatchdog(manifest, now);
  const inspection = currentInspection ?? JSON.parse(readFileSync(manifest.evidenceFile, 'utf8'));
  assert(
    inspection.checkedAt <= now && now - inspection.checkedAt <= 60000,
    'Live deployment inspection is stale'
  );
  assert.equal(inspection.runID, config.runID);
  assert.equal(
    inspection.baseURL,
    config.baseURL,
    'Origin differs from the live account inspection'
  );
  assert.equal(inspection.deploymentID, manifest.deploymentID);
  assert.equal(inspection.versionID, manifest.versionID);
  assert.equal(inspection.r2BucketID, manifest.r2BucketID);
  assert(inspection.r2Private && inspection.databaseTLS);
  assert.equal(config.stopAt, manifest.teardownAt);
  assert(manifest.teardownAt > now);
  assert.equal(budget.passed, true);
  const hardLimitUSD = budget.hardLimitUSD ?? 50;
  const alreadySpentUSD = budget.alreadySpentUSD;
  assert(Number.isFinite(hardLimitUSD) && hardLimitUSD >= 50 && hardLimitUSD <= 100);
  assert(Number.isFinite(alreadySpentUSD) && alreadySpentUSD >= 0);
  assert(
    budget.pessimisticCFUSD >= 0 &&
      budget.pessimisticCFUSD <= hardLimitUSD - alreadySpentUSD - budget.reserveUSD - 5 &&
      budget.vmUSD >= 0 &&
      budget.vmUSD <= 5 &&
      Number.isFinite(budget.reserveUSD) &&
      budget.reserveUSD >= 10 &&
      budget.committedCeilingUSD >=
        budget.pessimisticCFUSD + budget.vmUSD + budget.reserveUSD + alreadySpentUSD &&
      budget.committedCeilingUSD <= hardLimitUSD
  );
  assert(
    manifest.teardownAt + manifest.teardownTailSeconds * 1000 <=
      manifest.resourceCreatedAt + budget.absoluteResourceDeadlineSeconds * 1000,
    'Resource lifetime exceeds the priced forecast'
  );
  const stage = budget.workloadBounds?.find(row => row.name === config.budgetStage);
  assert(
    stage &&
      stage.sessions >= config.sessions &&
      stage.streamingSources >= config.streamingSources &&
      stage.watched >= config.watched &&
      stage.sourceTrafficMode === config.sourceTrafficMode &&
      stage.sdkViewers >= config.sdkViewers &&
      stage.viewerConnections >=
        config.sdkViewers + (config.rawViewers ?? 0) * (config.rawCopies ?? 1) &&
      stage.eventHz >= config.eventHz,
    'Workload population is absent from the approved budget'
  );
  assert(
    stage.checkpoints >=
      config.sessions * Math.ceil((config.warmSeconds + config.measuredSeconds) / 5)
  );
  assert(stage.finalCheckpoints >= config.sessions);
  assert(
    stage.incomingWebSocketMessages >=
      config.streamingSources * config.eventHz * (config.warmSeconds + config.measuredSeconds)
  );
  assert(
    stage.ticketRequests >=
      config.sessions +
        config.streamingSources +
        config.sdkViewers +
        (config.rawViewers ?? 0) * (config.rawCopies ?? 1)
  );
}

export async function finalizeClusterResult(result, cleanup, save) {
  try {
    await cleanup();
    result.cleanup = { passed: true };
  } catch (error) {
    result.cleanup = { passed: false, error: error.message };
  }
  result.passed = result.workloadPassed === true && result.cleanup.passed;
  save(result);
  return result;
}

export function assertReceiptRetry(original, value) {
  assert.deepEqual(
    receiptSchema.parse(value),
    original,
    'Exact receipt must match the original response'
  );
}
