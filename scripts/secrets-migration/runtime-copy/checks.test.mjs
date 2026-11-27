// Runner-side gates: tracked-source match, renderer, receipt parser, preflight, post-run, cleanup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUN_VARS, newReceipt } from './src/core.mjs';
import * as C from './checks.mjs';
import * as R from './render-config.mjs';
import { TABLE } from './src/table.mjs';
import {
  BATCH,
  FIXTURE,
  CLIENT_ID,
  RUN_ID,
  VERSION_ID,
  armedCopierBindings,
  copierSettingsResult,
  iso,
  unarmedCopierBindings,
} from './fakes.mjs';

const { REPO_ROOT, SRC_DIR, insideRepo, parseArgs } = R;
const {
  WORKER_SOURCES,
  bindArmedPreflight,
  evaluateCleanup,
  evaluateCleanupCloudflare,
  evaluateCleanupInfisical,
  moduleHashes,
  parseJsonc,
  pathCovers,
} = C;
// The fixture table's Notifications batch, its per-Worker sources, and every gate bound to it.
const SRC = WORKER_SOURCES.notifications;
const NAME_MAP = SRC.names;
const EXPECTED_ALIASES = SRC.aliases;
const readTrackedSource = () => C.readTrackedSource(SRC);
const checkSource = (w, p, r, batch = BATCH, src = SRC) =>
  C.checkSource(w, p, r, batch, src, FIXTURE);
const validatedNameTable = () => C.validatedNameTable(BATCH, REPO_ROOT, FIXTURE);
const pinProblems = (pins, nowMs) => R.pinProblems(pins, nowMs, FIXTURE);
const buildConfig = pins => R.buildConfig(pins, SRC_DIR, FIXTURE);
const checkRenderedConfig = (text, pins) => C.checkRenderedConfig(text, pins, SRC_DIR, FIXTURE);
const parseReceipt = (text, batch = BATCH) => C.parseReceipt(text, batch);
const evaluatePreflight = (input, batch = BATCH) => C.evaluatePreflight(input, batch);
const evaluatePostRun = input => C.evaluatePostRun(input, BATCH);
const evaluatePostRunCloudflare = input => C.evaluatePostRunCloudflare(input, BATCH);
const evaluatePostRunInfisical = input => C.evaluatePostRunInfisical(input, BATCH);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const T0 = Date.parse('2026-11-27T16:00:00Z');
const PINS = {
  M65_RUN_ID: RUN_ID,
  M65_BATCH: 'notifications',
  M65_NOT_BEFORE: iso(T0 + 20 * 60_000),
  M65_NOT_AFTER: iso(T0 + 45 * 60_000),
  M65_INFISICAL_CLIENT_ID: CLIENT_ID,
};
const expect = (failures, code) =>
  assert.ok(failures.includes(code), `${code} in ${JSON.stringify(failures)}`);

test('the four-name map equals the tracked Notifications config, reader map and STS policy', () => {
  const { wranglerText, policyText, readerText } = readTrackedSource();
  assert.deepEqual(checkSource(wranglerText, policyText, readerText), []);
  expect(
    checkSource(
      wranglerText.replace('"APNS_PRIVATE_KEY_PROD"', '"APNS_PRIVATE_KEY_X"'),
      policyText,
      readerText
    ),
    'source_bindings_differ'
  );
  expect(
    checkSource(wranglerText, policyText.replace('  - INTERNAL_API_SECRET\n', ''), readerText),
    'policy_targets_differ'
  );
  expect(
    checkSource(
      wranglerText,
      policyText,
      readerText.replace("NEXTAUTH_SECRET: 'NEXTAUTH_SECRET'", "NEXTAUTH_SECRET: 'OTHER_BINDING'")
    ),
    'reader_lookup_differs_NEXTAUTH_SECRET'
  );
  expect(checkSource(wranglerText, policyText, 'no map here'), 'reader_map_unreadable');
  assert.equal(parseJsonc('{"a": "//x", /* c */ "b": [1,],}').a, '//x');
});

test('M108: the copy batch is exactly the Expo row of the four-name map', () => {
  const { wranglerText, policyText, readerText } = readTrackedSource();
  assert.equal(NAME_MAP.length, 4);
  assert.deepEqual(
    BATCH.rows.map(
      r => NAME_MAP.filter(n => n.binding === r.binding && n.secretKey === r.secretKey).length
    ),
    [1]
  );
  const swap = patch => ({ ...BATCH, rows: [{ ...BATCH.rows[0], ...patch }] });
  // A batch row that differs from its name map row in any column refuses.
  for (const [patch, code] of [
    [
      { secretName: 'EXPO_ACCESS_TOKEN_PROD' },
      'batch_row_not_in_name_map_NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    ],
    [{ binding: 'EXPO_TOKEN' }, 'batch_row_not_in_name_map_NOTIFICATIONS_EXPO_ACCESS_TOKEN'],
  ]) {
    expect(checkSource(wranglerText, policyText, readerText, swap(patch)), code);
  }
  // Another name map row (a 1Password-sourced target) is not in the reviewed table.
  for (const n of NAME_MAP.filter(x => x.binding !== 'EXPO_ACCESS_TOKEN')) {
    const failures = checkSource(wranglerText, policyText, readerText, swap(n));
    expect(failures, 'batch_not_in_table');
  }
});

test('name map proposals targeting another row’s store name, a *_PROD name or the unprefixed APNs/Expo name refuse', () => {
  const { wranglerText, policyText, readerText } = readTrackedSource();
  const propose = (i, secretKey, secretPath = NAME_MAP[i].secretPath) =>
    NAME_MAP.map((r, j) => (j === i ? { ...r, secretKey, secretPath } : r));
  const cases = [
    // Another row's store name: the APNs row proposing the Expo store entry's name.
    [propose(0, 'EXPO_ACCESS_TOKEN'), 'target_is_store_name_EXPO_ACCESS_TOKEN'],
    [propose(2, 'INTERNAL_API_SECRET_PROD'), 'target_is_store_name_INTERNAL_API_SECRET_PROD'],
    // Its own store name passes that rule; the suffix, reader and policy checks still refuse.
    [
      propose(0, 'APNS_PRIVATE_KEY_PROD', '/shared'),
      'target_environment_suffix_APNS_PRIVATE_KEY_PROD',
    ],
    [propose(2, 'NEXTAUTH_SECRET_PROD'), 'target_environment_suffix_NEXTAUTH_SECRET_PROD'],
    [propose(0, 'APNS_PRIVATE_KEY', '/shared'), 'reader_lookup_differs_APNS_PRIVATE_KEY'],
    [propose(1, 'EXPO_ACCESS_TOKEN', '/shared'), 'reader_lookup_differs_EXPO_ACCESS_TOKEN'],
  ];
  for (const [names, code] of cases) {
    const failures = checkSource(wranglerText, policyText, readerText, BATCH, { ...SRC, names });
    expect(failures, code);
    expect(failures, 'policy_targets_differ');
  }
  // Dropping a 1Password-sourced name from the map breaks the source, reader and policy match.
  const three = NAME_MAP.filter(r => r.binding !== 'INTERNAL_API_SECRET');
  const failures = checkSource(wranglerText, policyText, readerText, BATCH, {
    ...SRC,
    names: three,
  });
  for (const code of ['source_bindings_differ', 'reader_keys_differ', 'policy_targets_differ']) {
    expect(failures, code);
  }
});

test('validated four-column name table from the tracked sources', () => {
  const v = validatedNameTable();
  assert.deepEqual([v.gate, v.ok, v.failures], ['table', true, []]);
  assert.deepEqual(v.table.split('\n'), [
    'old binding name | store secret_name (if any) | STS lookup name (= Infisical target) | policy entry',
    'APNS_PRIVATE_KEY | APNS_PRIVATE_KEY_PROD | NOTIFICATIONS_APNS_PRIVATE_KEY (/workloads/notifications/NOTIFICATIONS_APNS_PRIVATE_KEY) | NOTIFICATIONS_APNS_PRIVATE_KEY',
    'EXPO_ACCESS_TOKEN | EXPO_ACCESS_TOKEN | NOTIFICATIONS_EXPO_ACCESS_TOKEN (/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN) | NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    'NEXTAUTH_SECRET | NEXTAUTH_SECRET_PROD | NEXTAUTH_SECRET (/shared/NEXTAUTH_SECRET) | NEXTAUTH_SECRET',
    'INTERNAL_API_SECRET | INTERNAL_API_SECRET_PROD | INTERNAL_API_SECRET (/shared/INTERNAL_API_SECRET) | INTERNAL_API_SECRET',
  ]);
  assert.deepEqual(EXPECTED_ALIASES, {
    NOTIFICATIONS_APNS_PRIVATE_KEY: 'APNS_PRIVATE_KEY',
    NOTIFICATIONS_EXPO_ACCESS_TOKEN: 'EXPO_ACCESS_TOKEN',
  });
});

test('renderer: pins, lead time, window length and a closed config', () => {
  assert.deepEqual(pinProblems(PINS, T0), []);
  assert.deepEqual(
    pinProblems(
      { ...PINS, M65_NOT_BEFORE: iso(T0 + 10 * 60_000), M65_NOT_AFTER: iso(T0 + 30 * 60_000) },
      T0
    ),
    ['not_before_too_soon']
  );
  assert.deepEqual(pinProblems({ ...PINS, M65_NOT_AFTER: iso(T0 + 23 * 60_000) }, T0), [
    'window_length',
  ]);
  assert.deepEqual(pinProblems({ ...PINS, M65_NOT_AFTER: iso(T0 + 55 * 60_000) }, T0), [
    'window_length',
  ]);
  assert.deepEqual(pinProblems({ ...PINS, M65_RUN_ID: 'Bad' }, T0), ['pin_M65_RUN_ID']);
  const cfg = buildConfig(PINS);
  assert.deepEqual(
    [cfg.workers_dev, cfg.preview_urls, cfg.routes, cfg.triggers, cfg.logpush],
    [false, false, [], { crons: ['* * * * *'] }, false]
  );
  assert.deepEqual(cfg.observability, {
    enabled: true,
    head_sampling_rate: 1,
    logs: { invocation_logs: false },
    traces: { enabled: false },
  });
  for (const k of [
    'services',
    'queues',
    'workflows',
    'tail_consumers',
    'kv_namespaces',
    'r2_buckets',
    'd1_databases',
  ]) {
    assert.equal(cfg[k], undefined, k);
  }
  assert.deepEqual(Object.keys(cfg.vars).sort(), [...RUN_VARS].sort());
  const text = JSON.stringify(cfg);
  assert.deepEqual(checkRenderedConfig(text, PINS), []);
  for (const patch of [
    { workers_dev: true },
    { preview_urls: true },
    { routes: ['m65.example.com/*'] },
    { triggers: { crons: ['* * * * *', '0 * * * *'] } },
    { observability: { ...cfg.observability, traces: { enabled: true } } },
    { logpush: true },
    { services: [{ binding: 'X', service: 'notifications' }] },
    {
      durable_objects: {
        bindings: [{ name: 'M65_GATE', class_name: 'M65Gate', script_name: 'other' }],
      },
    },
  ]) {
    assert.deepEqual(checkRenderedConfig(JSON.stringify({ ...cfg, ...patch }), PINS), [
      'config_not_closed',
    ]);
  }
  assert.deepEqual(checkRenderedConfig('{', PINS), ['config_unparsable']);
  assert.throws(() => parseArgs(['--run-id', RUN_ID]));
  assert.equal(insideRepo(join(REPO_ROOT, 'x.json')), true);
  assert.equal(insideRepo(join(tmpdir(), 'x.json')), false);
});

test('renderer CLI writes once to scratch with mode 0600 and refuses the repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm65-render-'));
  // The CLI renders from the checked-in table only.
  const worker = TABLE.workers[0];
  try {
    const now = Date.now();
    const args = out => [
      join(HERE, 'render-config.mjs'),
      '--run-id',
      RUN_ID,
      '--batch',
      worker,
      '--not-before',
      iso(now + 17 * 60_000),
      '--not-after',
      iso(now + 40 * 60_000),
      '--client-id',
      CLIENT_ID,
      '--out',
      out,
    ];
    const out = join(dir, 'copier.wrangler.json');
    const ok = spawnSync(process.execPath, args(out), { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const line = JSON.parse(ok.stdout);
    assert.deepEqual(Object.keys(line).sort(), [
      'configPath',
      'configSha256',
      'cron',
      'name',
      'notAfter',
      'notBefore',
    ]);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const pins = JSON.parse(readFileSync(out, 'utf8')).vars;
    assert.equal(pins.M65_BATCH, worker);
    assert.deepEqual(C.checkRenderedConfig(readFileSync(out, 'utf8'), pins), []);
    assert.equal(
      spawnSync(process.execPath, args(out), { encoding: 'utf8' }).status,
      2,
      'no overwrite'
    );
    assert.equal(
      spawnSync(process.execPath, args(join(REPO_ROOT, 'm65.json')), { encoding: 'utf8' }).status,
      2
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt parser accepts exactly the receipt contract', () => {
  const base = {
    ...newReceipt(BATCH.id),
    runId: RUN_ID,
    versionId: VERSION_ID,
    outcome: 'unarmed',
    reason: 'writer_not_installed',
    window: 'before',
    ready: { pins: true, envClosed: true, bindings: true, gate: true, cron: true },
  };
  assert.deepEqual(parseReceipt(JSON.stringify(base)).failures, []);
  const bad = patch => parseReceipt(JSON.stringify({ ...base, ...patch })).failures;
  expect(bad({ extra: 1 }), 'receipt_keys');
  expect(bad({ outcome: 'done' }), 'receipt_outcome');
  expect(bad({ reason: 'Value-Like-Token' }), 'receipt_reason');
  expect(bad({ runId: 'x' }), 'receipt_run_id');
  expect(bad({ versionId: 'v1' }), 'receipt_version_id');
  expect(bad({ ready: { pins: true } }), 'receipt_ready');
  expect(bad({ reads: 5 }), 'receipt_counts');
  expect(
    bad({
      rows: [
        {
          binding: 'APNS_PRIVATE_KEY',
          sourceSecretName: 'APNS_PRIVATE_KEY_PROD',
          secretPath: '/workloads/notifications',
          secretKey: 'NOTIFICATIONS_APNS_PRIVATE_KEY',
          read: true,
          secretId: 'x',
        },
      ],
    }),
    'receipt_row_0'
  );
  expect(
    bad({
      rows: [
        {
          binding: 'EXPO_ACCESS_TOKEN',
          sourceSecretName: 'EXPO_ACCESS_TOKEN',
          secretPath: '/shared',
          secretKey: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
          read: true,
        },
      ],
    }),
    'receipt_row_0'
  );
  const row = {
    binding: 'EXPO_ACCESS_TOKEN',
    sourceSecretName: 'EXPO_ACCESS_TOKEN',
    secretPath: '/workloads/notifications',
    secretKey: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
    read: true,
  };
  assert.deepEqual(bad({ rows: [row], reads: 1 }), []);
  expect(bad({ rows: [row, row] }), 'receipt_rows');
  expect(bad({ posts: 2 }), 'receipt_counts');
  assert.deepEqual(parseReceipt('not json').failures, ['receipt_unparsable']);
});

const SOURCE_VERSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ARMED_VERSION = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const OTHER_VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function preflightFixture() {
  const storeSecrets = NAME_MAP.map((r, i) => ({
    id: String(i).repeat(32),
    name: r.secretName,
    scopes: ['workers'],
    status: 'active',
  }));
  const srcBindings = [
    { name: 'HYPERDRIVE', type: 'hyperdrive' },
    ...NAME_MAP.map(r => ({
      name: r.binding,
      type: 'secrets_store_secret',
      store_id: r.storeId,
      secret_name: r.secretName,
    })),
  ];
  const copierBindings = unarmedCopierBindings(PINS, 'ns-1');
  const readiness = {
    ...newReceipt(BATCH.id),
    runId: RUN_ID,
    versionId: VERSION_ID,
    outcome: 'unarmed',
    reason: 'writer_not_installed',
    armed: false,
    window: 'before',
    ready: { pins: true, envClosed: true, bindings: true, gate: true, cron: true },
  };
  const meta = {
    source: {
      deployments: [{ version_id: SOURCE_VERSION, percentage: 100 }],
      version: { id: SOURCE_VERSION, bindings: srcBindings },
    },
    store: { id: '342a86d9e3a94da698e82d0c6e2a36f0', secrets: storeSecrets },
    copier: {
      doNamespaces: [{ id: 'ns-1', script: 'm65-notifications-copy', class: 'M65Gate' }],
      deployments: [{ version_id: VERSION_ID, percentage: 100 }],
      version: { id: VERSION_ID, bindings: copierBindings },
      settings: copierSettingsResult(),
      subdomain: { enabled: false, previews_enabled: false },
      routes: [],
      domains: [],
      schedules: ['* * * * *'],
      queueConsumers: [],
      workflows: [],
      modules: moduleHashes(),
    },
    infisical: {
      names: { '/workloads/notifications': [] },
      syncs: [],
      imports: [],
      approvalPolicies: [],
      readers: [
        {
          principal: 'sts-production',
          environment: 'production',
          paths: ['/shared/**', '/workloads/**'],
        },
      ],
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
        accessTokenNumUsesLimit: 2,
        clientSecretNumUsesLimit: 1,
        clientSecretExpiresAt: iso(Date.parse(PINS.M65_NOT_AFTER) + 5 * 60_000),
      },
    },
  };
  // The caller's post-put readback of the copier: the armed version serves 100%.
  const armedObserved = {
    deployments: [{ version_id: ARMED_VERSION, percentage: 100 }],
    version: { id: ARMED_VERSION, bindings: armedCopierBindings(PINS, 'ns-1') },
  };
  return {
    meta,
    input: {
      meta,
      pins: PINS,
      deployedVersionId: VERSION_ID,
      allowedReaders: ['sts-production'],
      readinessReceipt: JSON.stringify(readiness),
      nowMs: T0,
    },
    storeSecrets,
    srcBindings,
    copierBindings,
    readiness,
    armedObserved,
  };
}

test('preflight passes the closed unarmed copier and catches each open path', () => {
  const { meta, input, srcBindings, copierBindings, readiness, storeSecrets } = preflightFixture();
  const pre = evaluatePreflight(input);
  assert.deepEqual(pre, {
    gate: 'preflight',
    ok: true,
    failures: [],
    pins: {
      runId: RUN_ID,
      versionId: VERSION_ID,
      storeIds: { EXPO_ACCESS_TOKEN: storeSecrets.find(s => s.name === 'EXPO_ACCESS_TOKEN').id },
      sourceDeployments: [{ version_id: SOURCE_VERSION, percentage: 100 }],
    },
  });
  const bad = (metaPatch = {}, inputPatch = {}) =>
    evaluatePreflight({ ...input, meta: { ...meta, ...metaPatch }, ...inputPatch }).failures;
  const withCopier = p => ({ copier: { ...meta.copier, ...p } });
  const withBindings = bindings => withCopier({ version: { id: VERSION_ID, bindings } });
  const withInf = p => ({ infisical: { ...meta.infisical, ...p } });
  const withSource = p => ({ source: { ...meta.source, ...p } });
  const receipt = p => ({ readinessReceipt: JSON.stringify({ ...readiness, ...p }) });

  // Too late: at or after not-before, or an unusable clock.
  expect(bad({}, { nowMs: Date.parse(PINS.M65_NOT_BEFORE) }), 'preflight_after_window_open');
  expect(bad({}, { nowMs: Number.NaN }), 'preflight_after_window_open');
  expect(bad({}, { nowMs: String(T0) }), 'preflight_after_window_open');

  expect(
    bad(withCopier({ subdomain: { enabled: true, previews_enabled: false } })),
    'copier_workers_dev_or_preview_on'
  );
  expect(bad(withCopier({ routes: [{ pattern: 'x' }] })), 'copier_routes_present');
  expect(bad(withCopier({ schedules: ['* * * * *', '0 * * * *'] })), 'copier_schedule_differs');
  expect(
    bad(
      withBindings([
        ...copierBindings,
        { name: 'NOTIF', type: 'service', service: 'notifications' },
      ])
    ),
    'copier_bindings_not_closed'
  );
  expect(
    bad(
      withBindings(
        copierBindings.map(b => (b.name === 'M65_GATE' ? { ...b, script_name: 'other' } : b))
      )
    ),
    'copier_bindings_not_closed'
  );
  const patched = (name, p) => copierBindings.map(b => (b.name === name ? { ...b, ...p } : b));
  expect(
    bad(withBindings(patched('M65_GATE', { namespace_id: 'ns-2' }))),
    'copier_bindings_not_closed'
  );
  expect(
    bad(withBindings(patched('M65_NOT_AFTER', { text: iso(T0) }))),
    'copier_bindings_not_closed'
  );
  expect(
    bad(withBindings(copierBindings.filter(b => b.name !== 'CF_VERSION_METADATA'))),
    'copier_bindings_not_closed'
  );
  expect(bad(withBindings([...copierBindings, null])), 'copier_deployment_not_the_unarmed_version');

  // Already armed: the serving version carries the writer secret binding.
  for (const failures of [
    bad(withBindings(armedCopierBindings(PINS, 'ns-1'))),
    bad(
      withCopier({
        deployments: [{ version_id: ARMED_VERSION, percentage: 100 }],
        version: { id: ARMED_VERSION, bindings: armedCopierBindings(PINS, 'ns-1') },
      }),
      { deployedVersionId: ARMED_VERSION }
    ),
  ]) {
    expect(failures, 'copier_already_armed');
    expect(failures, 'copier_bindings_not_closed');
  }
  expect(
    bad({}, receipt({ armed: true, outcome: 'idle', reason: 'outside_window' })),
    'readiness_receipt_missing'
  );

  // Bindings come only from the serving version's readback: settings bindings never count.
  const withSettingsBindings = bindings =>
    withCopier({ settings: { ...copierSettingsResult(), bindings } });
  assert.deepEqual(bad(withSettingsBindings(armedCopierBindings(PINS, 'ns-1'))), []);
  expect(
    bad({ copier: { ...withSettingsBindings(copierBindings).copier, version: undefined } }),
    'copier_bindings_not_closed'
  );

  // The unarmed version must be the single exact 100% serving version, read back by its id.
  for (const patch of [
    { version: { id: OTHER_VERSION, bindings: copierBindings } },
    { version: { id: VERSION_ID, bindings: copierBindings, latest: true } },
    { version: null },
    {
      deployments: [
        { version_id: VERSION_ID, percentage: 50 },
        { version_id: OTHER_VERSION, percentage: 50 },
      ],
    },
    { deployments: [{ version_id: VERSION_ID, percentage: 99 }] },
    { deployments: [{ version_id: VERSION_ID, percentage: 100, extra: 1 }] },
    { deployments: [] },
  ]) {
    expect(bad(withCopier(patch)), 'copier_deployment_not_the_unarmed_version');
  }
  expect(
    bad({}, { deployedVersionId: OTHER_VERSION }),
    'copier_deployment_not_the_unarmed_version'
  );
  expect(bad({}, { deployedVersionId: undefined }), 'copier_deployment_not_the_unarmed_version');
  expect(
    bad(withCopier({ modules: { ...meta.copier.modules, 'core.mjs': '0'.repeat(64) } })),
    'copier_modules_differ'
  );

  // The unarmed readiness receipt: this run and version, before the window, every flag ready,
  // and no gate, login, read or post.
  for (const p of [
    { versionId: OTHER_VERSION },
    { runId: 'm65-other-run-0001' },
    { window: 'open' },
    { ready: null, reason: 'not_ready_cron', outcome: 'refused' },
    { ready: { ...readiness.ready, cron: false } },
    { gate: 'consumed_now' },
    { logins: 1 },
    { reads: 1 },
    { reason: 'outside_window' },
  ]) {
    expect(bad({}, receipt(p)), 'readiness_receipt_missing');
  }
  expect(bad({}, { readinessReceipt: undefined }), 'readiness_receipt_missing');
  expect(bad({}, { readinessReceipt: '{' }), 'readiness_receipt_missing');
  assert.deepEqual(bad({}, { readinessReceipt: readiness }), [], 'a parsed receipt object passes');

  // The source: one exact 100% serving version, its bindings read back by that id.
  for (const patch of [
    {
      deployments: [
        { version_id: SOURCE_VERSION, percentage: 90 },
        { version_id: OTHER_VERSION, percentage: 10 },
      ],
    },
    { version: { id: OTHER_VERSION, bindings: srcBindings } },
    { version: undefined, bindings: srcBindings },
    {
      deployments: [{ version_id: 's1', percentage: 100 }],
      version: { id: 's1', bindings: srcBindings },
    },
  ]) {
    expect(bad(withSource(patch)), 'source_serving_version_not_single');
  }
  expect(
    bad(withSource({ version: { id: SOURCE_VERSION, bindings: srcBindings.slice(0, 3) } })),
    'source_live_bindings_differ'
  );
  // The source must still carry all four bindings, not only the copied one.
  expect(
    bad(
      withSource({
        version: {
          id: SOURCE_VERSION,
          bindings: srcBindings.filter(b => b.name === 'EXPO_ACCESS_TOKEN'),
        },
      })
    ),
    'source_live_bindings_differ'
  );

  const target = `${BATCH.rows[0].secretPath}/${BATCH.rows[0].secretKey}`;
  expect(
    bad(withInf({ names: { '/workloads/notifications': [BATCH.rows[0].secretKey] } })),
    `target_present_or_unread_${BATCH.rows[0].secretKey}`
  );
  expect(
    bad(withInf({ names: { '/shared': [] } })),
    `target_present_or_unread_${BATCH.rows[0].secretKey}`
  );
  // Names outside the copy batch (a 1Password-sourced target already present) never block it.
  assert.deepEqual(
    bad(
      withInf({
        names: {
          '/workloads/notifications': ['NOTIFICATIONS_APNS_PRIVATE_KEY'],
          '/shared': ['NEXTAUTH_SECRET', 'INTERNAL_API_SECRET'],
        },
      })
    ),
    []
  );
  expect(
    bad(withInf({ syncs: [{ environment: 'production', path: '/workloads/notifications' }] })),
    'infisical_sync_covers_target'
  );
  expect(
    bad(withInf({ syncs: [{ environment: 'production', path: '/' }] })),
    'infisical_sync_covers_target'
  );
  expect(bad(withInf({ syncs: [null] })), 'infisical_sync_covers_target');
  assert.deepEqual(
    bad(
      withInf({
        syncs: [
          { environment: 'staging', path: '/workloads/notifications' },
          { environment: 'production', path: '/ci' },
          { environment: 'production', path: '/shared' },
        ],
      })
    ),
    []
  );
  expect(
    bad(
      withInf({ imports: [{ environment: 'production', importPath: '/workloads/notifications' }] })
    ),
    'infisical_import_covers_target'
  );
  expect(
    bad(withInf({ approvalPolicies: [{ environment: 'production', path: '/workloads/**' }] })),
    'infisical_approval_policy_covers_target'
  );
  for (const [principal, environment, paths] of [
    ['workload-reader', 'production', ['/workloads/**']],
    ['glob-reader', 'production', ['/*']],
    ['multi-env', ['production'], ['/workloads/notifications']],
    ['glob-env', 'prod*', ['/workloads/**']],
    ['unconditioned', 'production', []],
  ]) {
    const readers = [...meta.infisical.readers, { principal, environment, paths }];
    const v = evaluatePreflight({ ...input, meta: { ...meta, ...withInf({ readers }) } });
    assert.deepEqual(v.failures, ['infisical_reader_not_allowed'], principal);
    assert.ok(!JSON.stringify(v).includes(principal), `verdict never names ${principal}`);
  }
  // A reader of /shared only does not reach the copy target.
  assert.deepEqual(
    bad(
      withInf({
        readers: [
          ...meta.infisical.readers,
          { principal: 'web-reader', environment: 'production', paths: ['/shared/**'] },
        ],
      })
    ),
    []
  );
  expect(bad(withInf({ readers: [null] })), 'infisical_reader_not_allowed');
  expect(bad(withInf({ syncs: undefined })), 'infisical_syncs_unread');
  expect(bad({}, { allowedReaders: [] }), 'allowed_readers_unset');
  expect(bad({}, { allowedReaders: [''] }), 'allowed_readers_unset');
  const withAuth = p => ({ writer: { ...meta.writer, auth: { ...meta.writer.auth, ...p } } });
  const withPermission = extra => ({
    writer: { ...meta.writer, permissions: [...meta.writer.permissions, extra] },
  });
  // M108: a writer that could also create a 1Password-sourced target is refused.
  for (const [secretPath, secretName] of [
    ['/workloads/notifications', 'NOTIFICATIONS_APNS_PRIVATE_KEY'],
    ['/shared', 'NEXTAUTH_SECRET'],
    ['/shared', 'INTERNAL_API_SECRET'],
  ]) {
    expect(
      bad(withPermission({ action: 'create', environment: 'production', secretPath, secretName })),
      'writer_permissions_not_exact'
    );
  }
  expect(
    bad(
      withPermission({
        action: 'read',
        environment: 'production',
        secretPath: BATCH.rows[0].secretPath,
        secretName: BATCH.rows[0].secretKey,
      })
    ),
    'writer_permissions_not_exact'
  );
  expect(bad({ writer: { ...meta.writer, permissions: [] } }), 'writer_permissions_not_exact');
  for (const p of [
    { accessTokenTTL: 600 },
    { accessTokenMaxTTL: 900 },
    { accessTokenNumUsesLimit: 1 },
    { accessTokenNumUsesLimit: 3 },
    { accessTokenNumUsesLimit: 5 },
    { clientSecretNumUsesLimit: 2 },
    { clientSecretExpiresAt: iso(Date.parse(PINS.M65_NOT_AFTER) - 60_000) },
    { clientSecretExpiresAt: iso(Date.parse(PINS.M65_NOT_AFTER) + 20 * 60_000) },
  ]) {
    expect(bad(withAuth(p)), 'writer_auth_not_bounded');
  }
  for (const glob of [
    '/*',
    '/w*',
    '/workloads/*',
    '/{workloads,ci}',
    '/work?oads',
    '/workloads/',
    '',
    null,
  ]) {
    assert.equal(pathCovers(glob, target), true, `fails closed on ${JSON.stringify(glob)}`);
  }
  assert.equal(pathCovers('/workloads/other', '/workloads/notifications/X'), false);
});

test('preflight judges the raw copier settings by their safety fields, not by equality', () => {
  const { meta, input } = preflightFixture();
  const settings = copierSettingsResult();
  const failures = s =>
    evaluatePreflight({ ...input, meta: { ...meta, copier: { ...meta.copier, settings: s } } })
      .failures;
  const obs = p => ({ ...settings, observability: { ...settings.observability, ...p } });
  const logs = p => obs({ logs: { ...settings.observability.logs, ...p } });

  // Documented provider defaults and absences pass.
  const noTail = { ...settings };
  delete noTail.tail_consumers;
  for (const ok of [
    settings,
    noTail,
    { ...settings, tail_consumers: [] },
    { ...settings, placement: {} },
    { ...settings, cache_options: { enabled: false, cross_version_cache: true } },
    obs({ traces: undefined }),
    obs({ head_sampling_rate: undefined, redact_query_string: true, issues: { enabled: true } }),
    logs({ persist: undefined, destinations: undefined, head_sampling_rate: undefined }),
    {
      ...settings,
      exports: {
        default: { type: 'worker' },
        M65Gate: { type: 'durable-object', storage: 'sqlite', state: 'created' },
      },
    },
  ]) {
    assert.deepEqual(failures(ok), [], JSON.stringify(ok));
  }

  // Every dangerous or unknown setting refuses before arming.
  for (const [s, code] of [
    [undefined, 'copier_settings_unread'],
    [{ ...settings, compatibility_date: undefined }, 'copier_setting_compatibility_date'],
    [{ ...settings, compatibility_date: '2026-01-01' }, 'copier_setting_compatibility_date'],
    [{ ...settings, compatibility_flags: ['nodejs_compat'] }, 'copier_setting_compatibility_flags'],
    [{ ...settings, logpush: true }, 'copier_setting_logpush'],
    [{ ...settings, tail_consumers: [{ service: 'tail' }] }, 'copier_setting_tail_consumers'],
    [{ ...settings, placement: { mode: 'smart' } }, 'copier_setting_placement'],
    [{ ...settings, placement: { region: 'aws:eu-west-1' } }, 'copier_setting_placement'],
    [{ ...settings, cache_options: { enabled: true } }, 'copier_setting_cache_options'],
    [
      { ...settings, exports: { default: { type: 'worker', cache: { enabled: true } } } },
      'copier_setting_exports',
    ],
    [
      { ...settings, exports: { Other: { type: 'durable-object', storage: 'sqlite' } } },
      'copier_setting_exports',
    ],
    [
      { ...settings, exports: { M65Gate: { type: 'durable-object', container: 'c' } } },
      'copier_setting_exports',
    ],
    [{ ...settings, brand_new_ingress: true }, 'copier_setting_unknown'],
    [{ ...settings, observability: undefined }, 'copier_setting_observability'],
    [obs({ enabled: false }), 'copier_setting_observability'],
    [obs({ head_sampling_rate: 0.5 }), 'copier_setting_observability'],
    [obs({ exporters: [] }), 'copier_setting_observability'],
    [obs({ logs: undefined }), 'copier_setting_observability'],
    [logs({ enabled: false }), 'copier_setting_observability'],
    [logs({ invocation_logs: true }), 'copier_setting_observability'],
    [logs({ head_sampling_rate: 0.1 }), 'copier_setting_observability'],
    [logs({ destinations: ['external'] }), 'copier_setting_observability'],
    [logs({ persist: false }), 'copier_setting_observability'],
    [logs({ sink: 'x' }), 'copier_setting_observability'],
    [obs({ traces: { enabled: true } }), 'copier_setting_observability'],
    [obs({ traces: {} }), 'copier_setting_observability'],
    [
      obs({ traces: { enabled: false, destinations: ['external'] } }),
      'copier_setting_observability',
    ],
    [obs({ agents: { enabled: true } }), 'copier_setting_observability'],
  ]) {
    expect(failures(s), code);
  }
});

test('preflight fails closed on malformed input and never names a value or principal', () => {
  const { meta, input } = preflightFixture();
  for (const v of [
    evaluatePreflight(null),
    evaluatePreflight({}),
    evaluatePreflight({ ...input, meta: 5, pins: null }),
    evaluatePreflight({ ...input, meta: { ...meta, store: { id: 'x', secrets: [null] } } }),
  ]) {
    assert.equal(v.ok, false);
    assert.deepEqual(Object.keys(v).sort(), ['failures', 'gate', 'ok', 'pins']);
  }
  const throwing = evaluatePreflight({
    ...input,
    meta: {
      get source() {
        throw new Error('synthetic');
      },
    },
  });
  assert.deepEqual(throwing, {
    gate: 'preflight',
    ok: false,
    failures: ['preflight_input_malformed'],
    pins: { runId: null, versionId: null, storeIds: {}, sourceDeployments: [] },
  });
  const ok = evaluatePreflight(input);
  const text = JSON.stringify(ok);
  for (const s of [CLIENT_ID, 'sts-production', PINS.M65_NOT_BEFORE]) {
    assert.ok(!text.includes(s), `no ${s} in the verdict`);
  }
});

test('bindArmedPreflight moves only a verified preflight to the observed armed version', () => {
  const { input, armedObserved, copierBindings } = preflightFixture();
  const pre = evaluatePreflight(input);
  assert.deepEqual(bindArmedPreflight(pre, ARMED_VERSION, armedObserved), {
    gate: 'preflight-armed',
    ok: true,
    failures: [],
    pins: { ...pre.pins, unarmedVersionId: VERSION_ID, versionId: ARMED_VERSION },
  });
  const codes = (...args) => bindArmedPreflight(...args).failures;

  // Only the exact passed verdict from evaluatePreflight, unchanged.
  expect(codes(structuredClone(pre), ARMED_VERSION, armedObserved), 'preflight_not_verified');
  expect(codes({ ...pre }, ARMED_VERSION, armedObserved), 'preflight_not_verified');
  const late = evaluatePreflight({ ...input, nowMs: Date.parse(PINS.M65_NOT_BEFORE) });
  expect(codes(late, ARMED_VERSION, armedObserved), 'preflight_not_verified');
  const mutated = evaluatePreflight(input);
  mutated.pins.runId = 'm65-other-run-0001';
  expect(codes(mutated, ARMED_VERSION, armedObserved), 'preflight_not_verified');
  const flipped = evaluatePreflight(input);
  flipped.failures.push('x');
  expect(codes(flipped, ARMED_VERSION, armedObserved), 'preflight_not_verified');

  // A new, distinct, valid armed version.
  const at = (id, bindings = armedObserved.version.bindings) => ({
    deployments: [{ version_id: id, percentage: 100 }],
    version: { id, bindings },
  });
  expect(codes(pre, VERSION_ID, at(VERSION_ID)), 'armed_version_invalid');
  expect(codes(pre, 'not-a-uuid', armedObserved), 'armed_version_invalid');
  expect(codes(pre, undefined, armedObserved), 'armed_version_invalid');

  // The caller's observed 100% serving readback of that version.
  expect(codes(pre, ARMED_VERSION, undefined), 'armed_version_not_serving');
  expect(codes(pre, ARMED_VERSION, at(OTHER_VERSION)), 'armed_version_not_serving');
  expect(
    codes(pre, ARMED_VERSION, {
      ...armedObserved,
      deployments: [
        { version_id: ARMED_VERSION, percentage: 50 },
        { version_id: VERSION_ID, percentage: 50 },
      ],
    }),
    'armed_version_not_serving'
  );
  expect(
    codes(pre, ARMED_VERSION, {
      ...armedObserved,
      version: { id: VERSION_ID, bindings: copierBindings },
    }),
    'armed_version_not_serving'
  );

  // The binding delta is exactly the writer secret.
  for (const bindings of [
    copierBindings,
    [
      ...armedObserved.version.bindings,
      { name: 'NOTIF', type: 'service', service: 'notifications' },
    ],
    armedObserved.version.bindings.map(b =>
      b.name === 'M65_NOT_AFTER' ? { ...b, text: iso(T0) } : b
    ),
    armedObserved.version.bindings.map(b =>
      b.type === 'secret_text' ? { ...b, type: 'plain_text' } : b
    ),
  ]) {
    const v = bindArmedPreflight(pre, ARMED_VERSION, at(ARMED_VERSION, bindings));
    assert.deepEqual(v.failures, ['armed_bindings_not_writer_only']);
    assert.equal(v.pins.versionId, null);
  }
  assert.equal(bindArmedPreflight(pre, ARMED_VERSION, armedObserved).ok, true, 'pre unchanged');
});

test('post-run and cleanup gates', () => {
  const { meta, input, storeSecrets, armedObserved } = preflightFixture();
  const unarmed = evaluatePreflight(input);
  const pre = bindArmedPreflight(unarmed, ARMED_VERSION, armedObserved);
  const complete = {
    ...newReceipt(BATCH.id),
    runId: RUN_ID,
    versionId: ARMED_VERSION,
    outcome: 'complete',
    armed: true,
    window: 'open',
    ready: { pins: true, envClosed: true, bindings: true, gate: true, cron: true },
    gate: 'consumed_now',
    logins: 1,
    reads: 1,
    posts: 1,
    rows: BATCH.rows.map(r => ({
      binding: r.binding,
      sourceSecretName: r.secretName,
      secretPath: r.secretPath,
      secretKey: r.secretKey,
      read: true,
      storable: true,
      referenceFree: true,
      bytesParity: true,
      serializationParity: true,
      created: 'yes',
      echo: 'equal',
    })),
    revoked: true,
    denialProved: true,
  };
  const post = {
    ...meta,
    infisical: { names: { '/workloads/notifications': [BATCH.rows[0].secretKey] } },
  };
  assert.deepEqual(evaluatePostRun({ pre, meta: post, receipt: JSON.stringify(complete) }), {
    gate: 'postrun',
    ok: true,
    failures: [],
  });
  expect(
    evaluatePostRun({
      pre,
      meta: post,
      receipt: JSON.stringify({ ...complete, outcome: 'copied_revoke_unproven', revoked: false }),
    }).failures,
    'receipt_not_complete'
  );
  expect(
    evaluatePostRun({
      pre,
      meta: post,
      receipt: JSON.stringify({ ...complete, versionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    }).failures,
    'receipt_not_complete'
  );
  expect(
    evaluatePostRun({
      pre,
      meta: post,
      receipt: JSON.stringify({ ...complete, runId: 'm65-other-run-0001' }),
    }).failures,
    'receipt_not_complete'
  );
  const replaced = {
    ...post,
    store: {
      ...meta.store,
      secrets: storeSecrets.map(s =>
        s.name === 'EXPO_ACCESS_TOKEN' ? { ...s, id: 'f'.repeat(32) } : s
      ),
    },
  };
  expect(
    evaluatePostRun({ pre, meta: replaced, receipt: JSON.stringify(complete) }).failures,
    'store_secret_replaced_EXPO_ACCESS_TOKEN'
  );
  expect(
    evaluatePostRun({ pre, meta: post, receipt: JSON.stringify({ ...complete, posts: 0 }) })
      .failures,
    'receipt_not_complete'
  );
  // The unarmed verdict or a failed bind never authorizes the armed run.
  for (const p of [unarmed, bindArmedPreflight(unarmed, ARMED_VERSION, undefined)]) {
    expect(
      evaluatePostRun({ pre: p, meta: post, receipt: JSON.stringify(complete) }).failures,
      'receipt_not_complete'
    );
  }
  // The source serving version must stay the pinned one, read back by its id.
  for (const source of [
    {
      deployments: [{ version_id: OTHER_VERSION, percentage: 100 }],
      version: { id: OTHER_VERSION, bindings: meta.source.version.bindings },
    },
    {
      deployments: [
        { version_id: SOURCE_VERSION, percentage: 50 },
        { version_id: OTHER_VERSION, percentage: 50 },
      ],
      version: null,
    },
    {
      ...meta.source,
      version: { id: SOURCE_VERSION, bindings: meta.source.version.bindings.slice(1, 3) },
    },
    { deployments: meta.source.deployments, bindings: meta.source.version.bindings },
  ]) {
    expect(
      evaluatePostRun({ pre, meta: { ...post, source }, receipt: JSON.stringify(complete) })
        .failures,
      'source_changed_during_run'
    );
  }

  // Split halves: the Cloudflare half ignores Infisical; the full gate needs both.
  const cloudOnly = { source: meta.source, store: meta.store };
  assert.deepEqual(
    evaluatePostRunCloudflare({ pre, meta: cloudOnly, receipt: JSON.stringify(complete) }),
    { gate: 'postrun-cloudflare', ok: true, failures: [] }
  );
  assert.deepEqual(evaluatePostRunInfisical({ meta: post }), {
    gate: 'postrun-infisical',
    ok: true,
    failures: [],
  });
  expect(
    evaluatePostRunInfisical({ meta: { infisical: { names: { '/shared': ['NEXTAUTH_SECRET'] } } } })
      .failures,
    `target_absent_${BATCH.rows[0].secretKey}`
  );
  expect(
    evaluatePostRun({ pre, meta: cloudOnly, receipt: JSON.stringify(complete) }).failures,
    `target_absent_${BATCH.rows[0].secretKey}`
  );

  const baseline = { identities: 5, roles: 9 };
  const clean = {
    copier: { scriptStatus: 404, gateNamespacePresent: false },
    infisical: {
      identityPresent: false,
      rolePresent: false,
      identities: 5,
      roles: 9,
      openApprovalRequestsByWriter: 0,
    },
    writerTokenStatus: 401,
    sourceUnchanged: true,
    existingDeploymentsUnchanged: true,
  };
  assert.deepEqual(evaluateCleanup({ meta: clean, baseline }), {
    gate: 'cleanup',
    ok: true,
    failures: [],
  });
  expect(
    evaluateCleanup({ meta: { ...clean, writerTokenStatus: 200 }, baseline }).failures,
    'writer_token_not_denied'
  );
  expect(
    evaluateCleanup({
      meta: { ...clean, copier: { scriptStatus: 404, gateNamespacePresent: true } },
      baseline,
    }).failures,
    'copier_gate_namespace_present'
  );
  expect(
    evaluateCleanup({
      meta: { ...clean, infisical: { ...clean.infisical, openApprovalRequestsByWriter: 1 } },
      baseline,
    }).failures,
    'infisical_open_approval_requests'
  );
  expect(
    evaluateCleanup({ meta: { ...clean, sourceUnchanged: false }, baseline }).failures,
    'source_binding_changed'
  );
  expect(
    evaluateCleanup({ meta: { ...clean, existingDeploymentsUnchanged: false }, baseline }).failures,
    'existing_deployments_changed'
  );
  expect(evaluateCleanup({ meta: clean, baseline: {} }).failures, 'infisical_counts_differ');
  const cloudClean = {
    copier: clean.copier,
    sourceUnchanged: true,
    existingDeploymentsUnchanged: true,
  };
  assert.deepEqual(evaluateCleanupCloudflare({ meta: cloudClean }), {
    gate: 'cleanup-cloudflare',
    ok: true,
    failures: [],
  });
  assert.deepEqual(evaluateCleanupInfisical({ meta: clean, baseline }), {
    gate: 'cleanup-infisical',
    ok: true,
    failures: [],
  });
  expect(evaluateCleanup({ meta: cloudClean, baseline }).failures, 'infisical_actor_present');
});

test('checks CLI: verdict JSON on stdout, exit 0/1/2', () => {
  const cli = (args, input) =>
    spawnSync(process.execPath, [join(HERE, 'checks.mjs'), ...args], { input, encoding: 'utf8' });
  // `source` covers every checked-in Worker; one whose batch PR is not on main yet refuses by name.
  const src = cli(['source'], '');
  const verdict = JSON.parse(src.stdout);
  assert.deepEqual(
    verdict.workers.map(w => [w.worker, w.failures]),
    TABLE.workers.map(w => [
      w,
      existsSync(join(REPO_ROOT, WORKER_SOURCES[w].reader)) ? [] : [`source_not_on_main: ${w}`],
    ])
  );
  assert.equal(src.status, verdict.failures.length === 0 ? 0 : 1, src.stdout);
  const worker = TABLE.workers[0];
  const id = TABLE.batches[worker].id;
  const good = JSON.stringify({
    ...newReceipt(id),
    outcome: 'refused',
    reason: 'not_ready_cron',
  });
  assert.equal(cli(['receipt', worker], `${good}\n`).status, 0);
  const bad = cli(['receipt', worker], JSON.stringify({ ...newReceipt(id), extra: true }));
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout), {
    gate: 'receipt',
    ok: false,
    failures: ['receipt_keys'],
    receipt: null,
  });
  assert.equal(cli(['receipt'], `${good}\n`).status, 2, 'a per-Worker gate needs the Worker');
  assert.equal(cli(['receipt', 'other-worker'], `${good}\n`).status, 2, 'only table Workers');
  assert.equal(
    cli(['receipt', 'notifications'], `${good}\n`).status,
    2,
    'the Expo run is not in this table'
  );
  assert.equal(cli(['preflight', worker], '{').status, 2);
  assert.equal(cli(['nope'], '').status, 2);
});
