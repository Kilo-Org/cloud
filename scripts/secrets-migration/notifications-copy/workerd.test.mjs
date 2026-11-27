// Real workerd proof: the deployable modules from src/, local Secrets Store bindings with the
// production store id and names, the SQLite Durable Object gate, cron ticks through the scheduled
// handler, and outbound fetch routed to the synthetic Infisical. Miniflare 4 comes from the
// Notifications test pool (@cloudflare/vitest-pool-workers); config parsing and the dry run use the
// pinned Wrangler in the usage-ingest closure (as scripts/wrangler-nonproduction-fence.test.mjs does).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WRITER_SECRET } from './src/core.mjs';
import { BATCH } from './src/manifest.mjs';
import { MODULES, parseReceipt } from './checks.mjs';
import {
  COMPATIBILITY_DATE,
  COPIER_NAME,
  REPO_ROOT,
  SRC_DIR,
  buildConfig,
} from './render-config.mjs';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  RUN_ID,
  VERSION_ID,
  fakeInfisical,
  iso,
  leaks,
  syntheticValues,
} from './fakes.mjs';

// The pool package exports only an ESM entry, so locate its package.json and load Miniflare from
// its real path (pnpm's own dependency of the pool, not a hoisted copy).
const poolPackage = findPackageJSON(
  '@cloudflare/vitest-pool-workers',
  pathToFileURL(join(REPO_ROOT, 'services/notifications/package.json'))
);
const fromPool = createRequire(realpathSync(poolPackage));
const { Miniflare } = fromPool('miniflare');
const MINIFLARE_VERSION = fromPool('miniflare/package.json').version;
const usageIngest = createRequire(join(REPO_ROOT, 'services/usage-ingest/package.json'));
const wranglerPackage = usageIngest.resolve('wrangler/package.json');
const { unstable_readConfig } = usageIngest('wrangler');
const WRANGLER_BIN = join(dirname(wranglerPackage), 'bin', 'wrangler.js');

const CRON = '* * * * *';
const dirs = [];
after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
const scratch = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

async function start({ armed = true, notBefore, notAfter, fake, persist = false }) {
  const stdio = [];
  const mf = new Miniflare({
    durableObjectsPersist: persist,
    handleRuntimeStdio(stdout, stderr) {
      stdout.on('data', d => stdio.push(String(d)));
      stderr.on('data', d => stdio.push(String(d)));
    },
    workers: [
      {
        name: COPIER_NAME,
        modulesRoot: SRC_DIR,
        modules: MODULES.map(m => ({ type: 'ESModule', path: join(SRC_DIR, m) })),
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: {
          M65_RUN_ID: RUN_ID,
          M65_NOT_BEFORE: notBefore ?? iso(Date.now() - 60_000),
          M65_NOT_AFTER: notAfter ?? iso(Date.now() + 20 * 60_000),
          M65_INFISICAL_CLIENT_ID: CLIENT_ID,
          ...(armed ? { [WRITER_SECRET]: CLIENT_SECRET } : {}),
          CF_VERSION_METADATA: { id: VERSION_ID, tag: '', timestamp: '2026-11-27T00:00:00.000Z' },
        },
        secretsStoreSecrets: Object.fromEntries(
          BATCH.rows.map(r => [r.binding, { store_id: r.storeId, secret_name: r.secretName }])
        ),
        durableObjects: { M65_GATE: { className: 'M65Gate', useSQLite: true } },
        outboundService: req => fake.fetch(req),
      },
    ],
  });
  await mf.ready;
  return { mf, stdio };
}

async function seed(mf, values) {
  for (const r of BATCH.rows) {
    await (await mf.getSecretsStoreSecretAPI(r.binding, COPIER_NAME))().create(values[r.binding]);
  }
}

const receiptLines = stdio =>
  stdio
    .join('')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{"schema":"m65-copy-receipt/1"'));

// One cron tick; returns the scheduled result and the receipt that tick logged (parsed strictly).
async function tick(mf, stdio, scheduledTime = Date.now()) {
  const before = receiptLines(stdio).length;
  const result = await (
    await mf.getWorker(COPIER_NAME)
  ).scheduled({ cron: CRON, scheduledTime: new Date(scheduledTime) });
  for (let i = 0; i < 100 && receiptLines(stdio).length <= before; i++) await delay(20);
  const lines = receiptLines(stdio);
  assert.equal(lines.length, before + 1, 'exactly one receipt line per tick');
  const parsed = parseReceipt(lines.at(-1));
  assert.deepEqual(parsed.failures, [], 'receipt passes the shared parser');
  assert.deepEqual(
    result,
    { outcome: 'ok', noRetry: true },
    'handler succeeded and disabled retries'
  );
  return parsed.receipt;
}

const noLeak = (stdio, values, fake) =>
  assert.deepEqual(leaks(stdio.join(''), values, [...fake.issued, ...fake.providerIds]), []);

test('runtime: Miniflare 4 from the Notifications test pool', () => {
  assert.match(MINIFLARE_VERSION, /^4\./);
});

test('lifecycle: unarmed readiness, one armed copy, idle repeats, no fetch path, restart keeps the gate', async () => {
  const persist = scratch('m65-do-');
  const values = syntheticValues();

  const fake0 = fakeInfisical();
  const unarmed = await start({ armed: false, fake: fake0, persist });
  try {
    await seed(unarmed.mf, values);
    const r = await tick(unarmed.mf, unarmed.stdio);
    assert.deepEqual(
      [r.outcome, r.reason, r.armed, r.window, r.gate],
      ['unarmed', 'writer_not_installed', false, 'open', 'not_attempted']
    );
    assert.deepEqual(r.ready, {
      pins: true,
      envClosed: true,
      bindings: true,
      gate: true,
      cron: true,
    });
    assert.deepEqual([r.runId, r.versionId], [RUN_ID, VERSION_ID]);
    assert.equal(fake0.calls.length, 0);
    noLeak(unarmed.stdio, values, fake0);
  } finally {
    await unarmed.mf.dispose();
  }

  const fake = fakeInfisical();
  const armed = await start({ fake, persist });
  try {
    await seed(armed.mf, values);
    const res = await (
      await armed.mf.getWorker(COPIER_NAME)
    )
      .fetch('http://copier.invalid/')
      .catch(() => null);
    assert.ok(!res || res.status >= 500, 'no fetch handler');
    await res?.body?.cancel();
    assert.equal(fake.calls.length, 0, 'the fetch attempt reached nothing');

    const copy = await tick(armed.mf, armed.stdio);
    assert.deepEqual(
      [copy.outcome, copy.gate, copy.logins, copy.reads, copy.posts],
      ['complete', 'consumed_now', 1, 1, 1]
    );
    assert.deepEqual([copy.revoked, copy.denialProved], [true, true]);
    assert.ok(
      copy.rows.every(
        x => x.bytesParity && x.serializationParity && x.echo === 'equal' && x.created === 'yes'
      )
    );
    for (const row of BATCH.rows)
      assert.equal(fake.store.get(`${row.secretPath}/${row.secretKey}`), values[row.binding]);
    assert.ok(fake.calls.every(c => c.origin === 'https://eu.infisical.com'));

    const repeat = await tick(armed.mf, armed.stdio);
    assert.deepEqual(
      [repeat.outcome, repeat.reason, repeat.prior, repeat.reads],
      ['idle', 'already_consumed', 'complete', 0]
    );
    assert.equal(fake.calls.length, 4, 'no new provider call');
    assert.deepEqual(
      [...fake.store.keys()],
      ['/workloads/notifications/NOTIFICATIONS_EXPO_ACCESS_TOKEN']
    );
    noLeak(armed.stdio, values, fake);
  } finally {
    await armed.mf.dispose();
  }

  const fresh = fakeInfisical();
  const restarted = await start({ fake: fresh, persist });
  try {
    await seed(restarted.mf, values);
    const again = await tick(restarted.mf, restarted.stdio);
    assert.deepEqual(
      [again.outcome, again.reason, again.prior, fresh.calls.length],
      ['idle', 'already_consumed', 'complete', 0]
    );
  } finally {
    await restarted.mf.dispose();
  }
});

test('armed before the window: the readiness receipt, with no gate, auth or read', async () => {
  const fake = fakeInfisical();
  const { mf, stdio } = await start({
    fake,
    notBefore: iso(Date.now() + 5 * 60_000),
    notAfter: iso(Date.now() + 20 * 60_000),
  });
  try {
    await seed(mf, syntheticValues());
    const r = await tick(mf, stdio);
    assert.deepEqual(
      [r.outcome, r.reason, r.window, r.armed, r.gate, r.reads],
      ['idle', 'outside_window', 'before', true, 'not_attempted', 0]
    );
    assert.ok(Object.values(r.ready).every(Boolean));
    assert.equal(fake.calls.length, 0);
  } finally {
    await mf.dispose();
  }
});

test('eight racing ticks: exactly one admitted by the Durable Object gate', async () => {
  const values = syntheticValues();
  const fake = fakeInfisical();
  const { mf, stdio } = await start({ fake });
  try {
    await seed(mf, values);
    const worker = await mf.getWorker(COPIER_NAME);
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        worker.scheduled({ cron: CRON, scheduledTime: new Date(now) })
      )
    );
    for (let i = 0; i < 100 && receiptLines(stdio).length < 8; i++) await delay(20);
    const rs = receiptLines(stdio).map(l => parseReceipt(l).receipt);
    assert.equal(rs.length, 8);
    assert.equal(rs.filter(r => r.gate === 'consumed_now').length, 1);
    assert.equal(rs.filter(r => r.reason === 'already_consumed').length, 7);
    assert.deepEqual([fake.clientSecretUses, fake.creates], [1, 1]);
    noLeak(stdio, values, fake);
  } finally {
    await mf.dispose();
  }
});

test('existing target: 400, kept, nothing overwritten', async () => {
  const target = `${BATCH.rows[0].secretPath}/${BATCH.rows[0].secretKey}`;
  const fake = fakeInfisical({ preexisting: [target] });
  const { mf, stdio } = await start({ fake });
  try {
    await seed(mf, syntheticValues());
    const r = await tick(mf, stdio);
    assert.deepEqual([r.reason, r.reads, r.posts], ['create_http_400', 1, 1]);
    assert.deepEqual(
      r.rows.map(x => x.created),
      ['no']
    );
    assert.equal(fake.store.get(target), 'pre-existing-synthetic');
    assert.deepEqual([r.revoked, r.denialProved], [true, true]);
  } finally {
    await mf.dispose();
  }
});

test('a value Infisical would normalize stops before its POST', async () => {
  const fake = fakeInfisical();
  const { mf, stdio } = await start({ fake });
  try {
    await seed(mf, { EXPO_ACCESS_TOKEN: 'synthetic-expo-value ' });
    const r = await tick(mf, stdio);
    assert.deepEqual(
      [r.reason, r.reads, r.posts, fake.store.size],
      ['value_not_storable_losslessly', 1, 0, 0]
    );
  } finally {
    await mf.dispose();
  }
});

test('module surface: only the scheduled handler and the Durable Object class', () => {
  const src = readFileSync(join(SRC_DIR, 'worker.mjs'), 'utf8');
  assert.deepEqual(
    src.split('\n').filter(l => l.startsWith('export ')),
    ['export class M65Gate extends DurableObject {', 'export default {']
  );
  assert.match(
    src.slice(src.indexOf('export default {')),
    /^export default \{\n {2}async scheduled\(controller, env\) \{/
  );
  assert.doesNotMatch(src, /WorkerEntrypoint|async fetch\(|\bfetch\(request/);
  for (const m of ['core.mjs', 'manifest.mjs']) {
    const text = readFileSync(join(SRC_DIR, m), 'utf8');
    assert.doesNotMatch(text, /console\.|cloudflare:/, m);
  }
  assert.equal((src.match(/console\./g) ?? []).length, 1, 'one receipt log line');
});

test('the rendered config parses with the pinned Wrangler and dry-runs to exactly the three modules', () => {
  const dir = scratch('m65-config-');
  const pins = {
    M65_RUN_ID: RUN_ID,
    M65_NOT_BEFORE: iso(Date.now() + 20 * 60_000),
    M65_NOT_AFTER: iso(Date.now() + 45 * 60_000),
    M65_INFISICAL_CLIENT_ID: CLIENT_ID,
  };
  const path = join(dir, 'copier.wrangler.json');
  writeFileSync(path, JSON.stringify(buildConfig(pins), null, 2));
  const cfg = unstable_readConfig({ config: path });
  assert.deepEqual(
    [cfg.name, cfg.workers_dev, cfg.preview_urls, cfg.triggers.crons, cfg.logpush],
    [COPIER_NAME, false, false, [CRON], false]
  );
  assert.deepEqual(cfg.routes ?? [], []);
  assert.deepEqual(
    [cfg.services, cfg.queues?.producers, cfg.queues?.consumers, cfg.workflows].map(x => x ?? []),
    [[], [], [], []]
  );
  assert.equal(cfg.observability.traces.enabled, false);
  assert.deepEqual(cfg.secrets_store_secrets, [
    {
      binding: 'EXPO_ACCESS_TOKEN',
      store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
      secret_name: 'EXPO_ACCESS_TOKEN',
    },
  ]);

  const out = join(dir, 'out');
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  for (const k of Object.keys(env)) if (k.startsWith('CLOUDFLARE_')) delete env[k];
  const run = spawnSync(
    process.execPath,
    [WRANGLER_BIN, 'deploy', '--dry-run', '--outdir', out, '--config', path],
    {
      cwd: dir,
      env,
      encoding: 'utf8',
    }
  );
  assert.equal(run.status, 0, run.stderr);
  const files = readdirSync(out).sort();
  assert.deepEqual(
    files.filter(f => f.endsWith('.mjs')),
    ['core.mjs', 'manifest.mjs', 'worker.mjs']
  );
  for (const m of MODULES)
    assert.ok(readFileSync(join(out, m)).equals(readFileSync(join(SRC_DIR, m))), m);
  // Wrangler writes this notice into --outdir itself; it is not an upload part.
  assert.deepEqual(
    files.filter(f => !f.endsWith('.mjs')),
    ['README.md']
  );
  assert.match(
    readFileSync(join(out, 'README.md'), 'utf8'),
    /^This folder contains the built output assets for the worker "m65-notifications-copy"/
  );
});
