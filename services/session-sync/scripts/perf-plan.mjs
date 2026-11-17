import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profiles } from './perf-profiles.mjs';
import {
  nativeSHA,
  nativeBundleHash,
  sha256,
  validateTarget,
  validateCloudAdmission,
} from './perf-common.mjs';
import {
  assertGenerator,
  checkWatchdog,
  inspectLive,
  operatorAPI,
  resolveOperatorToken,
} from './perf-identity.mjs';

const [profile, file, output] = process.argv.slice(2);
assert(
  ['refresh', 'full', 'cold', 'renewal', 'hot100', 'slowreader', 'organization'].includes(
    profile
  ) && output,
  'Usage: perf-plan.mjs <cloud-profile|refresh> verified-manifest.json output-directory'
);
const manifestFile = resolve(file);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
validateTarget(
  { runID: manifest.runID, baseURL: manifest.baseURL, stopAt: manifest.teardownAt },
  manifest
);
for (const node of manifest.generators) assertGenerator(node);
const root = resolve(output);
function attest(approval, inspection) {
  const ready = checkWatchdog(manifest, Date.now(), true);
  assert(
    inspection.checkedAt <= Date.now() && Date.now() - inspection.checkedAt <= 60000,
    'Current live inspection required'
  );
  for (const [index, node] of approval.nodes.entries()) {
    const dir = join(root, `node-${index}`);
    const bytes = readFileSync(join(dir, 'target.json'));
    assert.equal(node.targetManifestHash, sha256(bytes), 'Frozen target changed');
    const target = JSON.parse(bytes);
    assert.equal(sha256(readFileSync(join(dir, 'budget.json'))), approval.budgetHash);
    const attestation = {
      runID: manifest.runID,
      issuedAt: Date.now(),
      targetManifestHash: node.targetManifestHash,
      configHashes: node.configHashes,
      budgetHash: approval.budgetHash,
      configHash: manifest.configHash,
      sdkModuleHash: manifest.sdkModuleHash,
      nativeModuleHash: nativeBundleHash,
      resourceCreatedAt: manifest.resourceCreatedAt,
      teardownAt: manifest.teardownAt,
      watchdogInstanceID: ready.instanceID,
      inspection,
    };
    const value = JSON.stringify(attestation, null, 2) + '\n';
    writeFileSync(join(dir, 'attestation.json'), value, { mode: 0o600 });
    writeFileSync(join(dir, 'watchdog-ready.json'), JSON.stringify(ready), { mode: 0o600 });
    node.attestationHash = sha256(value);
    assert.equal(target.teardownAt, manifest.teardownAt);
  }
  writeFileSync(join(root, 'approval-request.json'), JSON.stringify(approval, null, 2) + '\n', {
    mode: 0o600,
  });
}
if (profile === 'refresh') {
  const approval = JSON.parse(readFileSync(join(root, 'approval-request.json'), 'utf8'));
  const cluster = JSON.parse(readFileSync(join(root, 'cluster.json'), 'utf8'));
  assert.equal(
    approval.operatorManifestHash,
    sha256(readFileSync(manifestFile)),
    'Frozen operator manifest changed'
  );
  assert.equal(
    approval.clusterHash,
    sha256(readFileSync(join(root, 'cluster.json'))),
    'Frozen cluster changed'
  );
  assert.equal(approval.budgetHash, sha256(readFileSync(manifest.budgetFile)));
  const inspection = await inspectLive(
    manifest,
    operatorAPI(() => resolveOperatorToken(manifest.wrangler))
  );
  const budget = JSON.parse(readFileSync(manifest.budgetFile, 'utf8'));
  for (const [index, node] of cluster.nodes.entries()) {
    const hashes = node.shards.map(shard => {
      const path = join(root, `node-${index}`, `config-${shard}.json`);
      const config = JSON.parse(readFileSync(path, 'utf8'));
      validateCloudAdmission(config, manifest, budget, Date.now(), inspection);
      return sha256(readFileSync(path));
    });
    assert.deepEqual(hashes, approval.nodes[index].configHashes, 'Frozen workload changed');
  }
  attest(approval, inspection);
  console.log(
    'Fresh attestation written without GO. Transfer attestation/heartbeat and obtain renewed explicit parent GO before seed or launch.'
  );
  process.exit(0);
}
const shape = { ...profiles[profile] };
if (profile === 'organization') {
  assert(manifest.syntheticOrganizationID);
  shape.organizationID = manifest.syntheticOrganizationID;
}
const shards = profile === 'full' ? 32 : 1;
const generators = manifest.generators.slice(0, profile === 'full' ? 4 : 1);
assert.equal(generators.length, profile === 'full' ? 4 : 1);
assert.equal(new Set(generators.map(node => node.host)).size, generators.length);
// Immutable workload/config copies stay fixed across explicit re-attestation.
mkdirSync(root, { mode: 0o700 });
const approval = {
  runID: manifest.runID,
  profile,
  nodes: [],
  budgetHash: sha256(readFileSync(manifest.budgetFile)),
  hardLimitUSD: JSON.parse(readFileSync(manifest.budgetFile, 'utf8')).hardLimitUSD ?? 50,
};
const nodes = [];
for (let index = 0; index < generators.length; index++) {
  const node = generators[index];
  assertGenerator(node);
  const artifactDir = join(root, `node-${index}`);
  mkdirSync(artifactDir, { mode: 0o700 });
  const write = (name, value) =>
    writeFileSync(join(artifactDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  for (const [source, name] of [
    [manifest.configFile, 'wrangler.json'],
    [manifest.evidenceFile, 'live-evidence.json'],
    [manifest.preProvisionEvidenceFile, 'absence.json'],
    [manifest.watchdogReadyFile, 'watchdog-ready.json'],
    [manifest.budgetFile, 'budget.json'],
  ])
    copyFileSync(source, join(artifactDir, name));
  const target = {
    ...manifest,
    configFile: `${node.root}/wrangler.json`,
    evidenceFile: `${node.root}/live-evidence.json`,
    preProvisionEvidenceFile: `${node.root}/absence.json`,
    watchdogReadyFile: `${node.root}/watchdog-ready.json`,
  };
  write('target.json', target);
  const ownedShards = Array.from({ length: shards }, (_, shard) => shard).filter(
    shard => shard % generators.length === index
  );
  const configs = [];
  const configHashes = [];
  for (const shard of ownedShards) {
    const owned = Math.floor((shape.sessions - 1 - shard) / shards) + 1;
    const config = {
      version: 1,
      mode: 'cloud',
      runID: manifest.runID,
      root: node.root,
      baseURL: manifest.baseURL,
      nativeSHA,
      nativeModuleHash: nativeBundleHash,
      nativeModule: `${node.repository}/native-socket.mjs`,
      sdkModule: `${node.repository}/packages/cloud-agent-sdk/src/native-sync.ts`,
      sdkModuleHash: manifest.sdkModuleHash,
      instrumentSDK: false,
      keysFile: `${node.root}/keys.json`,
      ...shape,
      sourceTrafficMode: 'all-streaming-sources',
      shard,
      shards,
      warmSeconds: 10,
      measuredSeconds: 45,
      drainSeconds: 10,
      checkpointSeconds: 5,
      startAt: manifest.teardownAt - 70000,
      stopAt: manifest.teardownAt,
      maxRequests:
        owned * 24 +
        Math.ceil((shape.sdkViewers + (shape.rawViewers ?? 0) * (shape.rawCopies ?? 1)) / shards) *
          8 +
        100,
      requestConcurrency: 512,
      pendingLimit: 100000,
      pendingTTLms: 10000,
      maxBufferedBytes: 1048576,
      audience: 'staging',
      targetManifest: `${node.root}/target.json`,
      budgetStage: {
        full: '100k-streaming-10k-sdk-10hz-512b-10warm-45measure-10drain',
        cold: 'cold',
        renewal: 'renewal',
        hot100: 'hot-100-total-viewers',
        slowreader: 'slow-reader',
        organization: 'concentrated-organization',
      }[profile],
      goFile: `${node.root}/go.json`,
      attestationFile: `${node.root}/attestation.json`,
    };
    const name = `config-${shard}.json`;
    write(name, config);
    configs.push(`${node.root}/${name}`);
    configHashes.push(sha256(readFileSync(join(artifactDir, name))));
  }
  nodes.push({
    host: node.host,
    root: node.root,
    repository: node.repository,
    configs,
    shards: ownedShards,
  });
  approval.nodes.push({
    host: node.host,
    configHashes,
    targetManifestHash: sha256(readFileSync(join(artifactDir, 'target.json'))),
    budgetFile: `${node.root}/budget.json`,
  });
}
const cluster = {
  version: 1,
  mode: 'cloud',
  runID: manifest.runID,
  operatorManifest: manifestFile,
  nodes,
  stopAt: manifest.teardownAt,
  sessions: shape.sessions,
  streamingSources: shape.streamingSources,
  sourceTrafficMode: 'all-streaming-sources',
  watched: shape.watched,
  viewerConnections: shape.sdkViewers + (shape.rawViewers ?? 0) * (shape.rawCopies ?? 1),
  sdkViewers: shape.sdkViewers,
  eventHz: shape.eventHz,
  warmSeconds: 10,
  measuredSeconds: 45,
  drainSeconds: 10,
  rampDeadlineSeconds: 30,
  clockErrorBoundMs: manifest.clockErrorBoundMs,
  clockEvidenceFile: manifest.clockEvidenceFile,
  outputFile: join(root, 'cluster-result.json'),
};
writeFileSync(join(root, 'cluster.json'), JSON.stringify(cluster, null, 2) + '\n', { mode: 0o600 });
approval.operatorManifestHash = sha256(readFileSync(manifestFile));
approval.clusterHash = sha256(readFileSync(join(root, 'cluster.json')));
writeFileSync(join(root, 'approval-request.json'), JSON.stringify(approval, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  'Cloud inputs generated without GO files, credentials, provisioning, or load. Parent approval remains required.'
);
