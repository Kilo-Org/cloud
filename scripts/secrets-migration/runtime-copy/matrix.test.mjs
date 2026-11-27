// The row table and the per-Worker matrix (M122): the checked-in table (the M122/M122b handoff's
// workload rows), a multi-Worker, multi-row synthetic table through `validateTable` and
// `batchesOf`, every table refusal, one copier run per Worker batch with the writer token's rows +
// 1 uses, the preflight's per-Worker writer scope, the reviewed source entry of every table Worker,
// and the `source_not_on_main` refusal. The table-bound paths run against the fixture table.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  ACCOUNT_ID,
  ALLOWED_STORE_IDS,
  CRON,
  SHARED_TARGETS,
  batchId,
  batchesOf,
  copierName,
  newReceipt,
  runTick,
  tableOf,
  validateBatch,
  validateTable,
} from './src/core.mjs';
import { TABLE } from './src/table.mjs';
import {
  SHARED_KEYS,
  WORKER_SOURCES,
  checkSource,
  evaluatePreflight,
  moduleHashes,
  readerKeysOf,
  sharedTargetProblems,
  validatedNameTable,
} from './checks.mjs';
import { REPO_ROOT, SRC_DIR, buildConfig, pinProblems } from './render-config.mjs';
import { planMatrix } from '../runtime-copy-run.mjs';
import {
  CLIENT_ID,
  FIXTURE,
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
const SYNTHETIC = [
  row('alpha-worker', 'ALPHA_ONE', 'ALPHA_ONE_PROD', '/workloads/alpha/ALPHA_ONE'),
  row('beta-worker', 'BETA_TOKEN', 'BETA_TOKEN_PROD', '/workloads/beta/BETA_TOKEN'),
  row('alpha-worker', 'ALPHA_TWO', 'ALPHA_TWO_PROD', '/workloads/alpha/ALPHA_TWO'),
  row('alpha-worker', 'ALPHA_THREE', 'ALPHA_THREE_STORE', '/workloads/alpha/ALPHA_THREE'),
];
const T0 = Date.parse('2026-11-27T16:00:00Z');
const dirs = [];
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'm65-matrix-'));
  dirs.push(d);
  return d;
};

test('the checked-in table: 12 workload creates and 2 shared creates (M142), no Expo row', () => {
  assert.deepEqual(TABLE.problems, []);
  assert.deepEqual(TABLE.workers, [
    'session-sync',
    'session-ingest',
    'kilo-ai-attribution',
    'auto-routing',
    'cloudflare-scim-sync',
    'kilo-chat',
    'git-token-service',
    'kilo-ops',
  ]);
  assert.deepEqual(
    TABLE.rows.map(r => [r.worker, r.binding, r.secretName, r.target]),
    [
      [
        'session-sync',
        'SESSION_SYNC_SECRET',
        'SESSION_SYNC_SECRET_PROD',
        '/workloads/session-sync/SESSION_SYNC_SECRET',
      ],
      [
        'session-ingest',
        'SESSION_SHARE_JWT_SECRET_PROD',
        'SESSION_SHARE_JWT_SECRET_PROD',
        '/workloads/session-ingest/SESSION_SHARE_JWT_SECRET',
      ],
      [
        'kilo-ai-attribution',
        'ADMIN_SECRET',
        'AI_ATTRIBUTION_ADMIN_SECRET_PROD',
        '/workloads/kilo-ai-attribution/ADMIN_SECRET',
      ],
      [
        'auto-routing',
        'AUTO_ROUTING_DECISION_SECRET',
        'AUTO_ROUTING_DECISION_SECRET_PROD',
        '/shared/AUTO_ROUTING_DECISION_SECRET',
      ],
      [
        'auto-routing',
        'O11Y_CF_AE_API_TOKEN',
        'O11Y_CF_AE_API_TOKEN',
        '/shared/O11Y_CF_AE_API_TOKEN',
      ],
      [
        'cloudflare-scim-sync',
        'WORKOS_API_KEY',
        'WORKOS_API_KEY',
        '/workloads/cloudflare-scim-sync/WORKOS_API_KEY',
      ],
      [
        'cloudflare-scim-sync',
        'WORKOS_CLIENT_ID',
        'WORKOS_CLIENT_ID',
        '/workloads/cloudflare-scim-sync/WORKOS_CLIENT_ID',
      ],
      [
        'kilo-chat',
        'GATEWAY_TOKEN_SECRET',
        'GATEWAY_TOKEN_SECRET',
        '/workloads/kilo-chat/GATEWAY_TOKEN_SECRET',
      ],
      [
        'kilo-chat',
        'R2_ACCESS_KEY_ID',
        'R2_ACCESS_KEY_ID_KILOCHAT_MEDIA',
        '/workloads/kilo-chat/R2_ACCESS_KEY_ID',
      ],
      [
        'kilo-chat',
        'R2_SECRET_ACCESS_KEY',
        'R2_SECRET_ACCESS_KEY_KILOCHAT_MEDIA',
        '/workloads/kilo-chat/R2_SECRET_ACCESS_KEY',
      ],
      [
        'git-token-service',
        'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
        'SCM_SESSION_CAPABILITY_ENCRYPTION_KEY_PROD',
        '/workloads/git-token-service/SCM_SESSION_CAPABILITY_ENCRYPTION_KEY',
      ],
      [
        'git-token-service',
        'BITBUCKET_CLIENT_ID',
        'BITBUCKET_CLIENT_ID_PROD',
        '/workloads/git-token-service/BITBUCKET_CLIENT_ID',
      ],
      [
        'git-token-service',
        'BITBUCKET_CLIENT_SECRET',
        'BITBUCKET_CLIENT_SECRET_PROD',
        '/workloads/git-token-service/BITBUCKET_CLIENT_SECRET',
      ],
      ['kilo-ops', 'GF_SECRET_KEY', 'GF_SECRET_KEY', '/workloads/kilo-ops/GF_SECRET_KEY'],
    ]
  );
  // One target per row; the only /shared targets are the exact SHARED_TARGETS; no workload target
  // is a shared lookup name (it would shadow /shared); no Notifications row.
  assert.equal(new Set(TABLE.rows.map(r => r.target)).size, TABLE.rows.length);
  const shared = TABLE.rows.filter(r => r.target.startsWith('/shared'));
  assert.deepEqual(
    shared.map(r => r.target),
    [...SHARED_TARGETS]
  );
  assert.equal(TABLE.rows.length - shared.length, 12);
  for (const r of TABLE.rows.filter(x => !shared.includes(x))) {
    assert.ok(!SHARED_KEYS.includes(r.target.slice(r.target.lastIndexOf('/') + 1)), r.target);
  }
  for (const r of TABLE.rows) assert.notEqual(r.worker, 'notifications');
  assert.ok(
    Object.isFrozen(TABLE) &&
      Object.isFrozen(TABLE.rows) &&
      Object.isFrozen(TABLE.batches) &&
      TABLE.workers.every(w => Object.isFrozen(TABLE.batches[w].rows))
  );
});

// Tracked-source texts written from a WORKER_SOURCES entry, in the shape checkSource reads.
function textsOf(worker, src) {
  const store = r => ({ binding: r.binding, store_id: r.storeId, secret_name: r.secretName });
  const reader = Object.fromEntries([
    ...src.names.map(r => [r.secretKey, r.binding]),
    ...src.plainSecrets.map(p => [p, p]),
  ]);
  return {
    wranglerText: JSON.stringify({
      name: worker,
      account_id: ACCOUNT_ID,
      vars: src.productionVars,
      secrets_store_secrets: [...src.names, ...src.legacyStoreBindings].map(store),
      env: { staging: { secrets_store_secrets: src.stagingStoreBindings } },
    }),
    policyText: [
      `workload: ${src.workload}`,
      'environments:',
      '  - production',
      'identity:',
      '  kind: worker-binding',
      'secrets:',
      ...readerKeysOf(src).map(k => `  - ${k}`),
      '',
    ].join('\n'),
    readerText: `const ${src.readerMap} = {\n${Object.entries(reader)
      .map(([k, b]) => `  ${k}: '${b}',\n`)
      .join('')}} as const;\n`,
  };
}
const sourceFailures = (worker, src, batch = TABLE.batches[worker]) => {
  const t = textsOf(worker, src);
  return checkSource(t.wranglerText, t.policyText, t.readerText, batch, src, TABLE);
};

test('every table Worker has a reviewed source entry consistent with its batch and the folder rules', () => {
  for (const worker of TABLE.workers) {
    const src = WORKER_SOURCES[worker];
    assert.ok(src, worker);
    assert.deepEqual(sourceFailures(worker, src), [], worker);
    // Every copy row is a names row in the Worker's own folder or an exact shared target; every
    // shared name is in /shared.
    for (const r of TABLE.batches[worker].rows) {
      const shared = SHARED_TARGETS.includes(`${r.secretPath}/${r.secretKey}`);
      assert.equal(r.secretPath, shared ? '/shared' : src.folder, r.secretKey);
    }
    for (const n of src.names) {
      assert.equal(n.secretPath === '/shared', SHARED_KEYS.includes(n.secretKey), n.secretKey);
    }
  }
});

test('a target may equal its own store name, never another row’s store name', () => {
  const scim = WORKER_SOURCES['cloudflare-scim-sync'];
  // WORKOS_API_KEY and WORKOS_CLIENT_ID read store entries named like their lookup names: accepted
  // by the source check and by the batch closure.
  assert.deepEqual(sourceFailures('cloudflare-scim-sync', scim), []);
  assert.equal(validateBatch(TABLE.batches['cloudflare-scim-sync']), null);
  // Another row's store entry named like a target: refused by the source check ...
  const crossed = {
    ...scim,
    names: scim.names.map(n =>
      n.binding === 'INTERNAL_API_SECRET' ? { ...n, secretName: 'WORKOS_CLIENT_ID' } : n
    ),
  };
  assert.ok(
    sourceFailures('cloudflare-scim-sync', crossed).includes(
      'target_is_store_name_WORKOS_CLIENT_ID'
    )
  );
  // ... and by the table and batch closure.
  const own = row('gamma-worker', 'GAMMA_KEY', 'GAMMA_KEY', '/workloads/gamma/GAMMA_KEY');
  assert.deepEqual(validateTable([own]), []);
  assert.ok(
    validateTable([
      own,
      row('gamma-worker', 'GAMMA_TWO', 'GAMMA_TWO_STORE', '/workloads/gamma/GAMMA_THIRD_STORE'),
      row('gamma-worker', 'GAMMA_THIRD', 'GAMMA_THIRD_STORE', '/workloads/gamma/GAMMA_THIRD'),
    ]).includes('worker_gamma-worker_row_target_is_store_name')
  );
});

test('source_not_on_main: a Worker whose reader is absent or whose policy grants nothing refuses by name', async () => {
  const notifications = WORKER_SOURCES.notifications;
  const batch = FIXTURE.batches.notifications;
  const all = [notifications.wrangler, notifications.reader, notifications.policy];
  const rootWith = (files, policyText) => {
    const root = scratch();
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      cpSync(join(REPO_ROOT, f), join(root, f));
    }
    if (policyText !== undefined) writeFileSync(join(root, notifications.policy), policyText);
    return root;
  };
  assert.equal(validatedNameTable(batch, rootWith(all), FIXTURE).ok, true);
  const refused = ['source_not_on_main: notifications'];
  // The reader module is absent (the batch PR's src/secrets.ts is not on main).
  const noReader = validatedNameTable(
    batch,
    rootWith(all.filter(f => f !== notifications.reader)),
    FIXTURE
  );
  assert.deepEqual([noReader.ok, noReader.failures, noReader.rows], [false, refused, []]);
  // The policy is still the empty one main ships before the batch PR.
  const emptyPolicy = validatedNameTable(
    batch,
    rootWith(
      all,
      'workload: notifications\nenvironments:\n  - production\nidentity:\n  kind: worker-binding\nsecrets: []\n'
    ),
    FIXTURE
  );
  assert.deepEqual([emptyPolicy.ok, emptyPolicy.failures], [false, refused]);

  // The plan refuses the whole checked-in table on a checkout without the batch files, naming
  // each Worker, and reads no environment.
  const sha = 'a'.repeat(40);
  const plan = await planMatrix({
    env: {
      GITHUB_REPOSITORY: 'Kilo-Org/cloud',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_SHA: sha,
      EXPECTED_COMMIT: sha,
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_TOKEN: 'synthetic',
    },
    headSha: sha,
    ghFor: () => assert.fail('no environment read before every source is on main'),
    root: scratch(),
  });
  assert.deepEqual(
    [plan.ok, plan.workers, plan.failures],
    [false, [], TABLE.workers.map(w => `source_not_on_main: ${w}`)]
  );
});

test('a multi-Worker table: one batch per Worker in table order, rows grouped, folders split', () => {
  assert.deepEqual(validateTable(SYNTHETIC), []);
  const batches = batchesOf(SYNTHETIC);
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
  const swap = (i, patch) => SYNTHETIC.map((r, j) => (j === i ? { ...r, ...patch } : r));
  const cases = [
    // One row per target: the same target twice is refused, across Workers too.
    [swap(2, { target: '/workloads/alpha/ALPHA_ONE' }), 'row_2_target_duplicate'],
    [
      [...SYNTHETIC, row('gamma-worker', 'G', 'G_PROD', '/workloads/beta/BETA_TOKEN')],
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

test('only Workers of the given table render or pass the source check; the Expo row is gone', () => {
  const alpha = batchesOf(SYNTHETIC)['alpha-worker'];
  const pins = {
    M65_RUN_ID: RUN_ID,
    M65_BATCH: 'alpha-worker',
    M65_NOT_BEFORE: iso(T0 + 20 * 60_000),
    M65_NOT_AFTER: iso(T0 + 45 * 60_000),
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
  };
  assert.deepEqual(pinProblems(pins, T0, FIXTURE), ['batch_not_in_table']);
  assert.equal(buildConfig(pins, SRC_DIR, FIXTURE), null);
  const f = checkSource('{}', '', '', alpha, undefined, FIXTURE);
  for (const code of ['batch_not_in_table', 'worker_source_unreviewed'])
    assert.ok(f.includes(code), code);
  assert.deepEqual(validatedNameTable(alpha, REPO_ROOT, FIXTURE).ok, false);
  // The fixture's Notifications batch renders with exactly its bindings under the fixture ...
  const notifications = { ...pins, M65_BATCH: 'notifications' };
  const cfg = buildConfig(notifications, SRC_DIR, FIXTURE);
  assert.equal(cfg.name, copierName('notifications'));
  assert.deepEqual(
    cfg.secrets_store_secrets.map(s => s.binding),
    FIXTURE.batches.notifications.rows.map(r => r.binding)
  );
  // ... and never under the checked-in table: the Expo copy is the separate one-shot run.
  assert.deepEqual(pinProblems(notifications, T0), ['batch_not_in_table']);
  assert.equal(buildConfig(notifications), null);
  // Every checked-in Worker renders its own rows.
  for (const w of TABLE.workers) {
    assert.deepEqual(
      buildConfig({ ...pins, M65_BATCH: w }).secrets_store_secrets.map(s => s.secret_name),
      TABLE.batches[w].rows.map(r => r.secretName)
    );
  }
});

test('one Worker batch with several rows: one read and one create per row, rows + 1 token uses', async () => {
  const batch = batchesOf(SYNTHETIC)['alpha-worker'];
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

// A passing preflight input for `batch` of a synthetic Worker whose reviewed names are `names`,
// with the writer configured exactly (one create per row, rows + 1 uses).
function writerScope(batch, names) {
  const worker = batch.sourceScript;
  const sources = { [worker]: { names } };
  const pins = {
    M65_RUN_ID: RUN_ID,
    M65_BATCH: worker,
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
      doNamespaces: [{ id: 'ns-1', script: copierName(worker), class: 'M65Gate' }],
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
      names: Object.fromEntries(batch.rows.map(r => [r.secretPath, []])),
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
  return { sources, pins, perm, meta, input, failures, withWriter, withAuth };
}

test('per-Worker writer scope: exactly that Worker targets, Create-only, rows + 1 uses', () => {
  const batches = batchesOf(SYNTHETIC);
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
  const { sources, pins, perm, meta, input, failures, withWriter, withAuth } = writerScope(
    batch,
    names
  );
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

test('M142 shared targets: each created once, by its first binder; a later binder proves parity only', () => {
  for (const w of TABLE.workers) assert.deepEqual(sharedTargetProblems(w), [], w);
  // kilo-ops binds the O11Y entry (as CF_ANALYTICS_API_KEY) but has no row for it.
  assert.deepEqual(
    TABLE.batches['kilo-ops'].rows.map(r => `${r.secretPath}/${r.secretKey}`),
    ['/workloads/kilo-ops/GF_SECRET_KEY']
  );
  // A second binder may not create: a second row for the same shared target is a duplicate.
  const kiloOpsShared = row(
    'kilo-ops',
    'CF_ANALYTICS_API_KEY',
    'O11Y_CF_AE_API_TOKEN',
    '/shared/O11Y_CF_AE_API_TOKEN'
  );
  assert.ok(
    validateTable([...TABLE.rows, kiloOpsShared]).includes(
      `row_${TABLE.rows.length}_target_duplicate`
    )
  );
  // Moving the create to kilo-ops refuses: auto-routing binds it first in table order.
  const moved = tableOf([
    ...TABLE.rows.filter(r => r.target !== '/shared/O11Y_CF_AE_API_TOKEN'),
    kiloOpsShared,
  ]);
  assert.deepEqual(moved.problems, []);
  const kiloOps = WORKER_SOURCES['kilo-ops'];
  const t = textsOf('kilo-ops', kiloOps);
  assert.ok(
    checkSource(
      t.wranglerText,
      t.policyText,
      t.readerText,
      moved.batches['kilo-ops'],
      kiloOps,
      moved
    ).includes('shared_target_not_first_binder_O11Y_CF_AE_API_TOKEN')
  );
  // Parity: a binder whose store entry differs from the creator's refuses.
  const drifted = {
    ...WORKER_SOURCES,
    'kilo-ops': {
      ...kiloOps,
      names: kiloOps.names.map(n =>
        n.binding === 'CF_ANALYTICS_API_KEY'
          ? { ...n, secretName: 'O11Y_CF_AE_API_TOKEN_OTHER' }
          : n
      ),
    },
  };
  assert.deepEqual(sharedTargetProblems('kilo-ops', TABLE, drifted), [
    'shared_parity_differs_O11Y_CF_AE_API_TOKEN',
  ]);
});

test('M142: a /shared target off the list is refused by the table and the batch closure', () => {
  const openrouter = row(
    'auto-routing',
    'OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY',
    '/shared/OPENROUTER_API_KEY'
  );
  assert.ok(
    validateTable([...TABLE.rows, openrouter]).includes(`row_${TABLE.rows.length}_target_shared`)
  );
  const batch = TABLE.batches['auto-routing'];
  assert.equal(validateBatch(batch), null);
  for (const patch of [
    { secretKey: 'OPENROUTER_API_KEY' },
    { secretPath: '/shared/AUTO_ROUTING_DECISION_SECRET' },
    { secretPath: '/' },
  ]) {
    assert.equal(
      validateBatch({ ...batch, rows: [{ ...batch.rows[0], ...patch }] }),
      'row_target_not_allowed',
      JSON.stringify(patch)
    );
  }
});

test('M142: a shared-target copy creates each listed key once in /shared', async () => {
  const batch = TABLE.batches['auto-routing'];
  const values = syntheticValues(batch);
  const tick = fake =>
    runTick({
      env: makeEnv({
        values,
        gate: fakeGateNamespace(),
        notBefore: iso(T0 - 60_000),
        notAfter: iso(T0 + 20 * 60_000),
        batch,
      }),
      cron: CRON,
      scheduledTime: T0,
      now: () => T0,
      fetchImpl: fake.fetch,
      batch,
    });
  const fake = fakeInfisical({ batch });
  const first = await tick(fake);
  assert.deepEqual([first.outcome, first.posts], ['complete', 2]);
  assert.deepEqual([...fake.store.keys()], [...SHARED_TARGETS]);
  for (const r of batch.rows) {
    assert.equal(fake.store.get(`${r.secretPath}/${r.secretKey}`), values[r.binding]);
  }
  // A replay where the shared target already exists creates nothing: Create-only refuses.
  const again = fakeInfisical({ batch, preexisting: [SHARED_TARGETS[0]] });
  const replay = await tick(again);
  assert.deepEqual(
    [replay.rows[0].created, replay.reason, again.store.get(SHARED_TARGETS[0])],
    ['no', 'create_http_400', 'pre-existing-synthetic']
  );
});

test('M142 writer scope with shared keys: exact path and key creates, never a broad /shared grant', () => {
  const gamma = batchesOf([
    row('gamma-worker', 'GAMMA_ONE', 'GAMMA_ONE_PROD', '/workloads/gamma/GAMMA_ONE'),
    row(
      'gamma-worker',
      'AUTO_ROUTING_DECISION_SECRET',
      'AUTO_ROUTING_DECISION_SECRET_PROD',
      '/shared/AUTO_ROUTING_DECISION_SECRET'
    ),
  ])['gamma-worker'];
  assert.equal(validateBatch(gamma), null);
  const { perm, failures, withWriter } = writerScope(
    gamma,
    gamma.rows.map(r => ({ ...r }))
  );
  assert.deepEqual(failures(), [], 'one workload and one shared create, three uses');
  const shared = gamma.rows[1];
  const workload = gamma.rows[0];
  for (const permissions of [
    [perm(workload), { ...perm(shared), secretName: undefined }], // every key in /shared
    [perm(workload), { ...perm(shared), secretName: '*' }],
    [perm(workload), { ...perm(shared), secretPath: '/shared/**' }],
    [
      perm(workload),
      perm(shared),
      perm({ secretPath: '/shared', secretKey: 'OPENROUTER_API_KEY' }),
    ],
    [perm(workload)], // the shared create missing
  ]) {
    assert.ok(
      failures(withWriter({ permissions })).includes('writer_permissions_not_exact'),
      JSON.stringify(permissions)
    );
  }
});
