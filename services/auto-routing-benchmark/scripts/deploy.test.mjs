import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { claimScheduledChunks, scheduleRunChunks, schedulerConfig } from '../src/scheduler.ts';
import { sqliteD1 } from '../test/sqlite-d1.ts';

const deployScript = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const fixtureUrl = new URL('../test/fixtures/deploy-wrangler.mjs', import.meta.url).href;

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'benchmark-deploy-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const wrangler = join(bin, 'wrangler');
  writeFileSync(wrangler, `#!${process.execPath}\nimport ${JSON.stringify(fixtureUrl)};\n`);
  chmodSync(wrangler, 0o755);
  const path = join(directory, 'fixture.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations)
    .filter(name => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  db.exec(`CREATE TABLE fixture_events (kind TEXT NOT NULL, at INTEGER NOT NULL);
    INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at,
      min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity)
    VALUES ('fixture-run', 'efficient', 'decider', 'platform', 'running', '2026-01-01T00:00:00.000Z',
      0.7, 3, 4, 1, 'deployment-smoke');`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BENCHMARK_DEPLOY_FIXTURE_DB: path,
    BENCHMARK_DEPLOY_LOCK_TIMEOUT_MS: '500',
    BENCHMARK_DEPLOY_DRAIN_TIMEOUT_MS: '2000',
    BENCHMARK_DEPLOY_LEASE_MS: '2400',
    BENCHMARK_DEPLOY_POLL_INTERVAL_MS: '50',
    BENCHMARK_DEPLOY_COMMAND_TIMEOUT_MS: '900',
    BENCHMARK_DEPLOY_DEPLOY_TIMEOUT_MS: '6000',
    ...overrides,
  };
  let child;
  let result;
  const start = (args = []) => {
    assert.equal(child, undefined);
    child = spawn(process.execPath, [deployScript, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    result = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return result;
  };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await result;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    start,
    kill(signal) {
      child.kill(signal);
    },
    count(kind) {
      return Number(
        db.prepare('SELECT COUNT(*) AS n FROM fixture_events WHERE kind = ?').get(kind).n
      );
    },
    events() {
      return db
        .prepare('SELECT kind FROM fixture_events ORDER BY rowid')
        .all()
        .map(row => row.kind);
    },
    lock() {
      return db
        .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1')
        .get();
    },
    addLive() {
      db.prepare(`INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk,
        case_ids, status, token, slot, lease_until) VALUES (?, 'fixture-run', 'fixture-model', 'default',
        '[]', 0, 0, '[]', ?, 'existing-claim', ?, ?)`).run(
        'queued-chunk',
        'queued',
        0,
        Date.now() + 60_000
      );
      db.prepare(`INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk,
        case_ids, status, token, slot, lease_until) VALUES (?, 'fixture-run', 'fixture-model', 'default',
        '[]', 0, 0, '[]', ?, 'existing-claim', ?, ?)`).run(
        'active-chunk',
        'active',
        1,
        Date.now() + 60_000
      );
    },
  };
}

async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Fixture event did not arrive');
    await sleep(20);
  }
}

function diagnostics(result) {
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /untrusted-(?:stdout|stderr|response)-canary|existing-claim|replacement-owner|operator-pause-/
  );
  const rows = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  for (const row of rows) {
    assert.match(row.event, /^benchmark_deploy_/);
    assert.equal(typeof row.phase, 'string');
    assert.equal(typeof row.elapsedMs, 'number');
  }
  return rows;
}

function released(state) {
  assert.deepEqual({ ...state.lock() }, { token: null, lease_until: 0 });
}

function failed(result, reason) {
  assert.equal(result.code, 1);
  assert.equal(diagnostics(result).at(-1).reason, reason);
}

test(
  'drains queued and active chunks under the dispatch lease before migrations and deployment',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_DRAIN_AFTER: '3' });
    state.addLive();
    const result = await state.start();
    assert.equal(result.code, 0, result.stdout);
    const events = state.events();
    assert.equal(state.count('drain'), 3);
    assert.ok(events.indexOf('migrations') > events.lastIndexOf('drain'));
    assert.ok(events.indexOf('deploy_started') > events.indexOf('migrations'));
    assert.equal(state.count('unguarded_migrations'), 0);
    assert.equal(state.count('unguarded_deploy'), 0);
    assert.equal(state.count('drain_without_lease'), 0);
    const rows = diagnostics(result);
    assert.ok(
      rows.some(
        row =>
          row.event === 'benchmark_deploy_drain_progress' && row.queued === 1 && row.active === 1
      )
    );
    released(state);
  }
);

test(
  'does not steal a contended lease and does not deploy after lock timeout',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t);
    state.db
      .prepare(
        "UPDATE scheduler_dispatch_lock SET token = 'replacement-owner', lease_until = ? WHERE id = 1"
      )
      .run(Date.now() + 60_000);
    const before = { ...state.lock() };
    const result = await state.start();
    failed(result, 'lock_timeout');
    assert.deepEqual({ ...state.lock() }, before);
    assert.equal(state.count('drain'), 0);
    assert.equal(state.count('migrations'), 0);
    assert.equal(state.count('deploy_started'), 0);
  }
);

test(
  'a real scheduler dispatch pass claims nothing while the deploy holds the lease',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '1500' });
    const db = sqliteD1(state.db);
    const config = schedulerConfig('{"slots":8}');
    await scheduleRunChunks(db, {
      runId: 'fixture-run',
      entries: [{ model: 'claimable/model', variant: '', providers: ['deepinfra'] }],
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const result = state.start();
    await until(() => state.count('deploy_started') === 1);
    const held = { ...state.lock() };
    assert.equal(typeof held.token, 'string');
    assert.ok(held.lease_until > Date.now());
    assert.deepEqual(await claimScheduledChunks(db, config, Date.now(), 'contending-dispatch'), []);
    assert.equal(state.lock().token, held.token);
    assert.equal(
      state.db
        .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('queued', 'active')")
        .get().n,
      0
    );
    assert.equal((await result).code, 0);
    released(state);
    const claims = await claimScheduledChunks(db, config, Date.now(), 'after-deploy');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].model, 'claimable/model');
  }
);

test(
  'acquires an expired dispatch lease without changing operator state',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t);
    state.db.exec(
      "UPDATE scheduler_dispatch_lock SET token = 'expired-owner', lease_until = 1 WHERE id = 1"
    );
    const result = await state.start();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(state.count('deploy_completed'), 1);
    diagnostics(result);
    released(state);
  }
);

const PAUSE_TOKEN = 'operator-pause-fixture-secret';

function pause(state, token = PAUSE_TOKEN, leaseUntil = Date.now() + 3_000_000_000) {
  state.db
    .prepare('UPDATE scheduler_dispatch_lock SET token = ?, lease_until = ? WHERE id = 1')
    .run(token, leaseUntil);
  return { token, lease_until: leaseUntil };
}

function between(events, start, end) {
  return events.slice(start + 1, end === -1 ? events.length : end);
}

test(
  'retains an operator pause unchanged and verifies it at every deployment checkpoint',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, {
      BENCHMARK_DEPLOY_FIXTURE_DRAIN_AFTER: '3',
      BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '1500',
    });
    const db = sqliteD1(state.db);
    await scheduleRunChunks(db, {
      runId: 'fixture-run',
      entries: [{ model: 'claimable/model', variant: '', providers: ['deepinfra'] }],
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    state.addLive();
    const held = pause(state);
    const result = state.start();
    await until(() => state.count('deploy_started') === 1);
    assert.deepEqual(
      await claimScheduledChunks(db, schedulerConfig('{"slots":8}'), Date.now(), 'contender'),
      []
    );
    const finished = await result;
    assert.equal(finished.code, 0, finished.stdout);
    assert.deepEqual({ ...state.lock() }, held);
    assert.equal(state.count('renew'), 0);
    assert.equal(state.count('release'), 0);
    assert.equal(state.count('drain'), 3);
    const events = state.events();
    const migrations = events.indexOf('migrations');
    const started = events.indexOf('deploy_started');
    const completed = events.indexOf('deploy_completed');
    assert.ok(between(events, events.lastIndexOf('drain'), migrations).includes('verify_pause'));
    assert.ok(between(events, migrations, started).includes('verify_pause'));
    assert.ok(between(events, started, completed).includes('verify_pause'));
    assert.ok(between(events, completed, -1).includes('verify_pause'));
    assert.equal(state.count('unguarded_migrations'), 0);
    assert.equal(state.count('unguarded_deploy'), 0);
    const rows = diagnostics(finished);
    assert.ok(rows.some(row => row.event === 'benchmark_deploy_operator_pause_retained'));
    assert.ok(!rows.some(row => row.event === 'benchmark_deploy_lock_acquired'));
  }
);

for (const [checkpoint, change, reason] of [
  ['drain', 'resume', 'operator_pause_lost'],
  ['migrations', 'replace', 'operator_pause_lost'],
  ['deploy', 'resume', 'operator_pause_lost'],
  ['after_deploy', 'replace', 'deployed_operator_pause_unverified'],
]) {
  test(
    `fails closed without touching the lock when an operator pause is ${change}d during ${checkpoint}`,
    { timeout: 15_000 },
    async t => {
      const state = fixture(t, {
        BENCHMARK_DEPLOY_FIXTURE_PAUSE_CHANGE_AT: checkpoint,
        BENCHMARK_DEPLOY_FIXTURE_PAUSE_CHANGE: change,
        BENCHMARK_DEPLOY_FIXTURE_DRAIN_AFTER: '3',
        BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: checkpoint === 'deploy' ? '5000' : '0',
      });
      state.addLive();
      pause(state);
      const result = await state.start();
      failed(result, reason);
      assert.equal(state.count('pause_changed'), 1);
      assert.equal(state.count('renew'), 0);
      assert.equal(state.count('release'), 0);
      const lock = { ...state.lock() };
      if (change === 'resume') assert.deepEqual(lock, { token: null, lease_until: 0 });
      else assert.equal(lock.token, 'operator-pause-replacement');
      if (checkpoint === 'drain') assert.equal(state.count('migrations'), 0);
      if (checkpoint === 'drain' || checkpoint === 'migrations') {
        assert.equal(state.count('deploy_started'), 0);
      }
      if (checkpoint === 'deploy') {
        assert.equal(state.count('deploy_aborted'), 1);
        assert.equal(state.count('deploy_completed'), 0);
      }
      if (checkpoint === 'after_deploy') assert.equal(state.count('deploy_completed'), 1);
    }
  );
}

for (const token of [
  'operator-pausefixture',
  'Operator-pause-fixture',
  'xoperator-pause-fixture',
]) {
  test(
    `treats unexpired owner ${token} as contention, not an operator pause`,
    { timeout: 15_000 },
    async t => {
      const state = fixture(t);
      const held = pause(state, token, Date.now() + 60_000);
      const result = await state.start();
      failed(result, 'lock_timeout');
      assert.deepEqual({ ...state.lock() }, held);
      assert.equal(state.count('verify_pause'), 0);
      assert.equal(state.count('drain'), 0);
    }
  );
}

test('acquires an expired operator pause like any expired lease', { timeout: 15_000 }, async t => {
  const state = fixture(t);
  pause(state, 'operator-pause-expired', 1);
  const result = await state.start();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(state.count('verify_pause'), 0);
  assert.equal(state.count('deploy_completed'), 1);
  released(state);
});

test(
  'fails closed when queued or active chunks do not drain in time',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_DRAIN_TIMEOUT_MS: '400' });
    state.addLive();
    const result = await state.start();
    failed(result, 'drain_timeout');
    assert.equal(state.count('migrations'), 0);
    assert.equal(state.count('deploy_started'), 0);
    assert.equal(
      state.db
        .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('queued', 'active')")
        .get().n,
      2
    );
    released(state);
  }
);

test(
  'renews the lease while draining and throughout a long deployment',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, {
      BENCHMARK_DEPLOY_FIXTURE_DRAIN_AFTER: '12',
      BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '2000',
    });
    state.addLive();
    const result = await state.start();
    assert.equal(result.code, 0, result.stdout);
    const events = state.events();
    assert.ok(events.indexOf('renew') < events.lastIndexOf('drain'));
    const duringDeploy = events.slice(
      events.indexOf('deploy_started') + 1,
      events.indexOf('deploy_completed')
    );
    assert.ok(duringDeploy.filter(event => event === 'renew').length >= 2);
    assert.equal(state.count('drain_without_lease'), 0);
    diagnostics(result);
    released(state);
  }
);

test(
  'retries transient renewal failures without aborting a deploy whose lease is still held',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, {
      BENCHMARK_DEPLOY_FIXTURE_RENEW_FAILURES_DURING_DEPLOY: '2',
      BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '2500',
    });
    const result = await state.start();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(state.count('renew_transient'), 2);
    assert.equal(state.count('deploy_aborted'), 0);
    assert.equal(state.count('deploy_completed'), 1);
    const retries = diagnostics(result)
      .filter(row => row.event === 'benchmark_deploy_lease_renewal_retry')
      .map(row => row.reason);
    assert.deepEqual(retries, ['command_failed', 'invalid_d1_response']);
    released(state);
  }
);

test(
  'reports a completed deploy whose lease cannot be confirmed afterwards distinctly',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_LOSE_AFTER_DEPLOY: '1' });
    const result = await state.start();
    failed(result, 'deployed_lease_unverified');
    assert.equal(state.count('deploy_completed'), 1);
    assert.ok(
      diagnostics(result).some(
        row => row.event === 'benchmark_deploy_completed' && row.phase === 'deploy'
      )
    );
    assert.equal(state.lock().token, 'replacement-owner');
  }
);

test(
  'releases the dispatch lease when deployment fails without exposing command output',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_DEPLOY_FAIL: '1' });
    const result = await state.start();
    failed(result, 'command_failed');
    assert.equal(state.count('deploy_failed'), 1);
    released(state);
  }
);

test('does not deploy when migrations fail', { timeout: 15_000 }, async t => {
  const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_MIGRATION_FAIL: '1' });
  const result = await state.start();
  failed(result, 'command_failed');
  assert.equal(state.count('deploy_started'), 0);
  released(state);
});

test('lease loss before migrations prevents any deployment work', { timeout: 15_000 }, async t => {
  const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_LOSE_ON_RENEW: '1' });
  const result = await state.start();
  failed(result, 'lease_lost');
  assert.equal(state.count('migrations'), 0);
  assert.equal(state.count('deploy_started'), 0);
  assert.equal(state.lock().token, 'replacement-owner');
});

test(
  'rechecks lease ownership after migrations before deployment',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_LOSE_AFTER_MIGRATION: '1' });
    const result = await state.start();
    failed(result, 'lease_lost');
    assert.equal(state.count('migrations'), 1);
    assert.equal(state.count('deploy_started'), 0);
    assert.equal(state.lock().token, 'replacement-owner');
  }
);

test(
  'aborts an in-flight deploy when another owner replaces its lease',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, {
      BENCHMARK_DEPLOY_FIXTURE_LOSE_DURING_DEPLOY: '1',
      BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '5000',
    });
    const result = await state.start();
    failed(result, 'lease_lost');
    assert.equal(state.count('deploy_started'), 1);
    assert.equal(state.count('deploy_aborted'), 1);
    assert.equal(state.count('deploy_completed'), 0);
    assert.equal(state.lock().token, 'replacement-owner');
  }
);

test(
  'aborts deployment on a stalled renewal rather than allowing lease expiry',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, {
      BENCHMARK_DEPLOY_FIXTURE_RENEW_DELAY_MS: '5000',
      BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '5000',
    });
    const result = await state.start();
    failed(result, 'lease_lost');
    assert.equal(state.count('deploy_aborted'), 1);
    assert.equal(state.count('deploy_completed'), 0);
    released(state);
  }
);

test('rejects malformed D1 output without exposing it', { timeout: 15_000 }, async t => {
  const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_BAD_JSON: 'drain' });
  const result = await state.start();
  failed(result, 'invalid_d1_response');
  assert.equal(state.count('deploy_started'), 0);
  released(state);
});

test(
  'handles interruption by aborting deployment and releasing its lease',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t, { BENCHMARK_DEPLOY_FIXTURE_DEPLOY_MS: '5000' });
    const result = state.start();
    await until(() => state.count('deploy_started') === 1);
    state.kill('SIGTERM');
    failed(await result, 'interrupted');
    assert.equal(state.count('deploy_aborted'), 1);
    released(state);
  }
);

test(
  'process death leaves a finite lease that expires without queue mutations',
  { timeout: 15_000 },
  async t => {
    const state = fixture(t);
    state.addLive();
    const result = state.start();
    await until(() => state.count('drain') >= 1);
    state.kill('SIGKILL');
    assert.equal((await result).signal, 'SIGKILL');
    const lock = { ...state.lock() };
    assert.ok(lock.lease_until > Date.now());
    assert.ok(lock.lease_until <= Date.now() + 2400);
    await sleep(Math.max(1, lock.lease_until - Date.now() + 30));
    const recovered = state.db
      .prepare(`INSERT INTO scheduler_dispatch_lock (id, token, lease_until)
    VALUES (1, 'recovery-owner', ?) ON CONFLICT (id) DO UPDATE SET token = excluded.token,
    lease_until = excluded.lease_until WHERE scheduler_dispatch_lock.lease_until <= ? RETURNING token`)
      .get(Date.now() + 1000, Date.now());
    assert.equal(recovered.token, 'recovery-owner');
    assert.equal(state.count('migrations'), 0);
    assert.equal(state.count('deploy_started'), 0);
  }
);

test('production manual and automatic benchmark paths alone select the guarded package command', () => {
  const workflow = load(
    readFileSync(new URL('../../../.github/workflows/deploy-workers.yml', import.meta.url), 'utf8')
  );
  for (const [job, variable] of [
    ['deploy-manual', 'inputs.worker'],
    ['deploy-changed', 'matrix.worker'],
  ]) {
    const steps = workflow.jobs[job].steps;
    const guarded = steps.filter(step => step.name === 'Drain and deploy benchmark');
    assert.equal(guarded.length, 1);
    assert.equal(
      guarded[0].if,
      `${variable} == 'services/auto-routing-benchmark' && inputs.target_environment == 'production'`
    );
    assert.equal(guarded[0].run, 'pnpm run deploy');
    assert.equal(guarded[0]['working-directory'], `\${{ ${variable} }}`);
    assert.equal(guarded[0].env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
    assert.equal(
      workflow.jobs[job]['timeout-minutes'],
      `\${{ ${variable} == 'services/cloud-agent-next' && 75 || ${variable} == 'services/auto-routing-benchmark' && inputs.target_environment == 'production' && 60 || 25 }}`
    );
    const standard = steps.find(step => step.name === 'Deploy to Cloudflare Workers');
    assert.equal(
      standard.if,
      `${variable} != 'services/auto-routing-benchmark' || inputs.target_environment != 'production'`
    );
    assert.match(standard.with.preCommands, /pnpm run predeploy/);
    assert.match(standard.with.command, /deploy --env/);
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.deploy, 'node scripts/deploy.mjs');
  assert.equal(manifest.scripts.predeploy, undefined);
  assert.equal(manifest.scripts['test:deploy'], 'tsx --test scripts/deploy.test.mjs');
  assert.match(manifest.scripts.test, /pnpm run test:deploy/);
});
