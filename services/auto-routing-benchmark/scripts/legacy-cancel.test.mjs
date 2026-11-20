import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  CANCEL_ERROR,
  CHANGED_BY_DESIGN,
  EXIT,
  PARKED_REQUESTED_AT,
  SCHEMA_TABLES_EXPECTED,
  buildStatements,
  lockGuardSql,
  parseArgs,
  runLegacyCancel,
  schemaCheckSql,
  stateSql,
} from './legacy-cancel.mjs';

const migrations = new URL('../migrations/', import.meta.url);
const OPERATOR = 'operator-pause-userpay';
const LEASE_HORIZON_MS = 14 * 24 * 3600_000;
const ENGINE = 'efficient:v1:6649fed2';

/**
 * The live schema is everything through 0037. 0038 is this branch's own unapplied
 * migration, so it is excluded: the operation must work on today's database, and every
 * fixture here proves it does.
 */
function liveMigrationNames() {
  return readdirSync(migrations)
    .filter(name => name.endsWith('.sql') && name < '0038')
    .sort();
}

function migrate(sqlite) {
  for (const name of liveMigrationNames()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-cancel-'));
  const path = join(directory, 'benchmark.sqlite');
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  migrate(sqlite);
  return {
    directory,
    path,
    sqlite,
    close() {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function holdOperatorLease(sqlite, token = OPERATOR, leaseUntil = Date.now() + LEASE_HORIZON_MS) {
  sqlite
    .prepare(
      `INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until`
    )
    .run(token, leaseUntil);
}

function insertDeciderRun(sqlite, { id, status = 'running', purpose = 'platform', startedAt }) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs (id, router, kind, status, started_at, completed_at, error,
         min_accuracy, switch_cost_factor, best_accuracy_switch_threshold, max_concurrency,
         benchmark_user_id, benchmark_org_id, repetitions, engine_identity, purpose,
         measurement_revision, accuracy_noise_band, frontier_min_accuracy_delta)
       VALUES (?, 'efficient', 'decider', ?, ?, NULL, NULL, 0.9, 1, 0.05, 250,
         'bench-user', 'bench-org', 1, ?, ?, 3, 0.05, 0)`
    )
    .run(id, status, startedAt ?? '2026-11-20T06:00:00.000Z', ENGINE, purpose);
  sqlite
    .prepare(
      `INSERT INTO run_models (run_id, model, variant, enqueued, reasoning_effort)
       VALUES (?, 'vendor/model', 'high', 1, 'high')`
    )
    .run(id);
  return id;
}

function insertProfile(
  sqlite,
  { model, variant = 'high', status, runId = null, failureClass = null }
) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
         run_id, failure_reason, failure_class, invalidated_at, requested_at, updated_at,
         completed_at, platform_requested, user_requested)
       VALUES ('efficient', ?, ?, ?, 1, ?, ?, NULL, ?, NULL, ?, ?, ?, 1, 1)`
    )
    .run(
      model,
      variant,
      ENGINE,
      status,
      runId,
      failureClass,
      '2026-11-20T05:00:00.000Z',
      '2026-11-20T05:00:00.000Z',
      status === 'ready' ? '2026-11-20T05:30:00.000Z' : null
    );
}

function insertChunk(
  sqlite,
  { runId, model = 'vendor/model', variant = 'high', rep = 0, chunk, status, attempts = 0, slot }
) {
  sqlite
    .prepare(
      `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids,
         status, token, slot, lease_until, available_at, attempts)
       VALUES (?, ?, ?, ?, '[]', ?, ?, '["case-a","case-b"]', ?, ?, ?, 0, 0, ?)`
    )
    .run(
      JSON.stringify([runId, model, variant, rep, chunk]),
      runId,
      model,
      variant,
      rep,
      chunk,
      status,
      status === 'queued' || status === 'active' ? 'claim-token' : null,
      status === 'active' ? (slot ?? chunk + 100) : null,
      attempts
    );
}

function insertSummary(sqlite, { runId, accuracy = 0.8, cases = 46 }) {
  sqlite
    .prepare(
      `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_latency_ms,
         cases, errors, timeouts, costed_cases, carried)
       VALUES (?, 'vendor/model', 'high', 'route/a', ?, 1000, ?, 0, 0, ?, 0)`
    )
    .run(runId, accuracy, cases, cases);
}

function insertCaseResult(sqlite, { runId, caseId, score, costUsd = 0.01 }) {
  sqlite
    .prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
         cost_usd, error, rep, timed_out, prompt_revision)
       VALUES (?, 'vendor/model', 'high', ?, 'route/a', ?, 500, ?, NULL, 0, 0, 3)`
    )
    .run(runId, caseId, score, costUsd);
}

function insertRoutingTable(sqlite, { runId, publishedAt = '2026-11-20T05:00:00.000Z' }) {
  sqlite
    .prepare(
      `INSERT INTO routing_tables (run_id, router, published_at, generated_at, min_accuracy,
         switch_cost_factor, best_accuracy_switch_threshold, source)
       VALUES (?, 'efficient', ?, ?, 0.9, 1, 0.05, 'platform')`
    )
    .run(runId, publishedAt, publishedAt);
}

function insertLaneFailure(sqlite, { runId, chunk = 0 }) {
  sqlite
    .prepare(
      `INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at, failure_class)
       VALUES (?, 'vendor/model', 'high', 0, ?, 0, '2026-11-20T05:00:00.000Z', 'unknown')`
    )
    .run(runId, chunk);
}

function insertExecution(sqlite, { runId, caseId = 'case-a' }) {
  sqlite
    .prepare(
      `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token, started_at, prompt_revision)
       VALUES (?, 'vendor/model', 'high', 0, ?, 'exec-token', 0, 3)`
    )
    .run(runId, caseId);
}

function insertPendingOutput(sqlite, { runId, caseId = 'case-a' }) {
  sqlite
    .prepare(
      `INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload, prompt_revision, grading_token, grading_lease_until)
       VALUES (?, 'vendor/model', 'high', ?, 0, '{}', 3, NULL, 0)`
    )
    .run(runId, caseId);
}

function insertRemeasure(
  sqlite,
  {
    model,
    variant = 'high',
    runId = null,
    requestedAt = '2026-11-20T04:00:00.000Z',
    claimedAt = null,
  }
) {
  sqlite
    .prepare(
      `INSERT INTO profile_remeasures (router, model, variant, engine_identity, repetitions, run_id, requested_at, claimed_at)
       VALUES ('efficient', ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(model, variant, ENGINE, runId, requestedAt, claimedAt);
}

function insertSubscription(sqlite) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
       VALUES ('efficient', 'platform', 'platform', 'rev-1', '{}', '2026-11-20T04:00:00.000Z')`
    )
    .run();
}

async function run(sqlitePath, argv) {
  const { createLocalExecutor } = await import('./legacy-cancel.mjs');
  const lines = [];
  const executor = createLocalExecutor(sqlitePath);
  const code = await runLegacyCancel({
    argv: [...argv, '--local-file', sqlitePath],
    executor,
    log: line => lines.push(line),
  });
  const events = lines
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .map(event => ({ ...event, event: event.event.slice('legacy_cancel_'.length) }));
  return { code, lines, events, last: name => events.filter(event => event.event === name).at(-1) };
}

const BASE_ARGS = ['--expect-token', OPERATOR, '--min-remaining-ms', '600000'];

/**
 * A run that looks like the two stuck production runs: claimed profiles, a mix of finished
 * and unfinished chunks, executed paid calls, graded results and a pending late output.
 * Plus, in the same database, a fully completed run that must not move by a byte.
 */
function seed(sqlite) {
  holdOperatorLease(sqlite);

  insertDeciderRun(sqlite, { id: 'run-live-a', purpose: 'platform' });
  insertProfile(sqlite, { model: 'vendor/live-a', status: 'running', runId: 'run-live-a' });
  insertProfile(sqlite, { model: 'vendor/live-b', status: 'running', runId: 'run-live-a' });
  insertChunk(sqlite, {
    runId: 'run-live-a',
    model: 'vendor/live-a',
    chunk: 0,
    status: 'completed',
  });
  insertChunk(sqlite, {
    runId: 'run-live-a',
    model: 'vendor/live-a',
    chunk: 1,
    status: 'active',
    attempts: 2,
  });
  insertChunk(sqlite, {
    runId: 'run-live-a',
    model: 'vendor/live-b',
    chunk: 0,
    status: 'queued',
    attempts: 1,
  });
  insertChunk(sqlite, { runId: 'run-live-a', model: 'vendor/live-b', chunk: 1, status: 'pending' });
  insertCaseResult(sqlite, { runId: 'run-live-a', caseId: 'case-a', score: 1 });
  insertExecution(sqlite, { runId: 'run-live-a' });
  insertPendingOutput(sqlite, { runId: 'run-live-a' });
  insertRemeasure(sqlite, {
    model: 'vendor/live-a',
    runId: 'run-live-a',
    claimedAt: '2026-11-20T06:00:00.000Z',
  });

  // Second live run, user purpose, its own claim.
  insertDeciderRun(sqlite, {
    id: 'run-live-b',
    purpose: 'user',
    startedAt: '2026-11-20T07:00:00.000Z',
  });
  insertProfile(sqlite, { model: 'vendor/live-c', status: 'running', runId: 'run-live-b' });
  insertChunk(sqlite, {
    runId: 'run-live-b',
    model: 'vendor/live-c',
    chunk: 0,
    status: 'active',
    attempts: 1,
  });
  insertCaseResult(sqlite, { runId: 'run-live-b', caseId: 'case-a', score: 0 });

  // A terminal run that still owns stale runnable chunks — the case the correction names.
  insertDeciderRun(sqlite, {
    id: 'run-terminal',
    status: 'failed',
    startedAt: '2026-11-19T00:00:00.000Z',
  });
  insertChunk(sqlite, { runId: 'run-terminal', model: 'vendor/term', chunk: 0, status: 'pending' });
  insertChunk(sqlite, {
    runId: 'run-terminal',
    model: 'vendor/term',
    chunk: 1,
    status: 'queued',
    attempts: 3,
  });

  // Completed run: must stay byte-identical, including its ready profile and artifact.
  insertDeciderRun(sqlite, {
    id: 'run-done',
    status: 'completed',
    startedAt: '2026-11-18T00:00:00.000Z',
  });
  sqlite
    .prepare(
      "UPDATE benchmark_runs SET completed_at = '2026-11-18T06:00:00.000Z' WHERE id = 'run-done'"
    )
    .run();
  insertChunk(sqlite, { runId: 'run-done', model: 'vendor/done', chunk: 0, status: 'completed' });
  insertCaseResult(sqlite, { runId: 'run-done', caseId: 'case-a', score: 1, costUsd: 0.42 });
  insertSummary(sqlite, { runId: 'run-done', accuracy: 0.8125, cases: 46 });
  insertRoutingTable(sqlite, { runId: 'run-done' });
  insertProfile(sqlite, { model: 'vendor/done', status: 'ready', runId: 'run-done' });
  insertLaneFailure(sqlite, { runId: 'run-done' });
  insertRemeasure(sqlite, { model: 'vendor/done', requestedAt: '2026-11-20T03:00:00.000Z' });

  // A ready profile whose run_id still points at a run that is later cancelled: the
  // `run_id IN (…)` bug would park this row and destroy a published measurement.
  insertProfile(sqlite, { model: 'vendor/ready-claimed', status: 'ready', runId: 'run-live-a' });

  // An already-failed profile: the count must never move.
  insertProfile(sqlite, { model: 'vendor/failed', status: 'failed', failureClass: 'unknown' });
  insertProfile(sqlite, {
    model: 'vendor/ready-authoritative',
    status: 'ready',
    runId: 'run-done',
  });
  insertSubscription(sqlite);
}

test('parseArgs refuses every ambiguous invocation', () => {
  const cases = [
    [[]],
    [['--apply']],
    [['--apply', '--remote']],
    [['--apply', '--remote', '--expect-token', 'operator-pause-x']],
    [['--apply', '--remote', '--expect-token', 'not-operator', '--min-remaining-ms', '1']],
    [['--apply', '--remote', '--expect-token', OPERATOR, '--min-remaining-ms', '0']],
    [
      [
        '--apply',
        '--remote',
        '--local-file',
        '/tmp/x',
        '--expect-token',
        OPERATOR,
        '--min-remaining-ms',
        '1',
      ],
    ],
    [['--dry-run', '--apply', '--remote', '--expect-token', OPERATOR, '--min-remaining-ms', '1']],
    [['--verify', '--remote', '--expect-token', OPERATOR, '--min-remaining-ms', '1']],
    [
      [
        '--apply',
        '--remote',
        '--expect-token',
        OPERATOR,
        '--min-remaining-ms',
        '600000',
        '--bogus',
      ],
    ],
  ];
  for (const [argv] of cases) {
    assert.throws(
      () => parseArgs(argv),
      error => error.constructor.name === 'UsageError',
      argv.join(' ')
    );
  }
});

test('every write carries the live-clock lease guard, and no statement touches a 0038 table', () => {
  const statements = buildStatements({
    expectToken: OPERATOR,
    minRemainingMs: 600000,
    runIds: ['run-live-a'],
  });
  assert.ok(statements.length >= 5);
  for (const statement of statements) {
    assert.match(statement, /UPDATE /);
    assert.ok(statement.includes(lockGuardSql(OPERATOR, 600000)), 'missing live-clock lease guard');
    // The guard must be evaluated by the database, so a request that waited cannot write.
    const guard = statement.slice(
      statement.indexOf('EXISTS (SELECT 1 FROM scheduler_dispatch_lock')
    );
    assert.match(guard, /julianday\('now'\)/, 'the lease guard must use the database clock');
    assert.doesNotMatch(statement, /CURRENT_TIMESTAMP/, 'second-granularity clock is too coarse');
    for (const forbidden of [
      'benchmark_cutover',
      'paid_benchmark_',
      'benchmark_case_runs',
      'benchmark_case_payers',
      'paid_model_requests',
      'profile_attempt_history',
      'case_results',
      'model_summaries',
      'routing_tables',
      'run_lane_failures',
      'scheduler_executions',
      'pending_decider_outputs',
      'benchmark_subscriptions',
      'probe_activations',
    ]) {
      assert.ok(!statement.includes(forbidden), `${forbidden} must never be written`);
    }
  }
  // Nothing in the operation may even READ a 0038 table.
  for (const sql of [stateSql(), schemaCheckSql(), lockGuardSql(OPERATOR, 1)]) {
    for (const forbidden of [
      'benchmark_cutover',
      'paid_benchmark_',
      'benchmark_case_runs',
      'profile_attempt_history',
    ]) {
      assert.ok(!sql.includes(forbidden), `${forbidden} must never be read`);
    }
  }
});

test('profile parking is guarded by status = running, so a ready row is never parked', () => {
  const statements = buildStatements({
    expectToken: OPERATOR,
    minRemainingMs: 1,
    runIds: ['run-live-a'],
  });
  const profileWrites = statements.filter(statement =>
    statement.includes('UPDATE benchmark_profiles')
  );
  assert.equal(profileWrites.length, 2);
  for (const statement of profileWrites) {
    assert.match(statement, /WHERE status = 'running'/);
  }
});

test('chunks are never marked failed, and the sweep covers stale chunks on terminal runs', () => {
  const statements = buildStatements({
    expectToken: OPERATOR,
    minRemainingMs: 1,
    runIds: ['run-live-a'],
  });
  const chunk = statements.find(statement => statement.includes('UPDATE scheduler_chunks'));
  assert.ok(chunk);
  assert.match(chunk, /SET status = 'completed'/);
  assert.doesNotMatch(chunk, /status = 'failed'/);
  assert.match(chunk, /status IN \('pending', 'queued', 'active'\)/);
  assert.match(chunk, /NOT EXISTS/);
  assert.doesNotMatch(chunk, /run_id IN /, 'the sweep must be predicate-based, not id-based');
});

test('dry run reports the exact work and writes nothing', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = readAll(f.sqlite);
    const result = await run(f.path, ['--dry-run', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.last('dry_run_ok').writes, 0);
    assert.deepEqual(
      result
        .last('would_cancel')
        .runs.map(row => row.id)
        .sort(),
      ['run-live-a', 'run-live-b']
    );
    assert.equal(result.lines.filter(line => line.startsWith('UPDATE ')).length, 5);
    assert.deepEqual(readAll(f.sqlite), before, 'a dry run must not write');
  } finally {
    f.close();
  }
});

test('apply cancels live work, keeps every completed artifact and every failure counter', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = snapshot(f.sqlite);
    const rawBefore = readAll(f.sqlite);
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.ok, JSON.stringify(result.events));

    // One terminal marker on the two live runs only.
    const runs = f.sqlite.prepare('SELECT id, status, error FROM benchmark_runs ORDER BY id').all();
    assert.deepEqual(
      runs.map(row => [row.id, row.status]),
      [
        ['run-done', 'completed'],
        ['run-live-a', 'failed'],
        ['run-live-b', 'failed'],
        ['run-terminal', 'failed'],
      ]
    );
    for (const row of runs.filter(entry => entry.id.startsWith('run-live'))) {
      assert.equal(row.error, CANCEL_ERROR);
    }
    // The completed run keeps its own error field.
    assert.equal(runs.find(row => row.id === 'run-done').error, null);

    // Zero live work of any kind — pending/queued/active included, on terminal runs too.
    const live = f.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('pending','queued','active')"
      )
      .get();
    assert.equal(live.n, 0);
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_profiles WHERE status='running'").get()
        .n,
      0
    );
    // Finished chunks keep their status; nothing was flipped to failed.
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status='failed'").get().n,
      0
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status='completed'").get()
        .n,
      before.completed_chunks + before.unfinished_chunks,
      'every unfinished chunk closed, no finished chunk reopened'
    );

    // Cancelled-run profiles are parked at the epoch with no owner.
    const parked = f.sqlite
      .prepare(
        `SELECT model, status, run_id, requested_at FROM benchmark_profiles
         WHERE model IN ('vendor/live-a','vendor/live-b','vendor/live-c') ORDER BY model`
      )
      .all();
    for (const row of parked) {
      assert.equal(row.status, 'pending');
      assert.equal(row.run_id, null);
      assert.equal(row.requested_at, PARKED_REQUESTED_AT);
    }

    // The ready measurement whose provenance run was cancelled is untouched.
    const survivor = f.sqlite
      .prepare(
        "SELECT status, run_id, requested_at FROM benchmark_profiles WHERE model='vendor/ready-claimed'"
      )
      .get();
    assert.deepEqual(
      { ...survivor },
      {
        status: 'ready',
        run_id: 'run-live-a',
        requested_at: '2026-11-20T05:00:00.000Z',
      }
    );

    // Failure counters never move; no profile becomes failed by this operation.
    assert.equal(before.failed_profiles, Number(after(f.sqlite).failed_profiles));
    assert.equal(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM run_lane_failures').get().n,
      before.lane_failures_n
    );

    // Real paid draws and late outputs are retained — compared against the raw pre-state,
    // because the digest above counts only completed-run artifacts.
    const raw = readAll(f.sqlite);
    assert.equal(raw.case_results.length, rawBefore.case_results.length);
    assert.equal(raw.scheduler_executions.length, rawBefore.scheduler_executions.length);
    assert.equal(raw.pending_decider_outputs.length, rawBefore.pending_decider_outputs.length);

    // Re-measure claims are parked in place: row kept, run_id kept, claim cleared.
    const claims = f.sqlite
      .prepare(
        'SELECT model, run_id, requested_at, claimed_at FROM profile_remeasures ORDER BY model'
      )
      .all();
    assert.deepEqual(
      claims.map(row => ({ ...row })),
      [
        {
          model: 'vendor/done',
          run_id: null,
          requested_at: '2026-11-20T03:00:00.000Z',
          claimed_at: null,
        },
        {
          model: 'vendor/live-a',
          run_id: 'run-live-a',
          requested_at: PARKED_REQUESTED_AT,
          claimed_at: null,
        },
      ]
    );
    assert.equal(result.last('apply_ok').failedProfilesUnchanged, true);
  } finally {
    f.close();
  }
});

test('apply keeps completed-run results, summaries and routing artifacts byte-identical', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = snapshot(f.sqlite);
    await run(f.path, ['--apply', ...BASE_ARGS]);
    const after = snapshot(f.sqlite);
    for (const key of [
      'completed_runs',
      'completed_run_signature',
      'chunk_attempts',
      'completed_chunk_signature',
      'chunk_throttle_deferrals',
      'case_results_key_length',
      'ready_profiles',
      'failed_profiles',
      'settled_profile_signature',
      'case_results_n',
      'case_results_score',
      'case_results_cost',
      'case_results_latency',
      'case_results_timeouts',
      'case_results_error_length',
      'summaries_n',
      'summaries_accuracy',
      'summaries_cases',
      'routing_tables_n',
      'routing_tables_signature',
      'candidates_n',
      'candidates_accuracy',
      'candidates_cost',
      'lane_failures_n',
      'executions_n',
      'pending_outputs_n',
      'remeasures_n',
      'subscriptions_n',
      'probe_activations_n',
    ]) {
      assert.equal(after[key], before[key], `${key} changed`);
    }
    // No published artifact was rewritten.
    assert.equal(
      f.sqlite.prepare("SELECT published_at FROM routing_tables WHERE run_id='run-done'").get()
        .published_at,
      '2026-11-20T05:00:00.000Z'
    );
  } finally {
    f.close();
  }
});

test('a second apply preserves the verified state', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    assert.equal((await run(f.path, ['--apply', ...BASE_ARGS])).code, EXIT.ok);
    const first = snapshot(f.sqlite);
    const second = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(second.code, EXIT.ok);
    assert.deepEqual(snapshot(f.sqlite), first);
  } finally {
    f.close();
  }
});

test('apply closes a queued chunk left behind by runs that are already terminal', async () => {
  // The last run can finish before all of its chunks leave the queue.
  const f = fixture();
  try {
    holdOperatorLease(f.sqlite);
    insertDeciderRun(f.sqlite, { id: 'run-done-a', status: 'failed' });
    insertDeciderRun(f.sqlite, { id: 'run-done-b', status: 'failed' });
    insertChunk(f.sqlite, {
      runId: 'run-done-a',
      model: 'vendor/a',
      chunk: 0,
      status: 'completed',
    });
    insertChunk(f.sqlite, { runId: 'run-done-a', model: 'vendor/a', chunk: 1, status: 'queued' });
    insertChunk(f.sqlite, { runId: 'run-done-b', model: 'vendor/b', chunk: 0, status: 'pending' });
    // A profile nobody owns any more: the park statement is the third settle write.
    insertProfile(f.sqlite, { model: 'vendor/orphan', status: 'error_pending' });

    const before = snapshot(f.sqlite);
    assert.equal(before.running_runs, 0, 'precondition: no live run to cancel');
    assert.ok(before.unfinished_chunks > 0, 'precondition: an unfinished chunk survives');

    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.ok, JSON.stringify(result.events));
    assert.equal(result.last('apply_ok').passes, 1);

    const chunks = f.sqlite
      .prepare('SELECT id, status, slot, token, lease_until FROM scheduler_chunks ORDER BY id')
      .all();
    assert.deepEqual(
      chunks.map(row => row.status),
      ['completed', 'completed', 'completed'],
      'every unfinished chunk of a non-running run is closed'
    );
    assert.deepEqual(
      chunks.map(row => [row.slot, row.token, Number(row.lease_until)]),
      [
        [null, null, 0],
        [null, null, 0],
        [null, null, 0],
      ],
      'a closed chunk retains no claim'
    );
    const after = snapshot(f.sqlite);
    assert.equal(after.unfinished_chunks, 0);
    assert.equal(after.running_profiles, 0, 'the orphaned running profile is parked');
  } finally {
    f.close();
  }
});

test('a run admitted between passes is cancelled in the same invocation', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const executor = createLocalExecutor(f.path);
    let injected = false;
    const wrapped = {
      read: sql => executor.read(sql),
      write: async statements => {
        const changed = executor.write(statements);
        if (!injected) {
          injected = true;
          // The legacy worker admits a new platform run right after our first pass, exactly
          // like `drainQueue -> startRun` can while the lease blocks claims but not admission.
          insertDeciderRun(f.sqlite, { id: 'run-race', startedAt: '2026-11-20T15:00:00.000Z' });
          insertProfile(f.sqlite, { model: 'vendor/race', status: 'running', runId: 'run-race' });
          insertChunk(f.sqlite, {
            runId: 'run-race',
            model: 'vendor/race',
            chunk: 0,
            status: 'pending',
          });
        }
        return changed;
      },
      close: () => executor.close(),
    };
    const lines = [];
    const code = await runLegacyCancel({
      argv: ['--apply', ...BASE_ARGS, '--local-file', f.path],
      executor: wrapped,
      log: line => lines.push(line),
    });
    assert.equal(code, EXIT.ok, lines.join('\n'));
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('pending','queued','active')"
        )
        .get().n,
      0
    );
    assert.equal(
      f.sqlite.prepare("SELECT status FROM benchmark_runs WHERE id='run-race'").get().status,
      'failed'
    );
  } finally {
    f.close();
  }
});

test('a lease that is not the expected operator token is refused with no writes', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    holdOperatorLease(f.sqlite, 'operator-pause-other');
    const before = readAll(f.sqlite);
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.guardRefused);
    assert.match(result.last('guard_refused').reason, /operator-pause-other/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('a lease that ran down before the request is refused with no writes', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    holdOperatorLease(f.sqlite, OPERATOR, Date.now() + 60_000);
    const before = readAll(f.sqlite);
    // 10 minutes required, 1 minute left.
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.guardRefused);
    assert.match(result.last('guard_refused').reason, /below the required/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('a lease that expires between the precheck and the write writes nothing', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const executor = createLocalExecutor(f.path);
    const wrapped = {
      read: sql => executor.read(sql),
      write: statements => {
        // The lease dies while the request is in flight: only the statement's own
        // database-clock guard can catch this.
        f.sqlite.prepare('UPDATE scheduler_dispatch_lock SET lease_until = 1 WHERE id = 1').run();
        return executor.write(statements);
      },
      close: () => executor.close(),
    };
    const before = readAll(f.sqlite);
    const lines = [];
    const code = await runLegacyCancel({
      argv: ['--apply', ...BASE_ARGS, '--local-file', f.path],
      executor: wrapped,
      log: line => lines.push(line),
    });
    assert.equal(code, EXIT.guardRefused, lines.join('\n'));
    // Nothing was cancelled: the live runs are still running and their chunks untouched.
    assert.deepEqual(
      expr(f.sqlite, "SELECT id FROM benchmark_runs WHERE status = 'running' ORDER BY id"),
      [{ id: 'run-live-a' }, { id: 'run-live-b' }]
    );
    assert.equal(unchangedLiveChunks(before, readAll(f.sqlite)), true);
  } finally {
    f.close();
  }
});

test('a wrong schema (pre-0037 or post-0038) is refused before any write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-cancel-schema-'));
  try {
    const path = join(directory, 'old.sqlite');
    const sqlite = new DatabaseSync(path);
    sqlite.exec(
      `CREATE TABLE benchmark_runs (id text PRIMARY KEY NOT NULL, status text NOT NULL);
       CREATE TABLE benchmark_profiles (model text NOT NULL);
       CREATE TABLE scheduler_dispatch_lock (id integer PRIMARY KEY NOT NULL, token text, lease_until integer NOT NULL DEFAULT 0);`
    );
    holdOperatorLease(sqlite);
    const result = await run(path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /tables the operation needs/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').get().n, 0);
    sqlite.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verify refuses to clear the deploy when live work reappeared', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baselinePath = join(f.directory, 'baseline.json');
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    assert.equal(
      (await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath])).code,
      EXIT.ok
    );
    // The legacy worker admits work in the deploy window. --verify must catch it.
    insertDeciderRun(f.sqlite, { id: 'run-race', startedAt: '2026-11-20T15:00:00.000Z' });
    insertChunk(f.sqlite, { runId: 'run-race', model: 'vendor/race', chunk: 0, status: 'pending' });
    const failed = await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath]);
    assert.equal(failed.code, EXIT.verifyFailed);
    assert.ok(
      failed.last('verify_failed').failures.some(entry => entry.startsWith('running_runs=1'))
    );
    assert.ok(
      failed.last('verify_failed').failures.some(entry => entry.startsWith('unfinished_chunks=1'))
    );
    // Applying again repairs it, and verify then passes.
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    assert.equal(
      (await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath])).code,
      EXIT.ok
    );
  } finally {
    f.close();
  }
});

test('verify refuses when the operator lease row changed under it', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baselinePath = join(f.directory, 'baseline.json');
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    holdOperatorLease(f.sqlite, OPERATOR, Date.now() + LEASE_HORIZON_MS + 1);
    const result = await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /lease row changed/);
  } finally {
    f.close();
  }
});

test('verify refuses a baseline taken under another lease token', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baselinePath = join(f.directory, 'baseline.json');
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    baseline.token = 'operator-pause-someone-else';
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const result = await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /baseline was taken under/);
  } finally {
    f.close();
  }
});

test('the lease row is never modified: token and expiry survive apply and verify', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = f.sqlite
      .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1')
      .get();
    const baselinePath = join(f.directory, 'baseline.json');
    await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath]);
    await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath]);
    const after = f.sqlite
      .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1')
      .get();
    assert.deepEqual({ ...after }, { ...before });
    // Rows 2 and 3 are not created by this operation.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_dispatch_lock').get().n, 1);
  } finally {
    f.close();
  }
});

test('a schema of only the live migrations is exactly what the operation expects', () => {
  const f = fixture();
  try {
    const names = liveMigrationNames();
    assert.ok(names.at(-1).startsWith('0037'), `last live migration is ${names.at(-1)}`);
    assert.ok(!names.some(name => name.startsWith('0038')));
    const present = f.sqlite.prepare(schemaCheckSql()).get();
    assert.equal(present.present, SCHEMA_TABLES_EXPECTED);
  } finally {
    f.close();
  }
});

test('a classifier run is cancelled through its run row and cannot spend afterwards', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    f.sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, status, started_at, min_accuracy,
           switch_cost_factor, best_accuracy_switch_threshold, max_concurrency, repetitions,
           engine_identity, purpose, measurement_revision)
         VALUES ('run-classifier', 'efficient', 'classifier', 'running', '2026-11-20T06:00:00.000Z',
           0.9, 1, 0.05, 250, 1, 'classifier:v1:abc', 'platform', 3)`
      )
      .run();
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.ok);
    assert.ok(result.last('apply_ok').cancelledRuns.includes('run-classifier'));
    assert.equal(
      f.sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'run-classifier'").get()
        .status,
      'failed'
    );
    // processJob short-circuits on a non-running run, so the queued classifier messages that
    // are still in the queue cannot reach a model call.
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
  } finally {
    f.close();
  }
});

// ---- helpers ---------------------------------------------------------------------------

function expr(sqlite, sql) {
  return sqlite
    .prepare(sql)
    .all()
    .map(row => ({ ...row }));
}

function readAll(sqlite) {
  const tables = [
    'benchmark_runs',
    'benchmark_profiles',
    'scheduler_chunks',
    'scheduler_dispatch_lock',
    'profile_remeasures',
    'case_results',
    'model_summaries',
    'routing_tables',
    'run_lane_failures',
    'scheduler_executions',
    'pending_decider_outputs',
    'benchmark_subscriptions',
  ];
  const dump = {};
  for (const table of tables) dump[table] = expr(sqlite, `SELECT * FROM ${table} ORDER BY rowid`);
  return dump;
}

function snapshot(sqlite) {
  const [row] = sqlite.prepare(stateSql()).all();
  return { ...row };
}

function after(sqlite) {
  return snapshot(sqlite);
}

function unchangedLiveChunks(before, now) {
  const key = chunk =>
    `${chunk.run_id}|${chunk.model}|${chunk.variant}|${chunk.rep}|${chunk.chunk}|${chunk.status}|${chunk.token}|${chunk.lease_until}`;
  const liveBefore = before.scheduler_chunks.filter(chunk =>
    ['pending', 'queued', 'active'].includes(chunk.status)
  );
  const map = new Map(now.scheduler_chunks.map(chunk => [key(chunk), chunk]));
  return liveBefore.every(chunk => map.has(key(chunk)));
}

test('CHANGED_BY_DESIGN covers exactly the fields the apply path really moves', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = snapshot(f.sqlite);
    await run(f.path, ['--apply', ...BASE_ARGS]);
    const now = snapshot(f.sqlite);
    const moved = Object.keys(before).filter(key => before[key] !== now[key]);
    for (const key of moved) {
      assert.ok(
        CHANGED_BY_DESIGN.has(key),
        `${key} changed but is not declared as changed by design`
      );
    }
    assert.ok(moved.length > 0);
  } finally {
    f.close();
  }
});

// ---- legacy concurrency: what the old worker can still do while the lease is held --------
//
// The legacy `acquireLease` (origin/main src/scheduler.ts) takes a lease row only when that
// row is free; for the dispatch lease (id 1) it additionally refuses while the deploy intent
// (id 3) is live. The INITIALIZATION lease (id 2) checks only row 2 and row 3 — it never
// reads row 1. So row 1 fences chunk CLAIMS (spend) but cannot fence admission, run init, or
// the reuse copy. These tests drive the real legacy SQL text to prove that, and prove that a
// cancelled state still cannot spend.

const LEGACY_ACQUIRE_SQL = `
  INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (?1, ?2, ?3)
  ON CONFLICT (id) DO UPDATE SET token = ?2, lease_until = ?3
  WHERE scheduler_dispatch_lock.lease_until <= ?4
    AND (?1 != ?5 OR NOT EXISTS (
      SELECT 1 FROM scheduler_dispatch_lock WHERE id = ?6 AND lease_until > ?4))
  RETURNING token
`;

function legacyAcquire(sqlite, id, token, until, now, dispatchId = 1, intentId = 3) {
  return (
    sqlite.prepare(LEGACY_ACQUIRE_SQL).all(id, token, until, now, dispatchId, intentId).length > 0
  );
}

test('the operator lease fences claims but provably not run initialization', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const now = Date.now();
    // The old dispatcher cannot take row 1: the operator lease is live.
    assert.equal(legacyAcquire(f.sqlite, 1, 'legacy-dispatch', now + 60_000, now), false);
    // The old initializer CAN take row 2 — it never consults row 1. This is the documented
    // admission gap: row 1 stops spend, not admission or chunk materialization.
    assert.equal(legacyAcquire(f.sqlite, 2, 'legacy-init', now + 60_000, now), true);
    const init = f.sqlite.prepare('SELECT token FROM scheduler_dispatch_lock WHERE id = 2').get();
    assert.equal(init.token, 'legacy-init');
    // Row 1 is untouched by that acquisition.
    assert.equal(
      f.sqlite.prepare('SELECT token FROM scheduler_dispatch_lock WHERE id = 1').get().token,
      OPERATOR
    );
  } finally {
    f.close();
  }
});

test('after cancel, a concurrently admitted run still cannot spend: no chunk is claimable', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    assert.equal((await run(f.path, ['--apply', ...BASE_ARGS])).code, EXIT.ok);
    // Old cron admits a fresh platform run and materializes chunks at the legacy revision.
    insertDeciderRun(f.sqlite, { id: 'run-late', startedAt: '2026-11-20T15:30:00.000Z' });
    insertProfile(f.sqlite, { model: 'vendor/late', status: 'running', runId: 'run-late' });
    insertChunk(f.sqlite, { runId: 'run-late', model: 'vendor/late', chunk: 0, status: 'pending' });
    // The scheduler's own claim statement: it takes row 1 first, and the operator lease
    // refuses. With no claim there is no container run and no paid inference.
    const now = Date.now();
    assert.equal(legacyAcquire(f.sqlite, 1, 'legacy-claim', now + 60_000, now), false);
    // The claim UPDATE in claimScheduledChunks also requires a row-1 token match, so even a
    // stale claim whose lease survived cannot flip a chunk to `queued`.
    const claimed = f.sqlite
      .prepare(
        `UPDATE scheduler_chunks SET status = 'queued', token = 'legacy', slot = 1,
           lease_until = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM scheduler_dispatch_lock WHERE id = 1 AND token = 'legacy')`
      )
      .run(now + 600_000, JSON.stringify(['run-late', 'vendor/late', 'high', 0, 0]));
    assert.equal(claimed.changes, 0, 'no chunk may be claimed without holding row 1');
    // The lane-head query the dispatcher uses also requires run.status = 'running' AND a
    // scheduler_runs marker; run-late has neither a marker nor a claim path.
    assert.equal(
      f.sqlite.prepare("SELECT status FROM benchmark_runs WHERE id='run-late'").get().status,
      'running'
    );
  } finally {
    f.close();
  }
});

test('a stale queue message for a cancelled chunk cannot start work', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    assert.equal((await run(f.path, ['--apply', ...BASE_ARGS])).code, EXIT.ok);
    // `startChunk` requires the chunk to be queued/active with an unexpired lease under a
    // RUNNING run. Every one of those is now false, so a redelivered message is a no-op.
    const now = Date.now();
    const started = f.sqlite
      .prepare(
        `UPDATE scheduler_chunks SET status = 'active', lease_until = ?
         WHERE id = ? AND token = ? AND status IN ('queued', 'active') AND lease_until > ?
           AND EXISTS (SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id
             AND status = 'running')`
      )
      .run(
        now + 600_000,
        JSON.stringify(['run-live-a', 'vendor/live-a', 'high', 0, 1]),
        'claim-token',
        now
      );
    assert.equal(started.changes, 0, 'a stale message must not start a cancelled chunk');
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status='active'").get().n,
      0
    );
  } finally {
    f.close();
  }
});

test('a run started AFTER the apply is still detected: no timestamp decides anything', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baselinePath = join(f.directory, 'baseline.json');
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    // The legacy writer stays able to admit a run with started_at far in the FUTURE — later
    // than any cutover instant the new worker might claim. A retirement rule keyed on
    // started_at < cutover_at would miss this row entirely.
    const future = new Date(Date.now() + 3600_000).toISOString();
    insertDeciderRun(f.sqlite, { id: 'run-future', startedAt: future });
    insertProfile(f.sqlite, { model: 'vendor/future', status: 'running', runId: 'run-future' });
    insertChunk(f.sqlite, {
      runId: 'run-future',
      model: 'vendor/future',
      chunk: 0,
      status: 'queued',
    });
    // --verify must refuse the deploy on CURRENT STATE alone.
    const refused = await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath]);
    assert.equal(refused.code, EXIT.verifyFailed);
    assert.ok(refused.last('verify_failed').failures.some(f => f.startsWith('running_runs=1')));
    // And --apply, which also reads live state, cancels it without knowing any timestamp.
    assert.equal(
      (await run(f.path, ['--apply', ...BASE_ARGS, '--baseline-out', baselinePath])).code,
      EXIT.ok
    );
    const row = f.sqlite
      .prepare("SELECT status, started_at FROM benchmark_runs WHERE id='run-future'")
      .get();
    assert.equal(row.status, 'failed');
    assert.equal(row.started_at, future, 'the original timestamp is preserved, only status moved');
    assert.equal(
      (await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baselinePath])).code,
      EXIT.ok
    );
  } finally {
    f.close();
  }
});

test('the script never reads a cutover, timestamp column or 0038 table', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    // Instrument every statement the script sends and assert none sorts on time or reads
    // the paid-cutover surface.
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const executor = createLocalExecutor(f.path);
    const seen = [];
    const wrapped = {
      read: sql => {
        seen.push(sql);
        return executor.read(sql);
      },
      write: statements => {
        seen.push(...statements);
        return executor.write(statements);
      },
      close: () => executor.close(),
    };
    const code = await runLegacyCancel({
      argv: ['--apply', ...BASE_ARGS, '--local-file', f.path],
      executor: wrapped,
      log: () => {},
    });
    assert.equal(code, EXIT.ok);
    assert.ok(seen.length > 5);
    for (const sql of seen) {
      // `benchmark_cutover` may only be PROBED for presence (the fail-closed post-cutover
      // detector). No paid-flow table or column may be read for data, and nothing from them
      // may be written.
      const cutoverProbe = sql.includes("type = 'table' AND name = 'benchmark_cutover'");
      const cutoverColumnProbe = sql.includes("pragma_table_info('benchmark_runs')");
      for (const forbidden of [
        'paid_benchmark_',
        'benchmark_case_runs',
        'benchmark_case_payers',
        'paid_model_requests',
        'profile_attempt_history',
        'admission_marker',
      ]) {
        if (forbidden === 'admission_marker' && cutoverColumnProbe) continue;
        assert.ok(!sql.includes(forbidden), `${forbidden} must never be read or written`);
      }
      if (sql.includes('benchmark_cutover') && !cutoverProbe) {
        assert.fail('benchmark_cutover may only be probed for presence, never read for data');
      }
      assert.doesNotMatch(sql, /SELECT[^;]*cutover_at[^;]*FROM benchmark_cutover/i);
      // No decision may be made from a clock or from a stored cutover instant. Comparing a
      // column to the fixed PARKED_REQUESTED_AT sentinel is allowed (it is not a clock), so
      // the ban is specifically on time functions and the cutover marker.
      assert.doesNotMatch(
        sql,
        /julianday\([^)]*\).*(<|>|<=|>=)|(started_at|requested_at|completed_at)\s*(<=|>=|<>|<|>)[^;]*(julianday|strftime|'now')/i,
        'no clock or cutover comparison may gate a decision'
      );
    }
  } finally {
    f.close();
  }
});

// ---- post-cutover refusal: the real 0038 schema must be untouchable -----------------------
//
// Every table the legacy cancel needs survives migration 0038, so nothing in the write path can
// tell the two schemas apart. Cancelling by `status = 'running'` would therefore take a run a user
// explicitly confirmed through the paid flow — a legitimate click under the hold. These tests
// migrate a REAL database through 0038, seed a marked run, and prove the script refuses without
// mutating a byte.

/** Apply every migration including 0038, i.e. the schema after the paid cutover. */
function migrateThroughCutover(sqlite) {
  for (const name of readdirSync(migrations)
    .filter(n => n.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const cutover = sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM pragma_table_info('benchmark_runs') WHERE name = 'admission_marker'"
    )
    .get();
  assert.equal(cutover.n, 1, 'migration 0038 must add benchmark_runs.admission_marker');
}

function cutoverFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-cancel-cutover-'));
  const path = join(directory, 'benchmark.sqlite');
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  migrateThroughCutover(sqlite);
  return {
    directory,
    path,
    sqlite,
    close() {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function seedPaidRun(sqlite, { id, marker = 'paid:req-1', status = 'running' }) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs (id, router, kind, status, started_at, min_accuracy,
         switch_cost_factor, best_accuracy_switch_threshold, max_concurrency, benchmark_user_id,
         benchmark_org_id, repetitions, engine_identity, purpose, measurement_revision,
         accuracy_noise_band, frontier_min_accuracy_delta, admission_marker)
       VALUES (?, 'efficient', 'decider', ?, '2026-11-20T16:00:00.000Z', 0.9, 1, 0.05, 250,
         'bench-user', 'bench-org', 1, ?, 'user', 3, 0.05, 0, ?)`
    )
    .run(id, status, ENGINE, marker);
  insertProfile(sqlite, { model: `vendor/${id}`, status: 'running', runId: id });
  insertChunk(sqlite, { runId: id, model: `vendor/${id}`, chunk: 0, status: 'pending' });
  insertChunk(sqlite, { runId: id, model: `vendor/${id}`, chunk: 1, status: 'queued' });
}

test('post-cutover: --apply refuses and mutates nothing while a paid run is live', async () => {
  const f = cutoverFixture();
  try {
    holdOperatorLease(f.sqlite);
    seedPaidRun(f.sqlite, { id: 'run-paid-1' });
    const payload = f.sqlite
      .prepare("SELECT *, 'x' AS untouched FROM benchmark_runs WHERE id = 'run-paid-1'")
      .get();
    const before = readAll(f.sqlite);

    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed, JSON.stringify(result.events));
    assert.match(result.last('verify_failed').reason, /post-cutover/);
    assert.deepEqual(readAll(f.sqlite), before, 'a refused apply must not write');
    assert.deepEqual(
      {
        ...f.sqlite
          .prepare("SELECT *, 'x' AS untouched FROM benchmark_runs WHERE id = 'run-paid-1'")
          .get(),
      },
      { ...payload }
    );
    // The legitimate user click is still running, with its chunks still queued/pending.
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running' AND admission_marker IS NOT NULL"
        )
        .get().n,
      1
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('pending','queued','active')"
        )
        .get().n,
      2
    );
  } finally {
    f.close();
  }
});

test('post-cutover: --dry-run and --verify also refuse, and never write', async () => {
  const f = cutoverFixture();
  try {
    holdOperatorLease(f.sqlite);
    seedPaidRun(f.sqlite, { id: 'run-paid-1' });
    const baseline = join(f.directory, 'baseline.json');
    const before = readAll(f.sqlite);
    for (const argv of [
      ['--dry-run', ...BASE_ARGS],
      ['--verify', ...BASE_ARGS, '--baseline', baseline],
    ]) {
      const result = await run(f.path, argv);
      assert.equal(
        result.code,
        EXIT.verifyFailed,
        `${argv[0]} must refuse: ${JSON.stringify(result.events)}`
      );
      assert.match(result.last('verify_failed').reason, /post-cutover/);
      assert.deepEqual(readAll(f.sqlite), before);
    }
    // No baseline was produced by a refused run.
    assert.equal(existsSync(baseline), false);
  } finally {
    f.close();
  }
});

test('post-cutover: the cutover column alone is enough, even with no cutover row yet', async () => {
  const f = cutoverFixture();
  try {
    holdOperatorLease(f.sqlite);
    // 0038 adds the column; the cutover row is claimed only by the first new-worker pass.
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_cutover').get().n, 0);
    f.sqlite.exec('DROP TABLE benchmark_cutover');
    seedPaidRun(f.sqlite, { id: 'run-paid-1' });
    const before = readAll(f.sqlite);
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /admission_marker=1/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('post-cutover: --legacy-residue is read-only and diffs legacy from paid work', async () => {
  const f = cutoverFixture();
  try {
    holdOperatorLease(f.sqlite);
    seedPaidRun(f.sqlite, { id: 'run-paid-1' });
    // A legacy run that survived the cutover: unmarked, still running, with runnable chunks.
    f.sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, status, started_at, min_accuracy,
           switch_cost_factor, best_accuracy_switch_threshold, max_concurrency, benchmark_user_id,
           benchmark_org_id, repetitions, engine_identity, purpose, measurement_revision,
           accuracy_noise_band, frontier_min_accuracy_delta)
         VALUES ('run-legacy-1','efficient','decider','running','2026-11-20T06:00:00.000Z',0.9,1,0.05,250,
           'bench-user','bench-org',1,?, 'platform',3,0.05,0)`
      )
      .run(ENGINE);
    insertChunk(f.sqlite, {
      runId: 'run-legacy-1',
      model: 'vendor/legacy',
      chunk: 0,
      status: 'pending',
    });
    const before = readAll(f.sqlite);

    const result = await run(f.path, ['--legacy-residue', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed, 'unexpected legacy work must fail the check');
    const residue = result.last('legacy_residue');
    assert.equal(residue.legacy_running_runs, 1);
    assert.equal(residue.legacy_unfinished_chunks, 1);
    assert.equal(residue.paid_running_runs, 1);
    assert.equal(residue.paid_unfinished_chunks, 2);
    assert.match(
      result.last('legacy_residue_unexpected').action,
      /do not re-run the legacy cancel/
    );
    assert.deepEqual(readAll(f.sqlite), before, 'the residue report must never write');

    // With the legacy run retired, only the expected paid run remains, and the check passes.
    f.sqlite.prepare("UPDATE benchmark_runs SET status='failed' WHERE id='run-legacy-1'").run();
    f.sqlite
      .prepare("UPDATE scheduler_chunks SET status='completed' WHERE run_id='run-legacy-1'")
      .run();
    const clean = await run(f.path, ['--legacy-residue', ...BASE_ARGS]);
    assert.equal(clean.code, EXIT.ok, JSON.stringify(clean.events));
    assert.equal(
      clean.last('legacy_residue').paid_running_runs,
      1,
      'a user click is expected, not cancelled'
    );
    assert.equal(clean.last('legacy_residue_ok').action, 'none');
  } finally {
    f.close();
  }
});

test('post-cutover: --legacy-residue is refused on a pre-cutover database', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const before = readAll(f.sqlite);
    const result = await run(f.path, ['--legacy-residue', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /pre-cutover/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('the pre-cutover fixture is unaffected: the guard does not fire on 0037', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const [probe] = f.sqlite
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='benchmark_cutover') AS cutover_table,
                (SELECT COUNT(*) FROM pragma_table_info('benchmark_runs') WHERE name='admission_marker') AS cutover_column`
      )
      .all();
    assert.equal(probe.cutover_table, 0);
    assert.equal(probe.cutover_column, 0);
    const result = await run(f.path, ['--apply', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.ok, JSON.stringify(result.events));
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
  } finally {
    f.close();
  }
});
