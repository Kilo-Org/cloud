// Synthetic proof for the M84 driver (../m84-notifications-run.mjs) and its workflow. A simulated
// account (scripts, deployments, versions, store, copier, cron ticks) drives every branch. Each
// tick runs the real core `runTick` against the fake Infisical, so the receipts are the copier's
// own, and every gate is the real core gate. No provider, credential or real value is involved.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  BATCH_TARGETS,
  COPIER,
  ENVIRONMENT,
  OPERATOR_META,
  OPERATOR_SCHEMA,
  RENDER_CONFIG,
  ROLLOUT_WORKFLOWS,
  StopError,
  activeRollouts,
  childEnv,
  cleanup,
  cloudflare,
  exitCode,
  github,
  jsonObjectSplitter,
  planRun,
  receiptsOf,
  rolloutRunsDuring,
  run,
  runChild,
  stopChild,
} from '../m84-notifications-run.mjs';
import { NAME_MAP, moduleHashes } from './checks.mjs';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  armedCopierBindings,
  copierSettingsResult,
  fakeGateNamespace,
  fakeInfisical,
  iso,
  leakForms,
  makeEnv,
  syntheticValues,
  unarmedCopierBindings,
} from './fakes.mjs';
import { CRON, RECEIPT_SCHEMA, WRITER_SECRET, runTick } from './src/core.mjs';
import { BATCH } from './src/manifest.mjs';

const T0 = Date.parse('2026-11-27T18:00:00Z');
const SHA = 'c'.repeat(40);
const STORE_ID = BATCH.rows[0].storeId;
const PRINCIPAL = 'synthetic-reader-principal';
const ns = () => randomUUID().replaceAll('-', '');

function operatorMeta(overrides = {}) {
  return {
    schema: OPERATOR_SCHEMA,
    batch: BATCH.id,
    commit: SHA,
    sourceScript: BATCH.sourceScript,
    targets: [...BATCH_TARGETS],
    readAt: iso(T0 - 5 * 60_000),
    allowedReaders: [PRINCIPAL],
    infisical: {
      names: { '/workloads/notifications': [] },
      syncs: [],
      imports: [],
      readers: [{ principal: PRINCIPAL, environment: 'production', paths: ['/shared'] }],
      approvalPolicies: [],
    },
    writer: {
      clientId: CLIENT_ID,
      permissions: BATCH.rows.map(r => ({
        action: 'create',
        environment: 'production',
        secretPath: r.secretPath,
        secretName: r.secretKey,
      })),
      auth: {
        accessTokenTTL: 300,
        accessTokenMaxTTL: 300,
        accessTokenNumUsesLimit: BATCH.rows.length + 1,
        clientSecretNumUsesLimit: 1,
        clientSecretExpiresAt: iso(T0 + 41 * 60_000 + 30_000),
      },
    },
    ...overrides,
  };
}

function baseEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'Kilo-Org/cloud',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: SHA,
    EXPECTED_COMMIT: SHA,
    GITHUB_RUN_ID: '4242',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: '/tmp/runner-temp',
    GITHUB_TOKEN: 'synthetic-github-token',
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
    [WRITER_SECRET]: CLIENT_SECRET,
    [OPERATOR_META]: JSON.stringify(operatorMeta()),
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    ...overrides,
  };
}

const sourceBindings = () => [
  ...NAME_MAP.map(r => ({
    name: r.binding,
    type: 'secrets_store_secret',
    store_id: r.storeId,
    secret_name: r.secretName,
  })),
  { name: 'WORKER_ENV', type: 'plain_text', text: 'production' },
];

/**
 * A simulated account. `o` switches failure modes; `world.calls` records every effect. Copier
 * versions keep their own bindings, as `GET .../versions/<id>` returns them.
 */
function makeWorld(o = {}) {
  const values = syntheticValues();
  const infisical = fakeInfisical();
  const gate = fakeGateNamespace();
  const clock = { t: T0, now: () => clock.t };
  const calls = [];
  const readLog = [];
  const scripts = new Map([
    [
      'notifications',
      { versions: [{ version_id: randomUUID(), percentage: 100 }], bindings: sourceBindings() },
    ],
    ['other-a', { versions: [{ version_id: randomUUID(), percentage: 100 }], bindings: [] }],
    [
      'other-b',
      {
        versions: [
          { version_id: randomUUID(), percentage: 90 },
          { version_id: randomUUID(), percentage: 10 },
        ],
        bindings: [],
      },
    ],
  ]);
  if (o.copierPreexists)
    scripts.set(COPIER, {
      versions: [{ version_id: randomUUID(), percentage: 100 }],
      bindings: [],
    });
  o.setup?.(scripts);
  const storeSecrets = NAME_MAP.map(r => ({
    id: ns(),
    name: r.secretName,
    status: 'active',
    scopes: ['workers'],
  }));
  let copier = null;
  let snapshots = 0;
  const world = { values, infisical, gate, clock, calls, readLog, scripts, o, secretInputs: [] };

  const fail = name => {
    if (o.cfFail?.[name]) throw new StopError(o.cfFail[name]);
  };
  const newCopierVersion = bindings => {
    copier.version = randomUUID();
    copier.versions.set(copier.version, bindings);
    copier.armed = bindings.some(b => b.name === WRITER_SECRET);
  };

  world.cf = {
    async scriptNames() {
      calls.push(['cf', 'scriptNames']);
      snapshots += 1;
      o.onSnapshot?.(world, snapshots);
      fail('scriptNames');
      return [...scripts.keys(), ...(copier ? [COPIER] : [])].sort();
    },
    async deploymentVersions(name) {
      fail('deploymentVersions');
      o.onDeploymentVersions?.(world, name);
      const versions =
        name === COPIER && copier
          ? [{ version_id: copier.version, percentage: 100 }]
          : structuredClone(scripts.get(name)?.versions ?? null);
      return versions?.sort((a, b) => a.version_id.localeCompare(b.version_id)) ?? null;
    },
    async version(name, versionId) {
      calls.push(['cf', 'version', name]);
      if (name === COPIER && copier?.versions.has(versionId)) {
        return { id: versionId, bindings: structuredClone(copier.versions.get(versionId)) };
      }
      const s = scripts.get(name);
      if (!s?.versions.some(v => v.version_id === versionId)) {
        throw new StopError('cloudflare_api_error');
      }
      const bindings = name === 'notifications' && o.sourceVersionBindings;
      return { id: versionId, bindings: structuredClone(bindings || s.bindings) };
    },
    async scriptSettings(name) {
      fail('scriptSettings');
      if (name === COPIER && copier) return { ...copierSettingsResult(), ...o.settingsPatch };
      // The source's settings always look right; the gates must read its serving version.
      const s = scripts.get(name);
      return s ? { bindings: name === 'notifications' ? sourceBindings() : [] } : null;
    },
    async scriptStatus(name) {
      return (name === COPIER && copier) || scripts.has(name) ? 200 : 404;
    },
    async schedules() {
      return [CRON];
    },
    async subdomain() {
      return { enabled: false, previews_enabled: false };
    },
    async moduleHashes() {
      return moduleHashes();
    },
    async doNamespaces(name) {
      return copier && name === COPIER
        ? [{ id: copier.namespace, script: COPIER, class: 'M65Gate' }]
        : [];
    },
    async domains() {
      return [];
    },
    async routes() {
      return [];
    },
    async queueConsumers() {
      return [];
    },
    async workflows() {
      return [];
    },
    async storeSecrets(storeId) {
      fail('storeSecrets');
      assert.equal(storeId, STORE_ID);
      return structuredClone(storeSecrets);
    },
    async deleteScript(name) {
      calls.push(['cf', 'deleteScript', name]);
      assert.equal(name, COPIER);
      fail('deleteScript');
      copier = null;
    },
  };

  world.gh = {
    async environment() {
      calls.push(['gh', 'environment']);
      if (o.environment === null) return null;
      return {
        name: ENVIRONMENT,
        can_admins_bypass: false,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        ...o.environment,
      };
    },
    async branchPolicies() {
      return { branch_policies: o.branches ?? [{ name: 'main', type: 'branch' }] };
    },
    async activeRuns(workflow) {
      calls.push(['gh', 'activeRuns', workflow]);
      return o.activeRuns?.(workflow, world) ?? 0;
    },
    async runsCreated(workflow, from, to) {
      calls.push(['gh', 'runsCreated', workflow, from, to]);
      return { total: 0, runs: [] };
    },
  };

  world.printed = [];
  world.printTable = text => world.printed.push(text);
  world.node = async args => {
    calls.push(['node', args[0]]);
    assert.equal(args[0], RENDER_CONFIG);
    const flags = Object.fromEntries(
      args.slice(1).reduce((a, v, i, all) => (i % 2 ? a : [...a, [v, all[i + 1]]]), [])
    );
    world.pins = {
      M65_RUN_ID: flags['--run-id'],
      M65_NOT_BEFORE: flags['--not-before'],
      M65_NOT_AFTER: flags['--not-after'],
      M65_INFISICAL_CLIENT_ID: flags['--client-id'],
    };
    world.out = flags['--out'];
    return {
      code: 0,
      output: `${JSON.stringify({
        configPath: flags['--out'],
        configSha256: 'f'.repeat(64),
        name: COPIER,
        cron: CRON,
        notBefore: flags['--not-before'],
        notAfter: flags['--not-after'],
      })}\n`,
    };
  };

  /** `o.deploy` / `o.put`: `{code, lands, bindings}`; defaults are a clean landed write. */
  world.wrangler = async (args, opts = {}) => {
    calls.push(['wrangler', ...args]);
    world.writes = [
      ...(world.writes ?? []),
      { verb: args[0], at: clock.t, ...opts, stdin: undefined },
    ];
    clock.t += 20_000;
    if (args[0] === 'deploy') {
      const { code = 0, lands = true, pins = world.pins } = o.deploy ?? {};
      if (lands) {
        copier = { deployedAt: clock.t, pins: world.pins, namespace: ns(), versions: new Map() };
        newCopierVersion(unarmedCopierBindings(pins, copier.namespace));
      }
      return { code, output: code ? 'X [code: 10021]' : '' };
    }
    if (args[0] === 'secret') {
      world.secretInputs.push(opts.stdin);
      const { code = 0, lands = true, extra = [] } = o.put ?? {};
      if (lands) {
        copier.armedAt = clock.t;
        newCopierVersion([...armedCopierBindings(copier.pins, copier.namespace), ...extra]);
      }
      return { code, output: '' };
    }
    throw new Error(`unexpected wrangler ${args[0]}`);
  };

  world.replaceCopierVersion = () => {
    copier.version = randomUUID();
  };

  world.startTail = () => ({
    async next(deadline) {
      if (!copier || o.noTicks || (o.ticksStopAfterArm && copier.armed)) {
        clock.t = Math.max(clock.t, deadline);
        return null;
      }
      const first = copier.deployedAt + (o.propagationMs ?? 3 * 60_000);
      const t = Math.ceil(Math.max(clock.t, first) / 60_000) * 60_000;
      const stopAt = o.ticksStopAtWindow ? Date.parse(copier.pins.M65_NOT_BEFORE) : Infinity;
      if (t > deadline || t >= stopAt) {
        clock.t = Math.max(clock.t, deadline);
        return null;
      }
      clock.t = t + 1_000;
      const env = makeEnv({
        values,
        gate,
        notBefore: copier.pins.M65_NOT_BEFORE,
        notAfter: copier.pins.M65_NOT_AFTER,
        armed: copier.armed,
        readLog,
        extra: {
          M65_RUN_ID: copier.pins.M65_RUN_ID,
          M65_INFISICAL_CLIENT_ID: copier.pins.M65_INFISICAL_CLIENT_ID,
          CF_VERSION_METADATA: { id: copier.version, tag: '', timestamp: iso(copier.deployedAt) },
        },
      });
      const receipt = await runTick({
        env,
        cron: CRON,
        scheduledTime: t,
        now: () => clock.t,
        fetchImpl: infisical.fetch,
        batch: BATCH,
      });
      return {
        outcome: 'ok',
        scriptName: COPIER,
        event: { cron: CRON, scheduledTime: t },
        logs: [{ message: [JSON.stringify(receipt)], level: 'log', timestamp: clock.t }],
        exceptions: o.exceptions ? [{ name: 'Error', message: 'synthetic' }] : [],
      };
    },
    async stop() {
      calls.push(['tail', 'stop']);
      return 'exited';
    },
  });
  return world;
}

function ioOf(world, o = {}, env = baseEnv()) {
  return {
    env,
    clock: world.clock,
    cf: world.cf,
    gh: world.gh,
    node: world.node,
    wrangler: world.wrangler,
    startTail: world.startTail,
    headSha: o.headSha ?? SHA,
    log: () => {},
    printTable: world.printTable,
    nameTable: o.nameTable,
    signal: o.signal,
    sleep: async () => {},
  };
}

async function drive(o = {}, envOverrides = {}) {
  const world = makeWorld(o);
  const logs = [];
  const env = baseEnv(envOverrides);
  const report = await run({
    ...ioOf(world, o, env),
    log: line => logs.push(JSON.stringify(line)),
  });
  const text = JSON.stringify(report) + logs.join('\n') + world.printed.join('\n');
  const leaked = leakForms(world.values, [
    ...world.infisical.issued,
    PRINCIPAL,
    'synthetic-github-token',
    'synthetic-cloudflare-token',
  ]).filter(f => text.includes(f));
  return { world, report, env, leaked, text };
}

/** Effects in order: Wrangler verbs, with the REST cleanup delete reported as `delete`. */
const wranglerVerbs = world =>
  world.calls
    .filter(c => c[0] === 'wrangler' || (c[0] === 'cf' && c[1] === 'deleteScript'))
    .map(c => (c[0] === 'wrangler' ? c[1] : 'delete'));

const callIndex = (world, ...match) =>
  world.calls.findIndex(c => match.every((m, i) => c[i] === m));

/** Nothing was armed: no `secret put`, no Infisical call, no source read. */
function assertNeverArmed(world) {
  assert.ok(!wranglerVerbs(world).includes('secret'));
  assert.deepEqual(world.secretInputs, []);
  assert.equal(world.infisical.calls.length, 0);
  assert.equal(world.readLog.length, 0);
}

test('happy path: unarmed preflight, then arm, one copy, cleanup; Cloudflare half complete', async () => {
  const { world, report, env, leaked } = await drive();
  assert.equal(report.status, 'cloudflare_complete', JSON.stringify(report.gates));
  assert.equal(exitCode(report), 0);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'secret', 'delete']);
  assert.deepEqual(world.secretInputs, [CLIENT_SECRET]);
  for (const c of world.calls) assert.ok(!c.some(a => String(a).includes(CLIENT_SECRET)));
  assert.equal(env[WRITER_SECRET], undefined);
  assert.equal(env[OPERATOR_META], undefined);
  assert.equal(world.infisical.clientSecretUses, 1);
  assert.equal(world.infisical.creates, 1);
  assert.deepEqual([...world.infisical.store.keys()], [...BATCH_TARGETS]);
  assert.deepEqual(report.batchTargets, [
    '/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN',
  ]);
  assert.equal(world.gate.state.outcome, 'complete');
  assert.equal(report.finalReceipt.schema, RECEIPT_SCHEMA);
  assert.equal(report.finalReceipt.gate, 'consumed_now');
  assert.equal(report.finalReceipt.versionId, report.armedVersion);
  assert.notEqual(report.armedVersion, report.unarmedVersion);
  assert.equal(report.preflightPins.versionId, report.armedVersion);
  assert.equal(report.preflightPins.unarmedVersionId, report.unarmedVersion);
  assert.equal(report.deployWrite, 'proved');
  assert.equal(report.armWrite, 'proved');
  assert.equal(report.unresolved, undefined);
  // The earliest eligible tick: the first minute at least the 24-minute lead ahead.
  assert.equal(report.notBefore, iso(T0 + 24 * 60_000));
  assert.deepEqual(
    report.phases.map(p => p.name),
    [
      'name_table',
      'github_guards',
      'snapshot_before',
      'render',
      'deploy_unarmed',
      'await_unarmed_readiness',
      'preflight_gate',
      'guards_before_arm',
      'arm',
      'arm_readback',
      'await_armed_readiness',
      'await_result',
      'postrun_cloudflare_gate',
    ]
  );
  assert.deepEqual(
    report.gates.map(g => [g.gate, g.ok]),
    [
      ['table', true],
      ['preflight', true],
      ['preflight-armed', true],
      ['postrun-cloudflare', true],
    ]
  );
  // The source's serving version was read from the version itself, before and after the run.
  assert.ok(world.calls.filter(c => c[1] === 'version' && c[2] === 'notifications').length >= 2);
  const put = world.writes.find(w => w.verb === 'secret');
  assert.ok(put.timeoutMs > 0);
  assert.ok(put.timeoutMs <= Date.parse(report.notBefore) - 2 * 60_000 - put.at);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.equal(report.cleanup.gateNamespacePresent, false);
  assert.deepEqual(report.cleanup.drift, []);
  assert.equal(report.cleanup.rolloutRuns, undefined);
  assert.equal(report.cleanup.gate.ok, true);
  assert.ok(callIndex(world, 'cf', 'deleteScript') < callIndex(world, 'tail', 'stop'));
  assert.equal(report.tail.stop, 'exited');
  assert.ok(
    Date.parse(report.phases.find(p => p.name === 'arm').at) < Date.parse(report.notBefore)
  );
  assert.equal(world.printed.length, 1);
  const lines = world.printed[0].split('\n');
  assert.equal(
    lines[0],
    'old binding name | store secret_name (if any) | STS lookup name (= Infisical target) | policy entry'
  );
  assert.equal(lines.length, NAME_MAP.length + 1, 'all four lookup names are proved and printed');
  assert.ok(lines.slice(1).every(l => l.split(' | ').length === 4));
  assert.deepEqual(leaked, []);
});

test('window: the earliest minute tick that both the lead and the writer expiry allow', () => {
  const env = baseEnv();
  const at = (expiresMs, nowMs = T0) =>
    planRun(env, { writer: { auth: { clientSecretExpiresAt: iso(expiresMs) } } }, nowMs);
  const lead = at(T0 + 41 * 60_000 + 30_000);
  assert.equal(lead.notBefore, T0 + 24 * 60_000);
  assert.equal(lead.notAfter, T0 + 39 * 60_000);
  const byExpiry = at(T0 + 60 * 60_000);
  assert.equal(byExpiry.notBefore, T0 + 30 * 60_000);
  assert.equal(byExpiry.notAfter, T0 + 45 * 60_000);
  const seconds = at(T0 + 60 * 60_000, T0 + 10_000);
  assert.equal(seconds.notBefore, T0 + 30 * 60_000);
  // Boundaries: the earliest expiry a 24-minute lead allows, and the 60-minute custody horizon.
  assert.equal(at(T0 + 40 * 60_000).notBefore, T0 + 24 * 60_000);
  assert.deepEqual(at(T0 + 40 * 60_000 - 1_000), { problem: 'writer_expiry_too_soon' });
  assert.deepEqual(at(T0 + 61 * 60_000, T0 + 60_000).notBefore, T0 + 31 * 60_000);
  assert.deepEqual(at(T0 + 60 * 60_000 + 1_000), { problem: 'writer_expiry_too_far' });
  assert.deepEqual(at(T0 + 75 * 60_000), { problem: 'writer_expiry_too_far' });
  for (const p of [lead, byExpiry]) {
    assert.ok(p.armDeadline < p.putDeadline && p.putDeadline < p.armedReadyDeadline);
    assert.ok(p.armedReadyDeadline < p.notBefore);
  }
});

test('context and operator refusals make no provider, GitHub or process call', async t => {
  const cases = [
    [{ GITHUB_REF: 'refs/heads/feature' }, 'ref'],
    [{ GITHUB_REPOSITORY: 'someone/cloud' }, 'repository'],
    [{ GITHUB_EVENT_NAME: 'push' }, 'event'],
    [{ EXPECTED_COMMIT: 'd'.repeat(40) }, 'expected_commit'],
    [{ [WRITER_SECRET]: '' }, 'writer_secret'],
    [{ [OPERATOR_META]: '' }, 'operator_meta'],
    [{ M65_INFISICAL_CLIENT_ID: 'not-a-uuid' }, 'client_id'],
    [{ [OPERATOR_META]: JSON.stringify(operatorMeta(), null, 2) }, 'operator_meta_not_compact'],
    [
      { [OPERATOR_META]: JSON.stringify(operatorMeta({ commit: 'e'.repeat(40) })) },
      'operator_meta_commit',
    ],
    [
      { [OPERATOR_META]: JSON.stringify(operatorMeta({ readAt: iso(T0 - 31 * 60_000) })) },
      'operator_meta_stale',
    ],
    [
      { [OPERATOR_META]: JSON.stringify(operatorMeta({ targets: BATCH_TARGETS.slice(1) })) },
      'operator_meta_targets',
    ],
    [{ [OPERATOR_META]: JSON.stringify({ ...operatorMeta(), extra: true }) }, 'operator_meta_keys'],
    [
      {
        [OPERATOR_META]: JSON.stringify(
          operatorMeta({ writer: { ...operatorMeta().writer, clientId: randomUUID() } })
        ),
      },
      'operator_meta_client',
    ],
    [
      {
        [OPERATOR_META]: JSON.stringify(
          operatorMeta({
            writer: {
              ...operatorMeta().writer,
              auth: { clientSecretExpiresAt: iso(T0 + 20 * 60_000) },
            },
          })
        ),
      },
      'writer_expiry_too_soon',
    ],
    [
      {
        [OPERATOR_META]: JSON.stringify(
          operatorMeta({
            writer: {
              ...operatorMeta().writer,
              auth: { clientSecretExpiresAt: iso(T0 + 3 * 3_600_000) },
            },
          })
        ),
      },
      'writer_expiry_too_far',
    ],
  ];
  for (const [env, problem] of cases) {
    await t.test(problem, async () => {
      const { world, report } = await drive({}, env);
      assert.equal(report.status, 'refused');
      assert.deepEqual(report.problems, [problem]);
      assert.deepEqual(world.calls, []);
      assert.equal(exitCode(report), 1);
    });
  }
  await t.test('checkout_head', async () => {
    const { world, report } = await drive({ headSha: 'b'.repeat(40) });
    assert.deepEqual(report.problems, ['checkout_head']);
    assert.deepEqual(world.calls, []);
  });
});
test('missing or loosened protected environment stops before any Cloudflare call', async t => {
  for (const [o, reason] of [
    [{ environment: null }, 'environment_absent'],
    [{ environment: { can_admins_bypass: true } }, 'environment_admin_bypass'],
    [
      {
        environment: {
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        },
      },
      'environment_branch_policy',
    ],
    [
      {
        branches: [
          { name: 'main', type: 'branch' },
          { name: 'release/*', type: 'branch' },
        ],
      },
      'environment_branches',
    ],
    [{ branches: [{ name: 'main', type: 'tag' }] }, 'environment_branches'],
    [{ branches: [{ name: 'main' }] }, 'environment_branches'],
    [{ environment: { can_admins_bypass: undefined } }, 'environment_admin_bypass'],
  ]) {
    await t.test(reason, async () => {
      const { world, report } = await drive(o);
      assert.equal(report.stopReason, 'environment_not_protected');
      assert.deepEqual(report.environment, [reason]);
      assert.equal(world.calls.filter(c => c[0] === 'cf' || c[0] === 'wrangler').length, 0);
      assert.equal(report.cleanup.note, 'not_created');
    });
  }
});

test('an active rollout at start stops before deploy; one before arming deletes the unarmed copier', async () => {
  const atStart = await drive({ activeRuns: w => (w === 'deploy-production.yml' ? 1 : 0) });
  assert.equal(atStart.report.stopReason, 'rollout_active');
  assert.deepEqual(atStart.report.activeRollouts, ['deploy-production.yml']);
  assert.deepEqual(wranglerVerbs(atStart.world), []);

  let checks = 0;
  const beforeArm = await drive({
    activeRuns: w => (w === ROLLOUT_WORKFLOWS[0] && ++checks > 1 ? 1 : 0),
  });
  assert.equal(beforeArm.report.stopReason, 'rollout_active_before_arm');
  assert.deepEqual(
    beforeArm.report.gates.map(g => [g.gate, g.ok]),
    [
      ['table', true],
      ['preflight', true],
    ]
  );
  assert.deepEqual(wranglerVerbs(beforeArm.world), ['deploy', 'delete']);
  assertNeverArmed(beforeArm.world);
  assert.equal(beforeArm.report.cleanup.gate.ok, true);
});

test('an existing copier script is never deployed over or deleted', async () => {
  const { world, report } = await drive({ copierPreexists: true });
  assert.equal(report.stopReason, 'copier_exists');
  assert.deepEqual(wranglerVerbs(world), []);
  assert.equal(report.cleanup.note, 'not_created');
});

test('no readiness tick before the arm deadline: never armed, closed copier deleted', async () => {
  const { world, report } = await drive({ propagationMs: 30 * 60_000 });
  assert.equal(report.stopReason, 'held_no_readiness_tick');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.equal(report.cleanup.beforeNotBefore, true);
});

test('a refused metadata read in the unarmed preflight deletes the copier without arming', async () => {
  const { world, report } = await drive({ cfFail: { storeSecrets: 'cloudflare_unauthorized' } });
  assert.equal(report.stopReason, 'cloudflare_unauthorized');
  assert.equal(report.phases.at(-1).name, 'preflight_gate');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
});

test('deployment drift before arming stops without arming; drift lists rollout runs', async () => {
  const { world, report } = await drive({
    onSnapshot: (w, n) => {
      if (n === 2)
        w.scripts.get('other-a').versions = [{ version_id: randomUUID(), percentage: 100 }];
    },
  });
  assert.equal(report.stopReason, 'drift_before_arm');
  assert.deepEqual(report.drift, ['other-a']);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.deepEqual(report.cleanup.drift, ['other-a']);
  assert.equal(report.cleanup.gate.ok, false);
  assert.deepEqual(
    report.cleanup.rolloutRuns.map(r => r.workflow),
    [...ROLLOUT_WORKFLOWS]
  );
  const listed = world.calls.filter(c => c[1] === 'runsCreated');
  assert.equal(listed.length, ROLLOUT_WORKFLOWS.length);
  for (const [, , , from, to] of listed) {
    assert.ok(Date.parse(from) <= T0 + 1_000 && Date.parse(to) >= Date.parse(from));
  }
  assert.ok(callIndex(world, 'cf', 'deleteScript') < callIndex(world, 'gh', 'runsCreated'));
  assert.equal(exitCode(report), 1);
});

test('every unarmed preflight refusal stops before `secret put` and deletes the copier', async t => {
  const meta = mutate => {
    const m = operatorMeta();
    mutate(m);
    return { [OPERATOR_META]: JSON.stringify(m) };
  };
  const twoSourceVersions = scripts => {
    scripts.get('notifications').versions = [
      { version_id: randomUUID(), percentage: 50 },
      { version_id: randomUUID(), percentage: 50 },
    ];
  };
  const cases = [
    [
      'sync covers a target',
      {},
      meta(m =>
        m.infisical.syncs.push({ environment: 'production', path: '/workloads/notifications' })
      ),
      f => f.includes('infisical_sync_covers_target'),
    ],
    [
      'import covers a target',
      {},
      meta(m =>
        m.infisical.imports.push({
          environment: 'production',
          importPath: '/workloads/notifications',
        })
      ),
      f => f.includes('infisical_import_covers_target'),
    ],
    [
      'reader outside the allowed list',
      {},
      meta(m =>
        m.infisical.readers.push({
          principal: 'synthetic-unlisted-reader',
          environment: 'production',
          paths: ['/workloads/notifications'],
        })
      ),
      f => f.includes('infisical_reader_not_allowed'),
    ],
    [
      'target already present',
      {},
      meta(m => m.infisical.names['/workloads/notifications'].push(BATCH.rows[0].secretKey)),
      f => f.some(x => x.startsWith('target_present_or_unread_')),
    ],
    [
      'mixed source serving versions',
      { setup: twoSourceVersions },
      {},
      f => f.includes('source_serving_version_not_single'),
    ],
    [
      'source serving version bindings differ while its settings look right',
      { sourceVersionBindings: sourceBindings().slice(1) },
      {},
      f => f.some(x => x.startsWith('source_')),
    ],
    [
      'copier traces turned on',
      {
        settingsPatch: {
          observability: {
            ...copierSettingsResult().observability,
            traces: { ...copierSettingsResult().observability.traces, enabled: true },
          },
        },
      },
      {},
      f => f.includes('copier_setting_observability'),
    ],
  ];
  for (const [name, o, env, expected] of cases) {
    await t.test(name, async () => {
      const { world, report, text } = await drive(o, env);
      assert.equal(report.stopReason, 'preflight_gate_failed');
      const failures = report.gates.find(g => g.gate === 'preflight').failures;
      assert.ok(expected(failures), JSON.stringify(failures));
      assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
      assertNeverArmed(world);
      assert.equal(world.infisical.clientSecretUses, 0);
      assert.equal(report.cleanup.beforeNotBefore, true);
      assert.equal(report.cleanup.scriptStatus, 404);
      assert.ok(!text.includes('synthetic-unlisted-reader'));
      assert.equal(exitCode(report), 1);
    });
  }
});

test('a preflight refusal never arms, even when the cleanup delete is refused', async () => {
  const meta = operatorMeta();
  meta.infisical.syncs = [{ environment: 'production', path: '/workloads/notifications' }];
  const { world, report } = await drive(
    { cfFail: { deleteScript: 'cloudflare_api_error' } },
    { [OPERATOR_META]: JSON.stringify(meta) }
  );
  assert.equal(report.stopReason, 'preflight_gate_failed');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.equal(report.cleanup.attempted, true);
  assert.equal(report.cleanup.deleted, false);
  assert.deepEqual(report.cleanup.errors, ['delete:cloudflare_api_error']);
  assert.equal(report.cleanup.scriptStatus, 200);
  assert.equal(report.armWrite, undefined);
  assert.deepEqual(report.unresolved, ['copier_not_proved_deleted']);
  assert.equal(report.operatorAction, 'revoke_writer_then_read_back_copier');
  assert.equal(exitCode(report), 1);
});

test('a passing preflight that reaches the final guard at the arm deadline never arms', async () => {
  const { world, report } = await drive({
    onSnapshot: (w, n) => {
      if (n === 2) w.clock.t = T0 + 18 * 60_000;
    },
  });
  assert.equal(report.gates.find(g => g.gate === 'preflight').ok, true);
  assert.equal(report.stopReason, 'held_arm_deadline');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.equal(report.cleanup.scriptStatus, 404);
});

test('a copier version that changed after the preflight is never armed or deleted', async () => {
  const { world, report } = await drive({
    onSnapshot: (w, n) => {
      if (n === 2) w.replaceCopierVersion();
    },
  });
  assert.equal(report.stopReason, 'copier_changed_before_arm');
  assertNeverArmed(world);
  assert.ok(!wranglerVerbs(world).includes('delete'));
  assert.equal(report.cleanup.note, 'unattributable_versions');
  assert.deepEqual(report.unresolved, ['copier_not_proved_deleted']);
});
test('a put that fails after landing is unproved: the attributed armed copier is deleted, never retried', async () => {
  const { world, report } = await drive({ put: { code: -1, lands: true } });
  assert.equal(report.stopReason, 'secret_put_unproved');
  assert.equal(report.armWrite, 'unproved');
  assert.ok(report.armedVersion);
  assert.deepEqual(world.secretInputs, [CLIENT_SECRET]);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'secret', 'delete']);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.deepEqual(report.unresolved, ['secret_put_unproved']);
  assert.equal(report.operatorAction, 'revoke_writer_then_read_back_copier');
  assert.equal(world.readLog.length, 0);
  assert.equal(exitCode(report), 1);
});

test('a put that fails without landing is still unproved; only the unarmed copier is deleted', async () => {
  const { world, report } = await drive({ put: { code: -1, lands: false } });
  assert.equal(report.stopReason, 'secret_put_unproved');
  assert.equal(report.armedVersion, undefined);
  assert.equal(report.gates.at(-1).gate, 'preflight-armed');
  assert.equal(report.gates.at(-1).ok, false);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'secret', 'delete']);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.deepEqual(report.unresolved, ['secret_put_unproved']);
});

test('an armed version with any binding beyond the writer secret is refused and never deleted', async () => {
  const { world, report } = await drive({
    put: { extra: [{ name: 'EXTRA', type: 'plain_text', text: 'x' }] },
  });
  assert.equal(report.stopReason, 'arm_readback_refused');
  assert.ok(report.gates.at(-1).failures.includes('armed_bindings_not_writer_only'));
  assert.equal(report.armWrite, 'unproved');
  assert.equal(report.armedVersion, undefined);
  assert.deepEqual(world.secretInputs, [CLIENT_SECRET]);
  assert.ok(!wranglerVerbs(world).includes('delete'));
  assert.equal(report.cleanup.note, 'unattributable_versions');
  assert.deepEqual(report.unresolved, ['secret_put_unproved', 'copier_not_proved_deleted']);
  assert.equal(world.readLog.length, 0);
});

test('a failed deploy that landed is attributed by run pins and deleted; never armed', async () => {
  const { world, report } = await drive({ deploy: { code: 1, lands: true } });
  assert.equal(report.stopReason, 'wrangler_deploy_failed');
  assert.deepEqual(report.errorCodes, ['[code: 10021]']);
  assert.equal(report.deployWrite, 'unproved');
  assert.ok(report.unarmedVersion);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.equal(report.unresolved, undefined);
});

test('a failed deploy that did not land leaves nothing to delete', async () => {
  const { world, report } = await drive({ deploy: { code: 1, lands: false } });
  assert.equal(report.stopReason, 'wrangler_deploy_failed');
  assert.deepEqual(wranglerVerbs(world), ['deploy']);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.equal(report.cleanup.gate.ok, true);
});

test('a deployed version without the pins of this run is never recorded or deleted', async () => {
  const { world, report } = await drive({
    deploy: {
      pins: {
        M65_RUN_ID: 'm65-gh-someone-else-1',
        M65_NOT_BEFORE: iso(T0 + 24 * 60_000),
        M65_NOT_AFTER: iso(T0 + 39 * 60_000),
        M65_INFISICAL_CLIENT_ID: CLIENT_ID,
      },
    },
  });
  assert.equal(report.stopReason, 'copier_deployment_unattributable');
  assert.equal(report.unarmedVersion, undefined);
  assert.deepEqual(wranglerVerbs(world), ['deploy']);
  assert.equal(report.cleanup.note, 'unattributable_versions');
  assert.deepEqual(report.unresolved, ['copier_not_proved_deleted']);
});

test('no armed readiness receipt before not-before: deleted before the window, nothing read', async () => {
  const { world, report } = await drive({ ticksStopAfterArm: true });
  assert.equal(report.stopReason, 'held_no_armed_readiness');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'secret', 'delete']);
  assert.equal(report.cleanup.beforeNotBefore, true);
  assert.equal(world.readLog.length, 0);
  assert.equal(exitCode(report), 1);
});

test('a missing final receipt is unobserved, not complete; the copier is still deleted', async () => {
  const { world, report } = await drive({ ticksStopAtWindow: true });
  assert.equal(report.stopReason, 'result_unobserved');
  assert.equal(report.finalReceipt, undefined);
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'secret', 'delete']);
  assert.equal(report.cleanup.beforeNotBefore, false);
  assert.ok(Date.parse(report.cleanup.at) >= Date.parse(report.notAfter));
  assert.equal(exitCode(report), 1);
});

test('a copier version this run did not record is left in place and reported', async () => {
  const world = makeWorld({ propagationMs: 30 * 60_000 });
  const startTail = world.startTail;
  world.startTail = clock => {
    world.replaceCopierVersion();
    return startTail(clock);
  };
  const report = await run(ioOf(world));
  assert.equal(report.stopReason, 'held_no_readiness_tick');
  assert.equal(report.cleanup.note, 'unattributable_versions');
  assert.equal(report.cleanup.scriptStatus, 200);
  assert.ok(!wranglerVerbs(world).includes('delete'));
  assert.equal(exitCode(report), 1);
});

test('a refused cleanup delete is reported and fails the run; it is never forced or retried', async () => {
  const { world, report } = await drive({ cfFail: { deleteScript: 'cloudflare_api_error' } });
  assert.equal(report.status, 'cloudflare_complete');
  assert.equal(report.cleanup.attempted, true);
  assert.equal(report.cleanup.deleted, false);
  assert.deepEqual(report.cleanup.errors, ['delete:cloudflare_api_error']);
  assert.equal(report.cleanup.scriptStatus, 200);
  assert.equal(report.cleanup.gate.ok, false);
  assert.equal(world.calls.filter(c => c[1] === 'deleteScript').length, 1);
  assert.deepEqual(report.unresolved, ['copier_not_proved_deleted']);
  assert.equal(exitCode(report), 1);
});

test('the complete receipt seen only as a later idle marker is not accepted as proof', async () => {
  const world = makeWorld();
  const startTail = world.startTail;
  let dropped = false;
  world.startTail = clock => {
    const tail = startTail(clock);
    return {
      stop: tail.stop,
      async next(deadline) {
        const event = await tail.next(deadline);
        const line = event?.logs[0].message[0];
        if (!dropped && line && JSON.parse(line).gate === 'consumed_now') {
          dropped = true;
          return tail.next(deadline);
        }
        return event;
      },
    };
  };
  const report = await run(ioOf(world));
  assert.equal(report.finalReceipt.outcome, 'idle');
  assert.equal(report.finalReceipt.prior, 'complete');
  assert.equal(report.status, 'incomplete');
  assert.equal(report.gates.at(-1).gate, 'postrun-cloudflare');
  assert.equal(report.gates.at(-1).ok, false);
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.equal(exitCode(report), 1);
});

test('a stop signal ends the readiness wait, refuses arming, and cleans up before the tail stops', async () => {
  const world = makeWorld();
  const controller = new AbortController();
  world.startTail = () => ({
    next() {
      controller.abort();
      return new Promise(() => {});
    },
    async stop() {
      world.calls.push(['tail', 'stop']);
      return 'killed';
    },
  });
  const report = await run(ioOf(world, { signal: controller.signal }));
  assert.equal(report.stopReason, 'stopped_by_signal');
  assert.deepEqual(wranglerVerbs(world), ['deploy', 'delete']);
  assertNeverArmed(world);
  assert.ok(callIndex(world, 'cf', 'deleteScript') < callIndex(world, 'tail', 'stop'));
  assert.equal(report.tail.stop, 'killed');
  assert.equal(report.cleanup.scriptStatus, 404);
  assert.deepEqual(report.unresolved, ['stopped_by_signal']);
  assert.equal(exitCode(report), 1);
});

test('a stop signal before the first phase admits nothing', async () => {
  const world = makeWorld();
  const controller = new AbortController();
  controller.abort();
  const report = await run(ioOf(world, { signal: controller.signal }));
  assert.equal(report.stopReason, 'stopped_by_signal');
  assert.deepEqual(world.calls, []);
  assert.equal(report.cleanup.note, 'not_created');
});

test('cleanup survives malformed provider data, reports it, and never deletes on a failed read', async () => {
  const calls = [];
  const cf = {
    async deploymentVersions() {
      calls.push('read');
      throw new TypeError('synthetic malformed response');
    },
    async deleteScript() {
      calls.push('delete');
    },
    async scriptNames() {
      return [];
    },
  };
  const result = await cleanup(
    { cf, gh: {}, clock: { now: () => T0 }, sleep: async () => {} },
    {
      created: true,
      recorded: new Set([randomUUID()]),
      before: {},
      plan: { notBefore: T0 + 60_000 },
      since: T0,
    }
  );
  assert.deepEqual(calls, ['read']);
  assert.deepEqual(result.errors, ['read:internal']);
  assert.equal(result.attempted, false);
  assert.equal(result.scriptStatus, null);
  assert.equal(result.gate.ok, false);
});

test('a transient cleanup read is read once more; the delete itself is never repeated', async () => {
  const id = randomUUID();
  let reads = 0;
  let present = true;
  const calls = [];
  const cf = {
    async deploymentVersions() {
      if (++reads === 1) throw new StopError('cloudflare_transport');
      return present ? [{ version_id: id, percentage: 100 }] : null;
    },
    async deleteScript() {
      calls.push('delete');
      present = false;
    },
    async scriptStatus() {
      return present ? 200 : 404;
    },
    async doNamespaces() {
      return [];
    },
    async scriptNames() {
      return [];
    },
  };
  const result = await cleanup(
    { cf, gh: {}, clock: { now: () => T0 }, sleep: async () => {} },
    { created: true, recorded: new Set([id]), before: {}, plan: { notBefore: T0 }, since: T0 }
  );
  assert.deepEqual(calls, ['delete']);
  assert.equal(result.deleted, true);
  assert.equal(result.scriptStatus, 404);
  assert.equal(result.errors, undefined);
  assert.equal(result.gate.ok, true);
});

test('tail splitter reads indented events across chunks and skips banners', () => {
  const events = [];
  const split = jsonObjectSplitter(e => events.push(e));
  const a = JSON.stringify({ logs: [{ message: ['{"x": "} {"}'] }], exceptions: [] }, null, 4);
  const b = JSON.stringify({ logs: [], note: 'quote \\" brace }' }, null, 4);
  const text = `Successfully created tail\n${a}\nConnected\n${b}\n`;
  for (let i = 0; i < text.length; i += 7) split(text.slice(i, i + 7));
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].note, 'quote \\" brace }');
});

test('receipts are filtered by run id and exact schema; exceptions are only counted', async () => {
  const gate = fakeGateNamespace();
  const receipt = await runTick({
    env: makeEnv({
      values: syntheticValues(),
      gate,
      notBefore: iso(T0 + 3_600_000),
      notAfter: iso(T0 + 4_000_000),
      armed: false,
    }),
    cron: CRON,
    scheduledTime: T0,
    now: () => T0,
    fetchImpl: async () => new Response(null, { status: 599 }),
    batch: BATCH,
  });
  const line = JSON.stringify(receipt);
  const event = {
    logs: [{ message: [line, 'plain text', JSON.stringify({ ...receipt, extra: 1 })] }],
    exceptions: [{ message: 'synthetic' }],
  };
  const mine = receiptsOf(event, receipt.runId);
  assert.equal(mine.receipts.length, 1);
  assert.equal(mine.exceptions, 1);
  assert.equal(receiptsOf(event, 'm65-another-run-0001').receipts.length, 0);
});

test('child processes inherit no writer secret, operator readback or GitHub token', () => {
  const env = baseEnv();
  const plain = childEnv(env);
  const wrangler = childEnv(env, { cloudflare: true });
  assert.deepEqual(Object.keys(plain).sort(), [
    'CI',
    'HOME',
    'PATH',
    'WRANGLER_SEND_METRICS',
    'XDG_CONFIG_HOME',
  ]);
  assert.deepEqual(Object.keys(wrangler).sort(), [
    'CI',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'HOME',
    'PATH',
    'WRANGLER_SEND_METRICS',
    'XDG_CONFIG_HOME',
  ]);
  assert.equal(wrangler.CLOUDFLARE_ACCOUNT_ID, BATCH.accountId);
  assert.equal(wrangler.HOME, '/tmp/runner-temp/m84-isolated-home');
  assert.notEqual(wrangler.HOME, env.HOME);
  assert.ok(wrangler.XDG_CONFIG_HOME.startsWith(wrangler.HOME));
});

test('a refused name table stops before any network call and prints nothing', async () => {
  const { world, report } = await drive({
    nameTable: () => ({
      gate: 'table',
      ok: false,
      failures: ['policy_targets_differ'],
      table: 'x',
    }),
  });
  assert.equal(report.stopReason, 'name_table_refused');
  assert.deepEqual(report.gates, [
    { gate: 'table', ok: false, failures: ['policy_targets_differ'] },
  ]);
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.printed, []);
});

test('Cloudflare client: denials, absence, versions, pages, module hashes and an empty delete', async () => {
  const seen = [];
  const json = (result, info) =>
    new Response(JSON.stringify({ success: true, result, result_info: info }), { status: 200 });
  const versionId = randomUUID();
  // Raw multipart bytes as the provider sends them: file parts and a part without a filename,
  // with LF, CRLF and non-ASCII bytes. (A FormData built here would normalize a string part's LF
  // to CRLF when serialized, which is the round-2 fixture defect, not provider behaviour.)
  const parts = {
    'worker.mjs': ['file', 'export default {};\n// lf only\n'],
    'core.mjs': ['field', 'export const synthetic = "ü";\nexport const two = 2;\n'],
    'manifest.mjs': ['file', 'export const mixed = 1;\r\n// crlf then lf\n'],
    metadata: ['field', '{"synthetic":true}'],
  };
  const boundary = 'm84-synthetic-boundary';
  const multipart = Buffer.concat([
    ...Object.entries(parts).map(([name, [kind, text]]) =>
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${kind === 'file' ? `; filename="${name}"\r\nContent-Type: application/javascript+module` : ''}\r\n\r\n`
        ),
        Buffer.from(text, 'utf8'),
        Buffer.from('\r\n'),
      ])
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const sha = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    const u = new URL(url);
    if (init.method === 'DELETE') {
      assert.equal(u.searchParams.get('force'), 'false');
      return new Response(null, { status: 200 });
    }
    if (u.pathname.endsWith('/workers/scripts')) return json([{ id: 'b' }, { id: 'a' }]);
    if (u.pathname.endsWith('/missing/deployments')) return new Response('{}', { status: 404 });
    if (u.pathname.endsWith('/x/deployments')) {
      return json({
        deployments: [
          {
            versions: [
              { version_id: 'v2', percentage: 10 },
              { version_id: 'v1', percentage: 90 },
            ],
          },
        ],
      });
    }
    if (u.pathname.endsWith('/bad/deployments'))
      return json({ deployments: [{ versions: [null] }] });
    if (u.pathname.endsWith(`/x/versions/${versionId}`)) {
      return json({
        id: versionId,
        number: 3,
        resources: { bindings: [{ name: 'A', type: 'plain_text', text: 'a' }] },
      });
    }
    if (u.pathname.endsWith('/durable_objects/namespaces')) {
      const page = Number(u.searchParams.get('page'));
      return json([{ id: `n${page}`, script: page === 2 ? COPIER : 'other', class: 'M65Gate' }], {
        total_pages: 2,
      });
    }
    if (u.pathname.endsWith('/content/v2')) {
      return new Response(multipart, {
        status: 200,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
    }
    if (u.pathname.endsWith('/denied/settings')) return new Response('{}', { status: 403 });
    return new Response('{}', { status: 500 });
  };
  const cf = cloudflare({ token: 'synthetic', accountId: BATCH.accountId, fetchImpl });
  assert.deepEqual(await cf.scriptNames(), ['a', 'b']);
  assert.equal(await cf.deploymentVersions('missing'), null);
  assert.deepEqual(await cf.deploymentVersions('x'), [
    { version_id: 'v1', percentage: 90 },
    { version_id: 'v2', percentage: 10 },
  ]);
  await assert.rejects(cf.deploymentVersions('bad'), e => e.reason === 'cloudflare_unreadable');
  assert.deepEqual(await cf.version('x', versionId), {
    id: versionId,
    bindings: [{ name: 'A', type: 'plain_text', text: 'a' }],
  });
  assert.deepEqual(await cf.doNamespaces(COPIER), [{ id: 'n2', script: COPIER, class: 'M65Gate' }]);
  const hashes = await cf.moduleHashes(COPIER);
  assert.deepEqual(Object.keys(hashes).sort(), [
    'core.mjs',
    'manifest.mjs',
    'metadata',
    'worker.mjs',
  ]);
  for (const m of ['worker.mjs', 'core.mjs', 'manifest.mjs']) {
    assert.equal(hashes[m], sha(parts[m][1]), `${m}: digest of the exact uploaded bytes`);
  }
  assert.equal(hashes.metadata, 'unexpected');
  // The tracked modules hash the same way: the module check compares like with like.
  const tracked = moduleHashes();
  const form = new FormData();
  for (const m of Object.keys(tracked)) {
    form.append(m, new File([readFileSync(new URL(`./src/${m}`, import.meta.url))], m));
  }
  const roundTrip = cloudflare({
    token: 'synthetic',
    accountId: BATCH.accountId,
    fetchImpl: async () => new Response(form, { status: 200 }),
  });
  assert.deepEqual(await roundTrip.moduleHashes(COPIER), tracked);
  // Why the fixture is raw bytes: a FormData string part is CRLF-normalized on serialization.
  const normalized = new FormData();
  normalized.append('core.mjs', parts['core.mjs'][1]);
  const echoed = (await new Response(normalized).formData()).get('core.mjs');
  assert.notEqual(sha(echoed), sha(parts['core.mjs'][1]));
  assert.equal(echoed, parts['core.mjs'][1].replaceAll('\n', '\r\n'));
  await assert.rejects(cf.scriptSettings('denied'), e => e.reason === 'cloudflare_unauthorized');
  await cf.deleteScript(COPIER);
  assert.ok(
    seen.includes(
      `DELETE https://api.cloudflare.com/client/v4/accounts/${BATCH.accountId}/workers/scripts/${COPIER}?force=false`
    )
  );
  assert.ok(seen.every(u => !u.includes('synthetic')));
});

test('GitHub client: a missing rollout workflow is unreadable, never zero; run lists are bounded', async () => {
  const seen = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    seen.push(u);
    if (u.pathname.endsWith('/deploy-staging.yml/runs')) return new Response('{}', { status: 404 });
    if (u.searchParams.has('created')) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 7,
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-11-27T18:05:00Z',
              updated_at: '2026-11-27T18:09:00Z',
              head_commit: { message: 'not reported' },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
  };
  const gh = github({ token: 'synthetic', fetchImpl });
  await assert.rejects(activeRollouts(gh), e => e.reason === 'rollout_workflow_unreadable');
  assert.deepEqual(await gh.runsCreated('deploy-production.yml', 'A', 'B'), {
    total: 1,
    runs: [
      {
        id: 7,
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-11-27T18:05:00Z',
        updatedAt: '2026-11-27T18:09:00Z',
      },
    ],
  });
  const listed = seen.at(-1);
  assert.equal(listed.searchParams.get('created'), 'A..B');
  assert.equal(listed.searchParams.get('per_page'), '20');
  assert.equal(await rolloutRunsDuring(gh, T0, T0 + 60_000), 'unreadable');
});

test('a child that ignores its stop signal is killed within the bound', async () => {
  const stubborn =
    "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')";
  const child = spawn(process.execPath, ['-e', stubborn], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => child.stdout.once('data', r));
  assert.equal(await stopChild(child, 300), 'killed');
  const started = Date.now();
  const timedOut = await runChild(process.execPath, ['-e', stubborn], {
    env: { PATH: process.env.PATH },
    timeoutMs: 300,
    graceMs: 300,
  });
  assert.equal(timedOut.code, -1);
  assert.equal(timedOut.stopped, 'timeout');
  // SIGTERM may land before the child installs its handler; either way the result is bounded.
  assert.ok(['exited', 'killed'].includes(timedOut.exit));
  assert.ok(Date.now() - started < 5_000);
  const controller = new AbortController();
  const pending = runChild(process.execPath, ['-e', stubborn], {
    env: { PATH: process.env.PATH },
    timeoutMs: 60_000,
    graceMs: 300,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await pending).stopped, 'signal');
  const missing = await runChild('/nonexistent/m84-synthetic-binary', [], { timeoutMs: 1_000 });
  assert.equal(missing.code, -1);
  const ok = await runChild(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    env: { PATH: process.env.PATH },
    stdin: 'echo',
    timeoutMs: 5_000,
  });
  assert.deepEqual(ok, { code: 0, output: 'echo' });
});

test('workflow: dispatch-only, exact guards, pinned actions, secrets only in the driver step', () => {
  const { load } = createRequire(import.meta.url)('js-yaml');
  const text = readFileSync(
    new URL('../../../.github/workflows/notifications-runtime-copy.yml', import.meta.url),
    'utf8'
  );
  const wf = load(text);
  assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs), ['expected_commit']);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(wf.concurrency, {
    group: 'notifications-runtime-copy',
    'cancel-in-progress': false,
  });
  assert.deepEqual(Object.keys(wf.jobs), ['environment-guard', 'copy']);
  const guard = wf.jobs['environment-guard'];
  assert.equal(guard.environment, undefined);
  assert.deepEqual(guard.permissions, { contents: 'read', actions: 'read' });
  assert.ok(!JSON.stringify(guard).includes('secrets.'));
  assert.equal(
    guard.steps.at(-1).run,
    'node scripts/secrets-migration/m84-notifications-run.mjs --environment-guard'
  );
  assert.deepEqual(Object.keys(guard.steps.at(-1).env).sort(), ['EXPECTED_COMMIT', 'GITHUB_TOKEN']);
  assert.equal(guard.if, wf.jobs.copy.if);
  const job = wf.jobs.copy;
  assert.equal(job.needs, 'environment-guard');
  assert.equal(
    job.if,
    "github.repository == 'Kilo-Org/cloud' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'"
  );
  assert.equal(job.environment, ENVIRONMENT);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^[\w./-]+@[0-9a-f]{40}$/);
    if (step.run) assert.ok(!step.run.includes('${{'), `${step.name} interpolates into run`);
  }
  assert.equal(job.steps[0].with['persist-credentials'], false);
  // The install restores setup-node's pnpm cache first (scripts/typecheck-ci.test.mjs rule).
  const install = job.steps.findIndex(s => /\bpnpm\b.*\binstall\b/.test(s.run ?? ''));
  const warm = job.steps.findIndex(
    s => String(s.uses).startsWith('actions/setup-node@') && s.with?.cache === 'pnpm'
  );
  assert.ok(warm >= 0 && warm < install, 'pnpm cache restored before the install');
  const withSecrets = job.steps.filter(s => JSON.stringify(s).includes('secrets.'));
  assert.deepEqual(
    withSecrets.map(s => s.name),
    ['Run the copier']
  );
  const driver = withSecrets[0];
  assert.equal(driver.run, 'node scripts/secrets-migration/m84-notifications-run.mjs');
  assert.deepEqual(Object.keys(driver.env).sort(), [
    'CLOUDFLARE_API_TOKEN',
    'EXPECTED_COMMIT',
    'GITHUB_TOKEN',
    'M65_INFISICAL_CLIENT_ID',
    'M65_INFISICAL_CLIENT_SECRET',
    'M65_OPERATOR_PREFLIGHT',
  ]);
  assert.ok(!/deploy-workers-|deploy-production/.test(JSON.stringify(wf.concurrency)));
  assert.ok(!text.includes('upload-artifact'));
});
