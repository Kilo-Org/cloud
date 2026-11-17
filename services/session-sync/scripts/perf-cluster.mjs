import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { assertGenerator, checkWatchdog } from './perf-identity.mjs';
import { finalizeClusterResult, populationMatches } from './perf-common.mjs';

const safePath = z.string().regex(/^\/[a-zA-Z0-9_./-]+$/);
const nodeSchema = z.strictObject({
  host: z.string(),
  root: safePath,
  repository: safePath,
  configs: z.array(safePath).min(1).max(16),
  shards: z.array(z.number().int().min(0).max(63)).min(1).max(16),
});
const schema = z.strictObject({
  version: z.literal(1),
  runID: z.string().regex(/^[a-z0-9-]{3,48}$/),
  mode: z.enum(['local', 'cloud']).default('cloud'),
  operatorManifest: z.string().optional(),
  nodes: z.array(nodeSchema).min(1).max(4),
  stopAt: z.number(),
  sessions: z.number().int().positive().max(100000),
  streamingSources: z.number().int().positive().max(100000),
  sourceTrafficMode: z.literal('all-streaming-sources'),
  eventHz: z.number().int().positive().max(20),
  sdkViewers: z.number().int().nonnegative().max(10000),
  watched: z.number().int().positive().max(10000),
  viewerConnections: z.number().int().positive().max(10000),
  warmSeconds: z.literal(10),
  measuredSeconds: z.literal(45),
  drainSeconds: z.literal(10),
  rampDeadlineSeconds: z.number().positive().max(30),
  clockErrorBoundMs: z.number().nonnegative().max(10),
  clockEvidenceFile: z.string(),
  outputFile: z.string(),
});
const [file] = process.argv.slice(2);
const plan = schema.parse(JSON.parse(readFileSync(file, 'utf8')));
assert(plan.watched <= plan.streamingSources && plan.streamingSources <= plan.sessions);
assert(plan.sdkViewers <= plan.viewerConnections);
for (const node of plan.nodes) {
  assertGenerator(node);
  for (const path of node.configs)
    assert(
      path.startsWith(node.root + '/') &&
        !path.split('/').some(part => part === '.' || part === '..'),
      'Configuration must stay within its reviewed generator root'
    );
}
const clock = z
  .strictObject({
    capturedAt: z.number(),
    validUntil: z.number(),
    hosts: z.array(
      z.strictObject({
        host: z.string(),
        synchronized: z.literal(true),
        offsetMs: z.number(),
        uncertaintyMs: z.number().nonnegative(),
      })
    ),
  })
  .parse(JSON.parse(readFileSync(plan.clockEvidenceFile, 'utf8')));
assert(
  clock.capturedAt <= Date.now() &&
    Date.now() - clock.capturedAt <= 60000 &&
    clock.validUntil >= plan.stopAt
);
assert.deepEqual(clock.hosts.map(row => row.host).sort(), plan.nodes.map(node => node.host).sort());
assert(
  clock.hosts.every(row => Math.abs(row.offsetMs) + row.uncertaintyMs <= plan.clockErrorBoundMs),
  'Clock evidence exceeds the declared cross-host error bound'
);
assert(plan.stopAt > Date.now() && plan.stopAt - Date.now() <= 900000);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const children = [];
const operatorManifest =
  plan.mode === 'cloud' ? JSON.parse(readFileSync(plan.operatorManifest, 'utf8')) : undefined;
if (operatorManifest) {
  assert.equal(operatorManifest.runID, plan.runID);
  for (const node of plan.nodes) {
    const reviewed = operatorManifest.generators.find(row => row.host === node.host);
    assert(reviewed, 'Generator host is absent from the reviewed manifest');
    assert.equal(node.root, reviewed.root);
    assert.equal(node.repository, reviewed.repository);
  }
  checkWatchdog(operatorManifest, Date.now(), true);
}
const sshEnvironment = { ...process.env };
delete sshEnvironment.SESSION_SYNC_LOADTEST_CF_TOKEN;
delete sshEnvironment.CLOUDFLARE_API_TOKEN;
delete sshEnvironment.SESSION_SYNC_LOADTEST_OPERATOR_TOKEN;
delete sshEnvironment.CLOUDFLARE_API_KEY;
delete sshEnvironment.CLOUDFLARE_EMAIL;
function ssh(node, args, collect = true) {
  const child = spawn(
    'ssh',
    ['-oBatchMode=yes', '-oConnectTimeout=10', node.host, args.map(quote).join(' ')],
    { stdio: ['ignore', collect ? 'pipe' : 'inherit', 'inherit'], env: sshEnvironment }
  );
  let text = '';
  if (collect)
    child.stdout.on('data', chunk => {
      text += chunk;
      assert(text.length < 8 * 1024 * 1024, 'Remote result byte budget');
    });
  const row = { child, code: undefined };
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      row.code = code;
      if (code === 0) resolve(text);
      else reject(Error('Owned load node failed'));
    });
  });
  const timer = setTimeout(
    () => child.kill('SIGTERM'),
    Math.max(1, collect ? Math.min(30000, plan.stopAt - Date.now()) : plan.stopAt - Date.now())
  );
  result.finally(() => clearTimeout(timer)).catch(() => {});
  return { ...row, state: row, result };
}
async function remoteJSON(node, script) {
  return JSON.parse(await ssh(node, ['node', '-e', script]).result);
}
async function writeRemote(node, name, value) {
  assert(['window.json', 'stop.json', 'watchdog-ready.json'].includes(name));
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
  await remoteJSON(
    node,
    `const fs=require('node:fs'); const p=${JSON.stringify(node.root + '/' + name)}; fs.writeFileSync(p+'.tmp',Buffer.from('${encoded}','base64')); fs.renameSync(p+'.tmp',p); console.log('{}');`
  );
}
async function current(node) {
  const paths = node.shards.flatMap(shard =>
    ['producer', 'raw', 'sdk'].map(role => `${node.root}/status-${role}-${shard}.json`)
  );
  return remoteJSON(
    node,
    `const fs=require('node:fs'); console.log(JSON.stringify(${JSON.stringify(paths)}.map(path=>fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):null)));`
  );
}
let lastHeartbeatCopy = 0;
async function watchdog() {
  if (!operatorManifest) return;
  const ready = checkWatchdog(operatorManifest, Date.now(), true);
  if (Date.now() - lastHeartbeatCopy >= 2000) {
    await Promise.all(plan.nodes.map(node => writeRemote(node, 'watchdog-ready.json', ready)));
    lastHeartbeatCopy = Date.now();
  }
}
const start = Date.now();
let window;
let completed = false;
const result = {
  runID: plan.runID,
  sourceTrafficMode: plan.sourceTrafficMode,
  sessions: plan.sessions,
  streamingSources: plan.streamingSources,
  watched: plan.watched,
  sdkViewers: plan.sdkViewers,
  viewerConnections: plan.viewerConnections,
  offeredEventsPerSecond: plan.streamingSources * plan.eventHz,
  expectedMeasuredEvents: plan.streamingSources * plan.eventHz * plan.measuredSeconds,
  workloadPassed: false,
  passed: false,
};
let failure;
try {
  await watchdog();
  for (const node of plan.nodes) {
    const args = [
      'node',
      '--import',
      `${node.repository}/node_modules/tsx/dist/loader.mjs`,
      `${node.repository}/services/session-sync/scripts/perf-control.mjs`,
      'wait',
      ...node.configs,
    ];
    const child = ssh(node, args, false);
    children.push(child);
    child.result.catch(() => {});
  }
  let ready;
  while (Date.now() < start + plan.rampDeadlineSeconds * 1000) {
    await watchdog();
    assert(!children.some(child => child.state.code !== undefined), 'Generator exited during ramp');
    const samples = (await Promise.all(plan.nodes.map(current))).flat();
    assert(!samples.some(row => row?.failed), 'A generator rejected the ramp');
    if (samples.every(row => row && row.ready && Math.abs(Date.now() - row.at) < 1500)) {
      ready = samples;
      break;
    }
    await sleep(250);
  }
  assert(
    ready,
    'Simultaneous fresh population deadline; close every source without waiting on billing'
  );
  const expectedPopulation = {
    presence: plan.sessions,
    runners: plan.streamingSources,
    streamingSources: plan.streamingSources,
    watched: plan.watched,
    viewers: plan.viewerConnections,
    sdkViewers: plan.sdkViewers,
  };
  const totalPopulation = rows =>
    Object.fromEntries(
      Object.keys(expectedPopulation).map(key => [
        key,
        rows.reduce((sum, row) => sum + row[key], 0),
      ])
    );
  assert(
    populationMatches(totalPopulation(ready), expectedPopulation),
    'Declared source, watch and actual SDK populations must be simultaneously live'
  );
  const startAt = Date.now() + 3000;
  window = {
    runID: plan.runID,
    startAt,
    warmUntil: startAt + 10000,
    sendUntil: startAt + 55000,
    drainAt: startAt + 65000,
  };
  assert(window.drainAt < plan.stopAt);
  await Promise.all(plan.nodes.map(node => writeRemote(node, 'window.json', window)));
  while (Date.now() < window.drainAt) {
    await watchdog();
    const samples = (await Promise.all(plan.nodes.map(current))).flat();
    assert(
      !samples.some(row => !row || row.failed || Math.abs(Date.now() - row.at) > 2000),
      'Generator failed or status became stale'
    );
    if (Date.now() >= window.startAt && Date.now() < window.sendUntil) {
      assert(
        populationMatches(totalPopulation(samples), expectedPopulation),
        'Source, watch or viewer population dropped during the send window'
      );
    }
    await sleep(250);
  }
  await Promise.all(children.map(child => child.result));
  const summaries = await Promise.all(
    plan.nodes.map(node =>
      remoteJSON(
        node,
        `console.log(JSON.stringify(require(${JSON.stringify(node.root + '/summary.json')})));`
      )
    )
  );
  assert(summaries.every(summary => summary.passed));
  Object.assign(result, {
    window,
    clockErrorBoundMs: plan.clockErrorBoundMs,
    readiness: totalPopulation(ready),
    summaries,
    measuredProducerSends: summaries.reduce(
      (sum, summary) => sum + summary.measuredProducerSends,
      0
    ),
    sourceUnsentEvents: summaries.reduce((sum, summary) => sum + summary.sourceUnsentEvents, 0),
    durableCommittedPrefixEvents: summaries.reduce(
      (sum, summary) => sum + summary.durableCommittedPrefixEvents,
      0
    ),
    reconciledReceipts: summaries.reduce((sum, summary) => sum + summary.reconciledReceipts, 0),
  });
  assert.equal(
    result.measuredProducerSends,
    plan.streamingSources * plan.eventHz * plan.measuredSeconds
  );
  result.workloadPassed = true;
  completed = true;
} catch (error) {
  failure = error;
  result.error = error.message;
} finally {
  if (!completed)
    await Promise.allSettled(
      plan.nodes.map(node =>
        writeRemote(node, 'stop.json', { reason: 'cluster_abort', at: Date.now() })
      )
    );
  for (const child of children) if (child.state.code === undefined) child.child.kill('SIGTERM');
  await finalizeClusterResult(
    result,
    async () => {
      if (!operatorManifest) return;
      const cleanup = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./perf-teardown.mjs', import.meta.url)),
          'now',
          plan.operatorManifest,
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] }
      );
      const code = await new Promise((resolve, reject) => {
        cleanup.once('error', reject);
        cleanup.once('exit', resolve);
      });
      assert.equal(code, 0, 'Owned resource teardown failed; inspect the private teardown proof');
    },
    value => writeFileSync(plan.outputFile, JSON.stringify(value, null, 2))
  );
}
if (failure) throw failure;
assert(result.passed, 'Cluster cleanup failed; final artifact is not PASS');
