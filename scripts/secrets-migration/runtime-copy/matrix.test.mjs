// The row table and the per-Worker matrix (M122): a multi-Worker, multi-row synthetic table through
// `validateTable` and `batchesOf`, every table refusal, one copier run per Worker batch with the
// writer token's rows + 1 uses, and the preflight's per-Worker writer scope. Synthetic Workers only;
// the checked-in table is untouched (`checkSource` and the renderer refuse anything not in it).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_STORE_IDS,
  CRON,
  batchId,
  batchesOf,
  copierName,
  newReceipt,
  runTick,
  validateBatch,
  validateTable,
} from './src/core.mjs';
import { BATCHES, ROWS, TABLE_PROBLEMS, WORKERS } from './src/table.mjs';
import { checkSource, evaluatePreflight, moduleHashes, validatedNameTable } from './checks.mjs';
import { buildConfig, pinProblems } from './render-config.mjs';
import {
  CLIENT_ID,
  RUN_ID,
  VERSION_ID,
  copierSettingsResult,
  fakeGateNamespace,
  fakeInfisical,
  iso,
  leaks,
  makeEnv,
  syntheticValues,
  unarmedCopierBindings,
} from './fakes.mjs';

const STORE = ALLOWED_STORE_IDS[0];
const row = (worker, binding, secretName, target) => ({
  worker,
  binding,
  storeId: STORE,
  secretName,
  target,
});
const TABLE = [
  row('alpha-worker', 'ALPHA_ONE', 'ALPHA_ONE_PROD', '/workloads/alpha/ALPHA_ONE'),
  row('beta-worker', 'BETA_TOKEN', 'BETA_TOKEN_PROD', '/workloads/beta/BETA_TOKEN'),
  row('alpha-worker', 'ALPHA_TWO', 'ALPHA_TWO_PROD', '/workloads/alpha/ALPHA_TWO'),
  row('alpha-worker', 'ALPHA_THREE', 'ALPHA_THREE_STORE', '/workloads/alpha/ALPHA_THREE'),
];
const T0 = Date.parse('2026-11-27T16:00:00Z');

test('the checked-in table is valid: one Notifications row until the cutover table arrives', () => {
  assert.deepEqual(TABLE_PROBLEMS, []);
  assert.deepEqual(WORKERS, ['notifications']);
  assert.deepEqual(
    ROWS.map(r => [r.worker, r.binding, r.secretName, r.target]),
    [
      [
        'notifications',
        'EXPO_ACCESS_TOKEN',
        'EXPO_ACCESS_TOKEN',
        '/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN',
      ],
    ]
  );
  assert.ok(
    Object.isFrozen(ROWS) && Object.isFrozen(BATCHES) && Object.isFrozen(BATCHES.notifications.rows)
  );
});

test('a multi-Worker table: one batch per Worker in table order, rows grouped, folders split', () => {
  assert.deepEqual(validateTable(TABLE), []);
  const batches = batchesOf(TABLE);
  assert.deepEqual(Object.keys(batches), ['alpha-worker', 'beta-worker']);
  const alpha = batches['alpha-worker'];
  assert.deepEqual(
    [alpha.id, alpha.sourceScript, alpha.environment, copierName('alpha-worker')],
    [batchId('alpha-worker'), 'alpha-worker', 'production', 'm65-alpha-worker-copy']
  );
  assert.deepEqual(
    alpha.rows.map(r => [r.binding, r.secretName, r.secretPath, r.secretKey]),
    [
      ['ALPHA_ONE', 'ALPHA_ONE_PROD', '/workloads/alpha', 'ALPHA_ONE'],
      ['ALPHA_TWO', 'ALPHA_TWO_PROD', '/workloads/alpha', 'ALPHA_TWO'],
      ['ALPHA_THREE', 'ALPHA_THREE_STORE', '/workloads/alpha', 'ALPHA_THREE'],
    ]
  );
  assert.deepEqual(
    batches['beta-worker'].rows.map(r => `${r.secretPath}/${r.secretKey}`),
    ['/workloads/beta/BETA_TOKEN']
  );
  for (const b of Object.values(batches)) assert.equal(validateBatch(b), null);
});

test('table refusals: duplicate target, foreign store, /shared, folders, shape, size', () => {
  const swap = (i, patch) => TABLE.map((r, j) => (j === i ? { ...r, ...patch } : r));
  const cases = [
    // One row per target: the same target twice is refused, across Workers too.
    [swap(2, { target: '/workloads/alpha/ALPHA_ONE' }), 'row_2_target_duplicate'],
    [
      [...TABLE, row('gamma-worker', 'G', 'G_PROD', '/workloads/beta/BETA_TOKEN')],
      'row_4_target_duplicate',
    ],
    // Only reviewed store ids.
    [swap(0, { storeId: '0123456789abcdef0123456789abcdef' }), 'row_0_store_not_reviewed'],
    // Never /shared, never outside a workload folder.
    [swap(1, { target: '/shared/BETA_TOKEN' }), 'row_1_target_shared'],
    [swap(1, { target: '/shared' }), 'row_1_target_shared'],
    [swap(1, { target: '/ci/BETA_TOKEN' }), 'row_1_target_invalid'],
    [swap(1, { target: '/workloads/beta/beta_token' }), 'row_1_target_invalid'],
    // One folder per Worker, and no folder shared by two Workers.
    [swap(2, { target: '/workloads/other/ALPHA_TWO' }), 'worker_alpha-worker_folders'],
    [swap(1, { target: '/workloads/alpha/BETA_TOKEN' }), 'table_folder_shared'],
    // Rows are exact and well-formed.
    [swap(0, { extra: 1 }), 'row_0_shape'],
    [swap(0, { worker: 'Alpha' }), 'row_0_worker_invalid'],
    [swap(0, { binding: 'M65_GATE' }), 'row_0_binding_invalid'],
    [swap(2, { binding: 'ALPHA_ONE' }), 'row_2_binding_duplicate'],
    // Batch closure per Worker: a target that is a store name, an environment suffix.
    [
      swap(0, { target: '/workloads/alpha/ALPHA_TWO_PROD' }),
      'worker_alpha-worker_row_target_is_store_name',
    ],
    [
      swap(0, { target: '/workloads/alpha/ALPHA_ONE_STAGING' }),
      'worker_alpha-worker_row_target_environment_suffix',
    ],
  ];
  for (const [table, code] of cases) {
    assert.ok(
      validateTable(table).includes(code),
      `${code} in ${JSON.stringify(validateTable(table))}`
    );
  }
  assert.deepEqual(validateTable([]), ['table_empty']);
  assert.deepEqual(validateTable(null), ['table_empty']);
  const many = Array.from({ length: 17 }, (_, i) =>
    row('alpha-worker', `B${i}`, `S${i}`, `/workloads/alpha/K${i}`)
  );
  assert.deepEqual(validateTable(many), ['worker_alpha-worker_batch_row_count']);
});

test('only Workers of the checked-in table render or pass the source check', () => {
  const alpha = batchesOf(TABLE)['alpha-worker'];
  const pins = {
    M65_RUN_ID: RUN_ID,
    M65_BATCH: 'alpha-worker',
    M65_NOT_BEFORE: iso(T0 + 20 * 60_000),
    M65_NOT_AFTER: iso(T0 + 45 * 60_000),
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
  };
  assert.deepEqual(pinProblems(pins, T0), ['batch_not_in_table']);
  assert.equal(buildConfig(pins), null);
  const f = checkSource('{}', '', '', alpha);
  for (const code of ['batch_not_in_table', 'worker_source_unreviewed'])
    assert.ok(f.includes(code), code);
  assert.deepEqual(validatedNameTable(alpha).ok, false);
  // The Notifications batch is the table's own: it renders with exactly its bindings.
  const cfg = buildConfig({ ...pins, M65_BATCH: 'notifications' });
  assert.equal(cfg.name, copierName('notifications'));
  assert.deepEqual(
    cfg.secrets_store_secrets.map(s => s.binding),
    BATCHES.notifications.rows.map(r => r.binding)
  );
});

test('one Worker batch with several rows: one read and one create per row, rows + 1 token uses', async () => {
  const batch = batchesOf(TABLE)['alpha-worker'];
  const values = syntheticValues(batch);
  const readLog = [];
  const run = async fakeOpts => {
    const fake = fakeInfisical({ batch, ...fakeOpts });
    const receipt = await runTick({
      env: makeEnv({
        values,
        gate: fakeGateNamespace(),
        notBefore: iso(T0 - 60_000),
        notAfter: iso(T0 + 20 * 60_000),
        readLog,
        batch,
      }),
      cron: CRON,
      scheduledTime: T0,
      now: () => T0,
      fetchImpl: fake.fetch,
      batch,
    });
    assert.deepEqual(leaks(JSON.stringify(receipt), values, fake.issued), []);
    return { fake, receipt };
  };
  const { fake, receipt } = await run();
  assert.deepEqual(
    [
      receipt.outcome,
      receipt.logins,
      receipt.reads,
      receipt.posts,
      receipt.revoked,
      receipt.denialProved,
    ],
    ['complete', 1, 3, 3, true, true]
  );
  assert.deepEqual(readLog, ['ALPHA_ONE', 'ALPHA_TWO', 'ALPHA_THREE']);
  assert.deepEqual(
    [...fake.store.keys()],
    ['/workloads/alpha/ALPHA_ONE', '/workloads/alpha/ALPHA_TWO', '/workloads/alpha/ALPHA_THREE']
  );
  for (const r of batch.rows) {
    assert.equal(fake.store.get(`${r.secretPath}/${r.secretKey}`), values[r.binding]);
  }
  assert.ok(receipt.rows.every(r => r.bytesParity && r.serializationParity && r.echo === 'equal'));
  // Unrevoked (revoke refused), the token spends all rows + 1 uses: three creates and the probe.
  const unrevoked = await run({ revokeStatus: 500 });
  const t = unrevoked.fake.tokens.get(unrevoked.fake.issued[0]);
  assert.deepEqual([t.uses, t.limit], [4, 4]);
  assert.equal(unrevoked.receipt.outcome, 'copied_revoke_unproven');
});

test('per-Worker writer scope: exactly that Worker targets, Create-only, rows + 1 uses', () => {
  const batches = batchesOf(TABLE);
  const batch = batches['alpha-worker'];
  const names = [
    ...batch.rows.map(r => ({ ...r })),
    {
      binding: 'ALPHA_SHARED',
      storeId: STORE,
      secretName: 'ALPHA_SHARED_PROD',
      secretPath: '/shared',
      secretKey: 'ALPHA_SHARED',
    },
  ];
  const sources = { 'alpha-worker': { names } };
  const pins = {
    M65_RUN_ID: RUN_ID,
    M65_BATCH: 'alpha-worker',
    M65_NOT_BEFORE: iso(T0 + 20 * 60_000),
    M65_NOT_AFTER: iso(T0 + 45 * 60_000),
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
  };
  const SOURCE_VERSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const perm = r => ({
    action: 'create',
    environment: 'production',
    secretPath: r.secretPath,
    secretName: r.secretKey,
  });
  const meta = {
    source: {
      deployments: [{ version_id: SOURCE_VERSION, percentage: 100 }],
      version: {
        id: SOURCE_VERSION,
        bindings: names.map(r => ({
          name: r.binding,
          type: 'secrets_store_secret',
          store_id: r.storeId,
          secret_name: r.secretName,
        })),
      },
    },
    store: {
      id: STORE,
      secrets: names.map((r, i) => ({
        id: String(i).repeat(32),
        name: r.secretName,
        status: 'active',
        scopes: ['workers'],
      })),
    },
    copier: {
      doNamespaces: [{ id: 'ns-1', script: copierName('alpha-worker'), class: 'M65Gate' }],
      deployments: [{ version_id: VERSION_ID, percentage: 100 }],
      version: { id: VERSION_ID, bindings: unarmedCopierBindings(pins, 'ns-1', batch) },
      settings: copierSettingsResult(),
      subdomain: { enabled: false, previews_enabled: false },
      routes: [],
      domains: [],
      schedules: [CRON],
      queueConsumers: [],
      workflows: [],
      modules: moduleHashes(),
    },
    infisical: {
      names: { '/workloads/alpha': [] },
      syncs: [],
      imports: [],
      approvalPolicies: [],
      readers: [],
    },
    writer: {
      clientId: CLIENT_ID,
      permissions: batch.rows.map(perm),
      auth: {
        accessTokenTTL: 300,
        accessTokenMaxTTL: 300,
        accessTokenNumUsesLimit: batch.rows.length + 1,
        clientSecretNumUsesLimit: 1,
        clientSecretExpiresAt: iso(Date.parse(pins.M65_NOT_AFTER) + 5 * 60_000),
      },
    },
  };
  const input = {
    meta,
    pins,
    deployedVersionId: VERSION_ID,
    allowedReaders: ['sts-production'],
    readinessReceipt: {
      ...newReceipt(batch.id),
      runId: RUN_ID,
      versionId: VERSION_ID,
      outcome: 'unarmed',
      reason: 'writer_not_installed',
      window: 'before',
      ready: { pins: true, envClosed: true, bindings: true, gate: true, cron: true },
    },
    nowMs: T0,
  };
  const failures = (patch = {}) =>
    evaluatePreflight({ ...input, meta: { ...meta, ...patch } }, batch, sources).failures;
  const withWriter = w => ({ writer: { ...meta.writer, ...w } });
  const withAuth = a => withWriter({ auth: { ...meta.writer.auth, ...a } });
  assert.deepEqual(failures(), [], 'three targets, three create permissions, four uses');

  const beta = batches['beta-worker'].rows[0];
  for (const permissions of [
    [...batch.rows.map(perm), perm(beta)], // another Worker's target
    batch.rows.slice(1).map(perm), // one target missing
    [...batch.rows.map(perm), { ...perm(batch.rows[0]), action: 'edit' }], // more than Create
    [
      ...batch.rows.map(perm),
      perm({
        secretPath: '/workloads/notifications',
        secretKey: 'NOTIFICATIONS_EXPO_ACCESS_TOKEN',
      }),
    ],
  ]) {
    assert.ok(failures(withWriter({ permissions })).includes('writer_permissions_not_exact'));
  }
  for (const uses of [1, 3, 5]) {
    assert.ok(
      failures(withAuth({ accessTokenNumUsesLimit: uses })).includes('writer_auth_not_bounded'),
      `${uses}`
    );
  }
  // The copier binds exactly this Worker's rows: another Worker's binding refuses.
  const foreign = {
    name: beta.binding,
    type: 'secrets_store_secret',
    store_id: beta.storeId,
    secret_name: beta.secretName,
  };
  assert.ok(
    failures({
      copier: {
        ...meta.copier,
        version: { id: VERSION_ID, bindings: [...meta.copier.version.bindings, foreign] },
      },
    }).includes('copier_bindings_not_closed')
  );
  // The batch pin must name this Worker.
  assert.ok(
    evaluatePreflight(
      { ...input, pins: { ...pins, M65_BATCH: 'beta-worker' } },
      batch,
      sources
    ).failures.includes('pins_batch_differs')
  );
  // A Worker without reviewed sources refuses.
  assert.ok(evaluatePreflight(input, batch, {}).failures.includes('worker_source_unreviewed'));
});
