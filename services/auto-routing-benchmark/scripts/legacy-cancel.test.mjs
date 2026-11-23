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
  LEAN_MAX_SCOPED_ROWS,
  LEAN_SUMMED_FIELDS,
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
    // Two runs × (park, flip) plus one global sweep of three statements.
    assert.equal(result.lines.filter(line => line.startsWith('UPDATE ')).length, 7);
    assert.equal(result.last('dry_run_ok').statements, 7);
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
    insertProfile(f.sqlite, { model: 'vendor/orphan', status: 'running', runId: 'run-done-b' });

    const before = snapshot(f.sqlite);
    assert.equal(before.running_runs, 0, 'precondition: no live run to cancel');
    assert.ok(before.unfinished_chunks > 0, 'precondition: an unfinished chunk survives');
    assert.equal(before.running_profiles, 1);

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
    const parked = f.sqlite
      .prepare(
        "SELECT status, run_id, requested_at FROM benchmark_profiles WHERE model = 'vendor/orphan'"
      )
      .get();
    assert.deepEqual(
      { ...parked },
      { status: 'pending', run_id: null, requested_at: PARKED_REQUESTED_AT }
    );
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
    // A classifier run admitted after the cutover: it carries the marker, so the kind-agnostic
    // legacy predicate must not report it as work to cancel.
    f.sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, status, started_at, min_accuracy,
           switch_cost_factor, best_accuracy_switch_threshold, max_concurrency, benchmark_user_id,
           benchmark_org_id, repetitions, engine_identity, purpose, measurement_revision,
           accuracy_noise_band, frontier_min_accuracy_delta, admission_marker)
         VALUES ('run-classifier-1','efficient','classifier','running','2026-11-20T06:30:00.000Z',
           0.9,1,0.05,250,'bench-user','bench-org',1,?, 'platform',3,0.05,0,?)`
      )
      .run(ENGINE, 'paid:req-classifier');
    insertChunk(f.sqlite, {
      runId: 'run-classifier-1',
      model: 'vendor/classifier',
      chunk: 0,
      status: 'pending',
    });
    const before = readAll(f.sqlite);

    const result = await run(f.path, ['--legacy-residue', ...BASE_ARGS]);
    assert.equal(result.code, EXIT.verifyFailed, 'unexpected legacy work must fail the check');
    const residue = result.last('legacy_residue');
    assert.equal(residue.legacy_running_runs, 1);
    assert.equal(residue.legacy_unfinished_chunks, 1);
    assert.equal(residue.paid_running_runs, 2);
    assert.equal(residue.paid_unfinished_chunks, 3);
    assert.match(
      result.last('legacy_residue_unexpected').action,
      /do not re-run the legacy cancel/
    );
    assert.deepEqual(readAll(f.sqlite), before, 'the residue report must never write');

    // With the legacy run retired, only the marked runs remain, and the check passes.
    f.sqlite.prepare("UPDATE benchmark_runs SET status='failed' WHERE id='run-legacy-1'").run();
    f.sqlite
      .prepare("UPDATE scheduler_chunks SET status='completed' WHERE run_id='run-legacy-1'")
      .run();
    const clean = await run(f.path, ['--legacy-residue', ...BASE_ARGS]);
    assert.equal(clean.code, EXIT.ok, JSON.stringify(clean.events));
    assert.equal(
      clean.last('legacy_residue').paid_running_runs,
      2,
      'admitted decider and classifier runs are expected, not cancelled'
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

// ---- bounded remote path: scope guards, chunkless live, closed current intact --------------
//
// The live path must never digest all history. These tests drive the bounded digest through the
// same code the `--remote` transport uses, and prove every fail-closed guard.

const leanArgs = (mode, path, extra = []) => [mode, ...BASE_ARGS, '--local-file', path, ...extra];

/** An executor that behaves like the live transport (lean) over a local SQLite file. */
async function leanRun(path, argv) {
  const { createLocalExecutor } = await import('./legacy-cancel.mjs');
  const inner = createLocalExecutor(path);
  const lines = [];
  const executor = {
    lean: true,
    plan: inner.plan,
    read: inner.read,
    write: inner.write,
    close: inner.close,
  };
  const code = await runLegacyCancel({ argv, executor, log: line => lines.push(line) });
  const events = lines
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .map(event => ({ ...event, event: event.event.slice('legacy_cancel_'.length) }));
  return { code, lines, events, last: name => events.filter(e => e.event === name).at(-1) };
}

function seedPublished(sqlite, { runId, publishedAt, tableRun = null }) {
  sqlite
    .prepare(
      `INSERT INTO routing_tables (run_id, router, published_at, generated_at, min_accuracy,
         switch_cost_factor, best_accuracy_switch_threshold, source)
       VALUES (?, 'efficient', ?, ?, 0.9, 1, 0.05, 'platform')`
    )
    .run(tableRun ?? runId, publishedAt, publishedAt);
  sqlite
    .prepare(
      `INSERT INTO routing_table_candidates (run_id, route_key, rank, model, accuracy,
         avg_cost_usd, meets_threshold)
       VALUES (?, 'route/a', 0, 'vendor/done', 0.81, 0.01, 1)`
    )
    .run(tableRun ?? runId);
}

test('the bounded publication lookup includes a republished older row', async () => {
  const { scopePublishedSql } = await import('./legacy-cancel.mjs');
  const f = fixture();
  try {
    seedPublished(f.sqlite, { runId: 'older-row', publishedAt: '2026-11-19T00:00:00.000Z' });
    seedPublished(f.sqlite, { runId: 'newer-row', publishedAt: '2026-11-20T00:00:00.000Z' });
    f.sqlite
      .prepare("UPDATE routing_tables SET published_at = ? WHERE run_id = 'older-row'")
      .run('2026-11-21T00:00:00.000Z');
    const publication = f.sqlite
      .prepare(scopePublishedSql())
      .all()
      .find(row => row.router === 'efficient');
    assert.equal(publication.run_id, 'older-row');
    assert.equal(publication.history_rows, 2);
  } finally {
    f.close();
  }
});

test('oversized publication history stops before legacy cancellation', async () => {
  const { LEAN_MAX_PUBLICATIONS } = await import('./legacy-cancel.mjs');
  const f = fixture();
  try {
    seed(f.sqlite);
    f.sqlite
      .prepare(
        `WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
         INSERT INTO routing_tables (run_id, router, published_at, generated_at, min_accuracy,
           switch_cost_factor, best_accuracy_switch_threshold, source)
         SELECT 'old-' || n, 'efficient', '2026-11-19', '2026-11-19', 0.9, 1, 0.05, 'platform'
           FROM rows`
      )
      .run(LEAN_MAX_PUBLICATIONS + 1);
    const before = snapshot(f.sqlite);
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /publication history exceeds/);
    assert.deepEqual(snapshot(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('bounded remote path never reads the full-history digest', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    const seen = [];
    const executor = {
      lean: true,
      plan: inner.plan,
      read: sql => {
        seen.push(sql);
        return inner.read(sql);
      },
      write: statements => {
        seen.push(...statements);
        return inner.write(statements);
      },
      close: inner.close,
    };
    const code = await runLegacyCancel({
      argv: leanArgs('--apply', f.path),
      executor,
      log: () => {},
    });
    assert.equal(code, EXIT.ok);
    assert.ok(seen.length > 3);
    for (const sql of seen) {
      // The exhaustive digest's tell is its whole-history correlated EXISTS over case_results.
      assert.ok(
        !/FROM case_results AS row WHERE EXISTS/.test(sql),
        'the live path must never run the full-history artifact digest'
      );
      assert.ok(!/FROM scheduler_chunks AS chunk\) AS chunk_attempts/.test(sql));
    }
    // Every case_results / model_summaries reference is scoped by a run_id key.
    for (const sql of seen.filter(s => /FROM case_results|FROM model_summaries/.test(s))) {
      assert.match(sql, /run_id/, 'a history table must be reached through run_id');
    }
  } finally {
    f.close();
  }
});

test('a hostile number of running runs is refused before any write', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    // Overrun the documented cap.
    const { LEAN_MAX_RUNS } = await import('./legacy-cancel.mjs');
    for (let i = 0; i < LEAN_MAX_RUNS + 1; i += 1) {
      insertDeciderRun(f.sqlite, {
        id: `run-overrun-${i}`,
        startedAt: `2026-11-1${i % 10}T00:00:00.000Z`,
      });
    }
    const before = readAll(f.sqlite);
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /refusing a bounded verification over/);
    assert.deepEqual(readAll(f.sqlite), before, 'a refused scope must not write');
  } finally {
    f.close();
  }
});

test('a split run whose model group is still over the envelope is refused before any write', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { LEAN_MAX_SCOPED_ROWS } = await import('./legacy-cancel.mjs');
    // One live run carrying more scoped rows than the envelope allows, all under ONE model:
    // the model split cannot shrink it, so it must refuse rather than widen the cap.
    const bulk = f.sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
         cost_usd, error, rep, timed_out, prompt_revision)
       VALUES ('run-live-a', 'vendor/seed', 'high', ?, 'route/a', 1, 10, 0, NULL, 0, 0, 3)`
    );
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < LEAN_MAX_SCOPED_ROWS + 1; i += 1) bulk.run(`bulk-${i}`);
    f.sqlite.exec('COMMIT');
    const before = readAll(f.sqlite);
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /cannot be split below the bounded envelope/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('a run too large to enumerate is refused before any read of its history', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { LEAN_MAX_SPLIT_ROWS } = await import('./legacy-cancel.mjs');
    const bulk = f.sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
         cost_usd, error, rep, timed_out, prompt_revision)
       VALUES ('run-live-a', ?, 'high', ?, 'route/a', 1, 10, 0, NULL, 0, 0, 3)`
    );
    f.sqlite.exec('BEGIN');
    // Spread across models so the split itself would be admissible; only the size refuses.
    for (let i = 0; i < LEAN_MAX_SPLIT_ROWS + 1; i += 1) bulk.run(`vendor/m${i % 4}`, `bulk-${i}`);
    f.sqlite.exec('COMMIT');
    const before = readAll(f.sqlite);
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /refusing to enumerate a run that large/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('a split enumerates models from every scoped table, not just case_results', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    // One live run whose scoped rows sit almost entirely in `scheduler_executions`: production has
    // a running run with 54,661 of them. Enumerating `case_results` alone would see one model and
    // refuse (its 60,000 execution rows land in the `NOT IN` complement), or mis-split.
    const insert = f.sqlite.prepare(
      `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token)
       VALUES ('run-live-b', ?, 'high', 0, ?, 'exec-token')`
    );
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < 60_000; i += 1) {
      insert.run(i % 2 === 0 ? 'vendor/exec-a' : 'vendor/exec-b', `exec-case-${i}`);
    }
    f.sqlite.exec('COMMIT');
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM case_results WHERE run_id = 'run-live-b'").get().n,
      1,
      'the fixture must keep graded results (and their models) out of the bulk'
    );

    const baseline = join(f.directory, 'baseline.json');
    const applied = await leanRun(
      f.path,
      leanArgs('--apply', f.path, ['--baseline-out', baseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    const scope = applied.last('lean_scope');
    const cancelled = scope.batches.filter(batch => batch.kind === 'cancelled');
    assert.ok(cancelled.length > 1, 'the executions-heavy run must split into several batches');
    for (const batch of cancelled) {
      assert.ok(
        batch.rows <= LEAN_MAX_SCOPED_ROWS,
        `batch ${JSON.stringify(batch)} exceeds the cap`
      );
    }
    // The execution rows are protected history: the apply must not remove any.
    assert.equal(
      f.sqlite
        .prepare("SELECT COUNT(*) n FROM scheduler_executions WHERE run_id='run-live-b'")
        .get().n,
      60_000
    );
    // And verify accepts it: the same batches are re-sized and re-digested.
    const verified = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(verified.code, EXIT.ok, JSON.stringify(verified.events));
  } finally {
    f.close();
  }
});

test('the model enumeration reads every scoped table through run_id within D1 limits', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const {
      createLocalExecutor,
      scopeRunModelsSql,
      assertLeanPlan,
      compoundTermCount,
      D1_MAX_COMPOUND_TERMS,
    } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    const tables = [
      'case_results',
      'model_summaries',
      'scheduler_chunks',
      'run_lane_failures',
      'scheduler_executions',
      'pending_decider_outputs',
    ];
    const seen = new Set();
    let seeks = 0;
    for (const part of [0, 1]) {
      const sql = scopeRunModelsSql('run-live-a', part);
      // D1 caps a compound statement at five SELECT terms; six tables must not be one UNION.
      assert.ok(
        compoundTermCount(sql) <= D1_MAX_COMPOUND_TERMS,
        `part ${part} has ${compoundTermCount(sql)} compound terms`
      );
      // Each part is itself capped, so one run cannot stream an unbounded model set.
      assert.match(
        sql,
        /GROUP BY model ORDER BY[\s\S]*LIMIT \d+/,
        `part ${part} must cap its rows`
      );
      for (const table of tables) {
        if (new RegExp(`FROM ${table} AS `).test(sql)) seen.add(table);
      }
      const plan = await assertLeanPlan({ plan: s => inner.plan(s) }, sql);
      // Every branch is a run_id seek; nothing reads a history table by another key.
      seeks += plan.filter(line => /^SEARCH /.test(line) && /run_id=\?/.test(line)).length;
    }
    assert.deepEqual([...seen].sort(), [...tables].sort(), 'every table must be enumerated');
    assert.equal(seeks, 6, 'six keyed seeks across the two parts');
    inner.close();
  } finally {
    f.close();
  }
});

test('more than 64 models refuse, and no part transfers more than 65 distinct models', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const {
      createLocalExecutor,
      scopeRunModelsSql,
      LEAN_MAX_MODEL_GROUPS,
      LEAN_MAX_SCOPED_ROWS,
      LEAN_MAX_SPLIT_ROWS,
    } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    // The run must really NEED a split (over the per-batch envelope) before the model count is
    // consulted, so it carries enough rows to exceed `LEAN_MAX_SCOPED_ROWS` while staying under
    // the enumeration ceiling. Models are spread across BOTH parts, and two appear in both.
    const shared = ['vendor/shared-a', 'vendor/shared-b'];
    const part0Only = Array.from({ length: 40 }, (_, i) => `vendor/p0-${i}`);
    const part1Only = Array.from({ length: 40 }, (_, i) => `vendor/p1-${i}`);
    const all = [...shared, ...part0Only, ...part1Only];
    assert.ok(all.length > LEAN_MAX_MODEL_GROUPS, 'the fixture must exceed the model cap');
    const reps = 700;
    // Both parts must saturate at the cap, so every model appears in a part-0 table AND a part-1
    // table; otherwise the part that returned fewer rows would prove nothing about its limit.
    const total = all.length * reps * 2;
    assert.ok(all.length * reps > LEAN_MAX_SCOPED_ROWS, 'the fixture must need a split');
    assert.ok(total < LEAN_MAX_SPLIT_ROWS, 'the fixture must stay under the enumeration ceiling');

    const caseInsert = f.sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
         cost_usd, error, rep, timed_out, prompt_revision)
       VALUES ('run-live-a', ?, 'high', ?, 'route/a', 1, 10, 0, NULL, 0, 0, 3)`
    );
    const execInsert = f.sqlite.prepare(
      `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token)
       VALUES ('run-live-a', ?, 'high', 0, ?, 'exec-token')`
    );
    f.sqlite.exec('BEGIN');
    all.forEach((model, i) => {
      // part 0 table: `case_results`. part 1 table: `scheduler_executions`.
      for (let rep = 0; rep < reps; rep += 1) {
        caseInsert.run(model, `c-${i}-${rep}`);
        execInsert.run(model, `e-${i}-${rep}`);
      }
    });
    f.sqlite.exec('COMMIT');

    // Each part is capped independently: at most cap+1 DISTINCT models per statement.
    for (const part of [0, 1]) {
      const rows = inner.read(scopeRunModelsSql('run-live-a', part));
      assert.equal(
        rows.length,
        LEAN_MAX_MODEL_GROUPS + 1,
        `part ${part} must stop at the ${LEAN_MAX_MODEL_GROUPS + 1}-row cap, got ${rows.length}`
      );
      // The cap is on distinct models, so a capped part cannot hide duplicates behind it.
      assert.equal(new Set(rows.map(row => String(row.model))).size, rows.length);
    }

    // The merged count still refuses: shared models must not collapse the total below 65.
    const caseCount = f.sqlite
      .prepare("SELECT COUNT(*) n FROM case_results WHERE run_id='run-live-a'")
      .get().n;
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed, JSON.stringify(result.events));
    assert.match(
      result.last('verify_failed').reason,
      /more than 64 model groups; refusing to split it further/
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM case_results WHERE run_id='run-live-a'").get().n,
      caseCount,
      'a refused enumeration must not write'
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM benchmark_runs WHERE status='running'").get().n,
      2,
      'no run may be cancelled by a refused enumeration'
    );

    inner.close();
  } finally {
    f.close();
  }
});

test('a model in both parts cannot hide the 65th, so the merge still refuses', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor, scopeRunModelsSql, LEAN_MAX_MODEL_GROUPS, LEAN_MAX_SCOPED_ROWS } =
      await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    // Exactly cap+1 distinct models, ALL of them present in BOTH parts, and enough rows to need a
    // split. A merge that counted rows would double the total; one that deduplicated to the part
    // cap could see only 64. Either way the boundary must still refuse.
    const models = Array.from({ length: LEAN_MAX_MODEL_GROUPS + 1 }, (_, i) => `vendor/both-${i}`);
    const reps = 800;
    assert.ok(models.length * reps > LEAN_MAX_SCOPED_ROWS, 'the fixture must need a split');

    const caseInsert = f.sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
         cost_usd, error, rep, timed_out, prompt_revision)
       VALUES ('run-live-a', ?, 'high', ?, 'route/a', 1, 10, 0, NULL, 0, 0, 3)`
    );
    const execInsert = f.sqlite.prepare(
      `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token)
       VALUES ('run-live-a', ?, 'high', 0, ?, 'exec-token')`
    );
    f.sqlite.exec('BEGIN');
    models.forEach((model, i) => {
      for (let rep = 0; rep < reps; rep += 1) {
        caseInsert.run(model, `c-${i}-${rep}`);
        execInsert.run(model, `e-${i}-${rep}`);
      }
    });
    f.sqlite.exec('COMMIT');

    const partRows = [0, 1].map(part => inner.read(scopeRunModelsSql('run-live-a', part)));
    // Both parts saturate at cap+1, so the union is provably at least cap+1 distinct models: a
    // part returning the full cap cannot be hiding extra models behind a duplicate.
    for (const rows of partRows) {
      assert.equal(rows.length, LEAN_MAX_MODEL_GROUPS + 1, 'a part exceeded its own cap');
      assert.equal(new Set(rows.map(row => String(row.model))).size, rows.length);
    }
    const union = new Set(partRows.flatMap(rows => rows.map(row => String(row.model))));
    assert.equal(union.size, LEAN_MAX_MODEL_GROUPS + 1);

    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.verifyFailed, JSON.stringify(result.events));
    assert.match(result.last('verify_failed').reason, /more than 64 model groups/);
    inner.close();
  } finally {
    f.close();
  }
});

// ---- batched bounded path: a scope whose history exceeds the per-batch envelope ------------
//
// Production has two live runs owning ~94k case results, so one run alone is larger than
// `LEAN_MAX_SCOPED_ROWS`. The batched verifier must reach the same end state and the same
// protected digests as the exhaustive one, keep every batch under the envelope, and still
// refuse a mutation in any single batch.

/**
 * Add `rows` graded results to `runId`, spread over `models`, so no single model group is a
 * history-sized read. Each row is unique on the scoped primary key.
 */
function bulkResults(sqlite, { runId, rows, models, score = 0.5, prefix = 'bulk' }) {
  const insert = sqlite.prepare(
    `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
       cost_usd, error, rep, timed_out, prompt_revision)
     VALUES (?, ?, 'high', ?, 'route/a', ?, 10, 0.001, NULL, 0, 0, 3)`
  );
  sqlite.exec('BEGIN');
  for (let i = 0; i < rows; i += 1) {
    insert.run(runId, models[i % models.length], `${prefix}-${i}`, score);
  }
  sqlite.exec('COMMIT');
}

/**
 * Replace the two timestamps the operation stamps with the DATABASE clock, so two otherwise
 * identical databases can be compared: `benchmark_profiles.updated_at` (the park statement) and
 * `benchmark_runs.completed_at` (the flip). Every other column is compared as stored.
 */
function normalizeClock(dump) {
  return {
    ...dump,
    benchmark_profiles: dump.benchmark_profiles.map(row =>
      row.status === 'pending' ? { ...row, updated_at: '<clock>' } : row
    ),
    benchmark_runs: dump.benchmark_runs.map(row =>
      row.status === 'failed' && row.error === CANCEL_ERROR
        ? { ...row, completed_at: '<clock>' }
        : row
    ),
    // The lease horizon is wall-clock at seed time; two fixtures never share it.
    scheduler_dispatch_lock: dump.scheduler_dispatch_lock.map(row => ({
      ...row,
      lease_until: '<clock>',
    })),
  };
}

/** A seeded fixture whose first live run owns more scoped rows than one batch may read. */
function oversizedFixture() {
  const f = fixture();
  seed(f.sqlite);
  bulkResults(f.sqlite, {
    runId: 'run-live-a',
    rows: LEAN_MAX_SCOPED_ROWS + 20_000,
    models: ['vendor/bulk-a', 'vendor/bulk-b', 'vendor/bulk-c'],
  });
  return f;
}

test('a scope above the envelope is batched, and every batch stays under the cap', async () => {
  const f = oversizedFixture();
  try {
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.ok, JSON.stringify(result.events));
    const scope = result.last('lean_scope');
    assert.ok(scope.batches.length > 2, 'the oversized run must be split into several batches');
    for (const batch of scope.batches) {
      assert.ok(
        batch.rows <= LEAN_MAX_SCOPED_ROWS,
        `batch ${JSON.stringify(batch)} exceeds the cap`
      );
    }
    // Nothing live remains, and the cancelled run is terminal with the marker.
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM scheduler_chunks WHERE status IN ('pending','queued','active')"
        )
        .get().n,
      0
    );
  } finally {
    f.close();
  }
});

test('batched apply and verify reach the same end state as one exhaustive run', async () => {
  const batched = oversizedFixture();
  const exhaustive = oversizedFixture();
  try {
    const batchedBaseline = join(batched.directory, 'baseline.json');
    const applied = await leanRun(
      batched.path,
      leanArgs('--apply', batched.path, ['--baseline-out', batchedBaseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    const verified = await leanRun(
      batched.path,
      leanArgs('--verify', batched.path, ['--baseline', batchedBaseline])
    );
    assert.equal(verified.code, EXIT.ok, JSON.stringify(verified.events));

    // The isolated transport keeps the exhaustive digest, so it is the reference.
    const reference = await run(exhaustive.path, ['--apply', ...BASE_ARGS]);
    assert.equal(reference.code, EXIT.ok, JSON.stringify(reference.events));

    // Row-for-row equality over every table the operation may touch: a stronger claim than
    // comparing two digests produced by different segmentation. The two columns the operation
    // stamps with the CURRENT clock are excluded; every other field, including every historical
    // timestamp, must match exactly.
    assert.deepEqual(
      normalizeClock(readAll(batched.sqlite)),
      normalizeClock(readAll(exhaustive.sqlite))
    );
    // Every field of the batched digest must equal an INDEPENDENTLY computed value: the summed
    // fields from plain SQL over the final database, the scope-free counters from plain SQL, and
    // the served artifact from the exhaustive digest of an identical fixture. Nothing is skipped,
    // so a field the bounded digest fails to fill in (a dropped `LEAN_SUMMED_FIELDS` entry leaves
    // the global batch's literal zero) fails here instead of passing a self-consistent compare.
    const batchedDigest = applied.last('after');
    const one = sql => ({ ...batched.sqlite.prepare(sql).get() });
    const cancelledWhere = "run_id IN ('run-live-a','run-live-b')";
    const sum = (field, sql) => ({ field, sql, value: one(sql).v });

    // The additive set the module must know about, listed here by hand: deriving it from
    // `LEAN_SUMMED_FIELDS` would make the check agree with any mutation.
    const SUMMED_FIELDS = [
      'cancelled_case_results_n',
      'cancelled_case_results_score',
      'cancelled_case_results_timeouts',
      'cancelled_summaries_n',
      'cancelled_chunks_n',
      'cancelled_chunk_attempts',
      'cancelled_lane_failures_n',
      'cancelled_executions_n',
      'cancelled_pending_outputs_n',
    ];
    assert.deepEqual(
      [...LEAN_SUMMED_FIELDS].sort(),
      [...SUMMED_FIELDS].sort(),
      'LEAN_SUMMED_FIELDS must cover exactly the additive digest fields'
    );

    const summed = [
      sum(
        'cancelled_case_results_n',
        `SELECT COUNT(*) v FROM case_results WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_case_results_score',
        `SELECT COALESCE(TOTAL(score),0) v FROM case_results WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_case_results_timeouts',
        `SELECT COALESCE(SUM(COALESCE(timed_out,0)),0) v FROM case_results WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_summaries_n',
        `SELECT COUNT(*) v FROM model_summaries WHERE ${cancelledWhere}`
      ),
      sum('cancelled_chunks_n', `SELECT COUNT(*) v FROM scheduler_chunks WHERE ${cancelledWhere}`),
      sum(
        'cancelled_chunk_attempts',
        `SELECT COALESCE(TOTAL(attempts),0) v FROM scheduler_chunks WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_lane_failures_n',
        `SELECT COUNT(*) v FROM run_lane_failures WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_executions_n',
        `SELECT COUNT(*) v FROM scheduler_executions WHERE ${cancelledWhere}`
      ),
      sum(
        'cancelled_pending_outputs_n',
        `SELECT COUNT(*) v FROM pending_decider_outputs WHERE ${cancelledWhere}`
      ),
    ];
    // The scope-free counters, compared literally: after the cancel none of the live-work ones
    // may be non-zero, and every protected one is what the tables say.
    const globals = [
      sum('running_runs', `SELECT COUNT(*) v FROM benchmark_runs WHERE status='running'`),
      sum(
        'unfinished_chunks',
        `SELECT COUNT(*) v FROM scheduler_chunks WHERE status IN ('pending','queued','active')`
      ),
      sum('pending_chunks', `SELECT COUNT(*) v FROM scheduler_chunks WHERE status='pending'`),
      sum('queued_chunks', `SELECT COUNT(*) v FROM scheduler_chunks WHERE status='queued'`),
      sum('active_chunks', `SELECT COUNT(*) v FROM scheduler_chunks WHERE status='active'`),
      sum('running_profiles', `SELECT COUNT(*) v FROM benchmark_profiles WHERE status='running'`),
      sum('pending_profiles', `SELECT COUNT(*) v FROM benchmark_profiles WHERE status='pending'`),
      sum('ready_profiles', `SELECT COUNT(*) v FROM benchmark_profiles WHERE status='ready'`),
      sum('failed_profiles', `SELECT COUNT(*) v FROM benchmark_profiles WHERE status='failed'`),
      sum(
        'platform_requested_sum',
        `SELECT COALESCE(SUM(platform_requested),0) v FROM benchmark_profiles`
      ),
      sum('user_requested_sum', `SELECT COALESCE(SUM(user_requested),0) v FROM benchmark_profiles`),
      sum('remeasures_n', `SELECT COUNT(*) v FROM profile_remeasures`),
      sum(
        'remeasure_claims_n',
        `SELECT COUNT(*) v FROM profile_remeasures WHERE run_id IS NOT NULL`
      ),
      sum('subscriptions_n', `SELECT COUNT(*) v FROM benchmark_subscriptions`),
      sum('probe_activations_n', `SELECT COUNT(*) v FROM probe_activations`),
    ];
    // The served artifact is per-run, so it is taken from the exhaustive digest of the identical
    // fixture rather than re-derived (the field names differ between the two digests).
    const referenceDigest = reference.last('after');
    const SERVED_EQUIVALENT = {
      served_case_results_n: 'case_results_n',
      served_case_results_score: 'case_results_score',
      served_case_results_cost: 'case_results_cost',
      served_case_results_latency: 'case_results_latency',
      served_case_results_timeouts: 'case_results_timeouts',
      served_case_results_error_length: 'case_results_error_length',
      served_case_results_key_length: 'case_results_key_length',
      served_summaries_n: 'summaries_n',
      served_summaries_accuracy: 'summaries_accuracy',
      served_summaries_cases: 'summaries_cases',
      served_routing_signature: 'routing_tables_signature',
      served_candidates_n: 'candidates_n',
      served_candidates_accuracy: 'candidates_accuracy',
      served_candidates_cost: 'candidates_cost',
    };
    const served = Object.entries(SERVED_EQUIVALENT).map(([field, source]) => {
      assert.ok(source in referenceDigest, `the exhaustive digest is missing ${source}`);
      return { field, value: referenceDigest[source] };
    });

    const checked = new Set();
    for (const { field, value } of [...summed, ...globals, ...served]) {
      assert.ok(field in batchedDigest, `the bounded digest is missing ${field}`);
      checked.add(field);
      const actual = batchedDigest[field];
      if (typeof value === 'number' && !Number.isInteger(value)) {
        assert.ok(
          Math.abs(Number(actual) - Number(value)) < 1e-6,
          `${field}: batched ${actual} != independent ${value}`
        );
      } else {
        assert.equal(
          String(actual),
          String(value),
          `${field}: batched ${actual} != independent ${value}`
        );
      }
    }
    // No field may escape the check: an unlisted key means this test stopped covering the digest.
    // `event` is the harness envelope key, not a digest field.
    const unchecked = Object.keys(batchedDigest).filter(
      field => field !== 'event' && !checked.has(field)
    );
    assert.deepEqual(unchecked, [], 'every bounded digest field must be compared');
    assert.ok(
      Number(batchedDigest.cancelled_case_results_n) >= LEAN_MAX_SCOPED_ROWS,
      'the equivalence fixture must really span more than one batch'
    );
  } finally {
    batched.close();
    exhaustive.close();
  }
});

test('a mutation confined to the first batch fails batched verify', async () => {
  const f = oversizedFixture();
  try {
    const baseline = join(f.directory, 'baseline.json');
    const applied = await leanRun(
      f.path,
      leanArgs('--apply', f.path, ['--baseline-out', baseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));
    const first = saved.scope.batches.find(batch => batch.kind === 'cancelled');
    assert.ok(first, 'the baseline must record its cancelled batches');

    // Protected data inside the FIRST cancelled batch: one graded result lost its score.
    const [model] = first.segments.find(segment => segment.models).models;
    const runId = first.segments[0].runIds[0];
    f.sqlite
      .prepare(
        `UPDATE case_results SET score = score - 0.25
         WHERE rowid IN (SELECT rowid FROM case_results
                         WHERE run_id = ? AND model = ? LIMIT 1)`
      )
      .run(runId, model);

    const result = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(JSON.stringify(result.last('verify_failed')), /cancelled_case_results_score/);
  } finally {
    f.close();
  }
});

test('a mutation confined to the last batch fails batched verify', async () => {
  const f = oversizedFixture();
  try {
    const baseline = join(f.directory, 'baseline.json');
    const applied = await leanRun(
      f.path,
      leanArgs('--apply', f.path, ['--baseline-out', baseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));
    const cancelledBatches = saved.scope.batches.filter(batch => batch.kind === 'cancelled');
    const last = cancelledBatches.at(-1);
    assert.ok(last, 'the baseline must record its cancelled batches');

    // A run in the LAST batch becomes live again while the lease still holds: verify must
    // refuse even though every other batch is unchanged.
    const runId = last.segments.at(-1).runIds[0];
    f.sqlite.prepare("UPDATE benchmark_runs SET status='running' WHERE id = ?").run(runId);

    const result = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(JSON.stringify(result.last('verify_failed')), /running_runs/);
    // A run set back to running must not be re-cancelled by a read-only verify.
    assert.equal(
      f.sqlite.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId).status,
      'running'
    );
  } finally {
    f.close();
  }
});

test('batched apply is idempotent and a pinned batch that grew is refused', async () => {
  const f = oversizedFixture();
  try {
    const baseline = join(f.directory, 'baseline.json');
    const first = await leanRun(f.path, leanArgs('--apply', f.path, ['--baseline-out', baseline]));
    assert.equal(first.code, EXIT.ok, JSON.stringify(first.events));
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));

    // Re-apply with the same lease: idempotent, no new work, same terminal state.
    const again = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(again.code, EXIT.ok, JSON.stringify(again.events));
    assert.equal(again.last('apply_ok').closedChunks, 0, 'nothing is left to close');
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );

    // A late graded result appends to a pinned batch: still under the cap it verifies, but a
    // batch pushed past the envelope must refuse instead of reading a history-sized range.
    const cancelledBatch = saved.scope.batches.find(batch => batch.kind === 'cancelled');
    const runId = cancelledBatch.segments[0].runIds[0];
    bulkResults(f.sqlite, {
      runId,
      rows: LEAN_MAX_SCOPED_ROWS,
      models: cancelledBatch.segments[0].models ?? ['vendor/late'],
      prefix: 'late',
    });
    const grown = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(grown.code, EXIT.verifyFailed);
    assert.match(JSON.stringify(grown.last('verify_failed')), /scoped rows \(limit \d+\)/);
  } finally {
    f.close();
  }
});

test('a re-apply under a lost lease is refused per batch with no write', async () => {
  const f = oversizedFixture();
  try {
    holdOperatorLease(f.sqlite, OPERATOR, Date.now() + 60_000);
    const before = readAll(f.sqlite);
    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.guardRefused);
    assert.match(result.last('guard_refused').reason, /below the required/);
    assert.deepEqual(readAll(f.sqlite), before);
  } finally {
    f.close();
  }
});

test('a rejected plan fails closed instead of scanning history', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor, assertLeanPlan } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    // A deliberately unbounded digest must be rejected by the guard.
    const unbounded = `SELECT (SELECT COUNT(*) FROM case_results) AS n`;
    await assert.rejects(
      () => assertLeanPlan({ plan: sql => inner.plan(sql) }, unbounded),
      error => /plan was rejected/.test(error.message)
    );
    // The real bounded digest passes the same guard.
    const { leanGlobalSql, leanCancelledSql } = await import('./legacy-cancel.mjs');
    const ok = await assertLeanPlan({ plan: sql => inner.plan(sql) }, leanGlobalSql(['run-done']));
    assert.ok(Array.isArray(ok));
    const cancelled = await assertLeanPlan(
      { plan: sql => inner.plan(sql) },
      leanCancelledSql([{ runIds: ['run-live-a'] }])
    );
    assert.ok(Array.isArray(cancelled));
    inner.close();
  } finally {
    f.close();
  }
});

test('remote verify reuses the baseline scope and refuses a changed scope', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baseline = join(f.directory, 'baseline.json');
    const applied = await leanRun(
      f.path,
      leanArgs('--apply', f.path, ['--baseline-out', baseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));
    assert.ok(saved.lean, 'a live baseline must be marked bounded');
    assert.ok(saved.scope, 'a live baseline must persist its scope');
    assert.deepEqual(saved.scope.runIds.sort(), ['run-live-a', 'run-live-b']);
    assert.deepEqual(saved.scope.publishedRunIds, ['run-done']);

    const clean = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(clean.code, EXIT.ok, JSON.stringify(clean.events));

    // Republish from a DIFFERENT run: the served scope can no longer be the same, so verify
    // must refuse rather than compare a different artifact.
    insertDeciderRun(f.sqlite, {
      id: 'run-newer',
      status: 'completed',
      startedAt: '2026-11-24T00:00:00.000Z',
    });
    seedPublished(f.sqlite, { runId: 'run-newer', publishedAt: '2026-11-25T00:00:00.000Z' });
    const moved = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(moved.code, EXIT.verifyFailed);
    assert.match(
      JSON.stringify(moved.last('verify_failed')),
      /published artifact changed|scope changed/
    );
  } finally {
    f.close();
  }
});

test('a live baseline cannot be verified against the isolated transport', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baseline = join(f.directory, 'baseline.json');
    assert.equal(
      (await leanRun(f.path, leanArgs('--apply', f.path, ['--baseline-out', baseline]))).code,
      EXIT.ok
    );
    // Same file, but the full-digest transport.
    const result = await run(f.path, ['--verify', ...BASE_ARGS, '--baseline', baseline]);
    assert.equal(result.code, EXIT.verifyFailed);
    assert.match(result.last('verify_failed').reason, /different transport/);
  } finally {
    f.close();
  }
});

test('bounded path keeps closed current results intact and still closes live work', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    // Snapshot the served artifact's rows as the operator's own pre-state.
    const servedBefore = f.sqlite
      .prepare(
        `SELECT COUNT(*) n, COALESCE(TOTAL(score),0) s, COALESCE(TOTAL(cost_usd),0) c
         FROM case_results WHERE run_id = 'run-done'`
      )
      .get();
    const tableBefore = f.sqlite
      .prepare("SELECT run_id, published_at FROM routing_tables WHERE run_id='run-done'")
      .get();

    const result = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(result.code, EXIT.ok, JSON.stringify(result.events));

    const servedAfter = f.sqlite
      .prepare(
        `SELECT COUNT(*) n, COALESCE(TOTAL(score),0) s, COALESCE(TOTAL(cost_usd),0) c
         FROM case_results WHERE run_id = 'run-done'`
      )
      .get();
    assert.deepEqual({ ...servedAfter }, { ...servedBefore });
    assert.deepEqual(
      {
        ...f.sqlite
          .prepare("SELECT run_id, published_at FROM routing_tables WHERE run_id='run-done'")
          .get(),
      },
      { ...tableBefore }
    );
    // Live work is closed, exactly as on the exhaustive path.
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
    assert.equal(result.last('apply_ok').failedProfilesUnchanged, true);
  } finally {
    f.close();
  }
});

// A pre-cutover running row with ZERO unfinished chunks is live work no chunk count can see:
// only `running_runs` can. `--verify` must refuse it as the sole failure, and `--apply` must be
// able to close it — closing chunks is not what makes the deploy gate safe.
test('verify refuses a chunkless live run on the bounded path, and apply can close it', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const baseline = join(f.directory, 'baseline.json');
    const applied = await leanRun(
      f.path,
      leanArgs('--apply', f.path, ['--baseline-out', baseline])
    );
    assert.equal(applied.code, EXIT.ok, JSON.stringify(applied.events));
    assert.equal(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status IN ('pending','queued','active')"
        )
        .get().n,
      0,
      'the precondition is zero unfinished chunks'
    );

    // A run appears AFTER the baseline with no chunks at all.
    insertDeciderRun(f.sqlite, { id: 'run-chunkless', startedAt: '2026-11-20T18:00:00.000Z' });
    assert.equal(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id='run-chunkless'")
        .get().n,
      0,
      'the control really has no chunks'
    );

    const refused = await leanRun(f.path, leanArgs('--verify', f.path, ['--baseline', baseline]));
    assert.equal(refused.code, EXIT.verifyFailed, JSON.stringify(refused.events));
    // Solely the running row: every chunk count still matches the baseline exactly.
    assert.deepEqual(refused.last('verify_failed').failures, ['running_runs=1']);

    const closed = await leanRun(f.path, leanArgs('--apply', f.path));
    assert.equal(closed.code, EXIT.ok, JSON.stringify(closed.events));
    assert.deepEqual(closed.last('apply_ok').cancelledRuns.sort(), ['run-chunkless']);
    assert.equal(closed.last('apply_ok').closedChunks, 0, 'no chunk was closed: the run was');
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE status='running'").get().n,
      0
    );
  } finally {
    f.close();
  }
});

// ---- real remote shell transport, recorded (no network, no credentials) --------------------
//
// The live path's bugs were invisible because nothing exercised `createRemoteExecutor`. This
// drives it through an injected spawn that records argv and replays the exact JSON shape
// `wrangler d1 execute --json` produces: rows in `results`, affected count in `meta.changes`.

function fakeWrangler(handler) {
  const calls = [];
  const spawnImpl = (binary, args) => {
    const sql = args[args.indexOf('--command') + 1];
    calls.push({ binary, args: [...args], sql });
    const stdout = JSON.stringify(handler(sql, calls.length));
    const listeners = { stdout: [], stderr: [], close: [], error: [] };
    const child = {
      stdout: { setEncoding() {}, on: (_e, fn) => listeners.stdout.push(fn) },
      stderr: { setEncoding() {}, on: (_e, fn) => listeners.stderr.push(fn) },
      on(event, fn) {
        if (event === 'close') listeners.close.push(fn);
        else if (event === 'error') listeners.error.push(fn);
        return child;
      },
      kill() {},
    };
    queueMicrotask(() => {
      for (const fn of listeners.stdout) fn(stdout);
      for (const fn of listeners.close) fn(0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

/**
 * Like `fakeWrangler`, but `handler` may return `{ exit, stdout, stderr }` to fail the way real
 * wrangler does with `--json`: the error text goes to STDOUT and the process exits non-zero with
 * an empty stderr.
 */
function fakeFailingWrangler(handler) {
  const calls = [];
  const spawnImpl = (binary, args) => {
    const sql = args[args.indexOf('--command') + 1];
    calls.push({ binary, args: [...args], sql });
    const outcome = handler(sql, calls.length) ?? {};
    const stdout = outcome.stdout ?? JSON.stringify([{ success: true, results: [] }]);
    const stderr = outcome.stderr ?? '';
    const code = outcome.exit ?? 0;
    const listeners = { stdout: [], stderr: [], close: [], error: [] };
    const child = {
      stdout: { setEncoding() {}, on: (_e, fn) => listeners.stdout.push(fn) },
      stderr: { setEncoding() {}, on: (_e, fn) => listeners.stderr.push(fn) },
      on(event, fn) {
        if (event === 'close') listeners.close.push(fn);
        else if (event === 'error') listeners.error.push(fn);
        return child;
      },
      kill() {},
    };
    queueMicrotask(() => {
      if (stdout !== '') for (const fn of listeners.stdout) fn(stdout);
      if (stderr !== '') for (const fn of listeners.stderr) fn(stderr);
      for (const fn of listeners.close) fn(code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

/** A real wrangler write envelope: `results: []`, count in `meta.changes`. */
const writeEnvelope = changes => [{ success: true, results: [], meta: { changes } }];
const rowsEnvelope = rows => [{ success: true, results: rows, meta: { changes: 0 } }];

test('the real remote transport reports per-statement write counts from meta.changes', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createRemoteExecutor } = await import('./legacy-cancel.mjs');
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const local = createLocalExecutor(f.path);
    const writes = [];
    const { calls, spawnImpl } = fakeWrangler(sql => {
      const explain = /^\s*EXPLAIN QUERY PLAN\s+([\s\S]+)$/i.exec(sql);
      // The bounded path proves its scope lookups too, so answer with the REAL SQLite plan.
      if (explain) return rowsEnvelope(local.plan(explain[1]).map(detail => ({ detail })));
      if (/^\s*(SELECT|WITH)/i.test(sql)) return rowsEnvelope(local.read(sql));
      // A write: apply it, then answer with the real envelope.
      const changed = local.write([sql]);
      writes.push({ sql, changes: Number(changed[0]) });
      return writeEnvelope(changed[0]);
    });
    const remote = createRemoteExecutor({ spawnImpl });
    const lines = [];
    const code = await runLegacyCancel({
      argv: ['--apply', '--remote', '--expect-token', OPERATOR, '--min-remaining-ms', '600000'],
      executor: remote,
      log: line => lines.push(line),
    });
    const events = lines
      .filter(l => l.startsWith('{'))
      .map(l => JSON.parse(l))
      .map(e => ({ ...e, event: e.event.slice('legacy_cancel_'.length) }));
    assert.equal(code, EXIT.ok, lines.join('\n'));
    // The whole cancellation really happened, which is only possible if meta.changes was read.
    const applied = events.find(e => e.event === 'apply_ok');
    assert.ok(applied, 'apply_ok must be reported');
    assert.deepEqual(applied.cancelledRuns.sort(), ['run-live-a', 'run-live-b']);
    assert.equal(applied.closedChunks, 6);
    assert.equal(
      local.read("SELECT COUNT(*) n FROM benchmark_runs WHERE status='running'")[0].n,
      0
    );

    const reportedChanges = events
      .filter(event => event.event === 'pass')
      .flatMap(event => event.changed);
    assert.deepEqual(
      reportedChanges,
      writes.map(write => write.changes)
    );
    const byStatement = pattern =>
      writes.filter(write => pattern.test(write.sql)).map(w => w.changes);
    // The cancel is per run: one flip per captured run, then one global sweep per pass. All six
    // unfinished chunks close; three claims park; one re-measure parks. A second pass finds
    // nothing left to do and reports real zeros.
    assert.deepEqual(byStatement(/^UPDATE benchmark_runs/m), [1, 1]);
    assert.deepEqual(byStatement(/^UPDATE scheduler_chunks/m), [6, 0]);
    // SQLite counts a row an UPDATE matched even when the stored values already match, so
    // parking the same claim again on the second pass reports 1 rather than 0.
    assert.deepEqual(byStatement(/^UPDATE profile_remeasures/m), [1, 1]);
    // Claim parking is per run: 2 claims on the first run, 1 on the second.
    assert.deepEqual(byStatement(/^UPDATE benchmark_profiles[\s\S]*run_id IN/), [2, 1]);
    assert.ok(
      new Set(writes.map(write => write.changes)).size > 2,
      'per-statement counts must vary, not repeat one constant'
    );

    // Every invocation went through the real CLI shape.
    for (const call of calls) {
      assert.equal(call.binary.endsWith('wrangler') || call.binary === 'wrangler', true);
      assert.ok(call.args.includes('--remote'));
      assert.ok(call.args.includes('--json'));
      assert.ok(call.args.includes('BENCH_DB'));
    }
    // The bounded scope lookups were plan-checked through the real transport first.
    assert.ok(
      calls.some(call =>
        /EXPLAIN QUERY PLAN SELECT id FROM benchmark_runs WHERE status = 'running'/.test(call.sql)
      ),
      'the live-run scope must be plan-checked'
    );
    assert.ok(
      calls.some(call => /EXPLAIN QUERY PLAN WITH publications AS MATERIALIZED/.test(call.sql)),
      'the publication lookup must be plan-checked'
    );
    local.close();
  } finally {
    f.close();
  }
});

test('a non-zero wrangler exit reports the error text written to stdout', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createRemoteExecutor } = await import('./legacy-cancel.mjs');
    // Real shape: `--json` puts the failure on STDOUT, stderr is empty, exit 1. Before this fix
    // the reported reason was a bare `wrangler exited 1: ` with no cause at all.
    const { spawnImpl } = fakeFailingWrangler(() => ({
      exit: 1,
      stdout: JSON.stringify({
        error: { text: 'D1_ERROR: too many terms in compound SELECT', code: 7500 },
      }),
      stderr: '',
    }));
    const remote = createRemoteExecutor({ spawnImpl });
    await assert.rejects(
      () => remote.read('SELECT 1'),
      error => {
        assert.match(error.message, /wrangler exited 1/);
        assert.match(error.message, /too many terms in compound SELECT/);
        assert.doesNotMatch(error.message, /SELECT 1/, 'the statement must not be echoed');
        return true;
      }
    );
  } finally {
    f.close();
  }
});

test('the stdout error is truncated to 300 characters and never echoes the statement', async () => {
  const f = fixture();
  try {
    const { describeD1Failure } = await import('./legacy-cancel.mjs');
    const long = 'X'.repeat(4000);
    const message = describeD1Failure({
      code: 1,
      stdout: JSON.stringify([{ success: false, error: { message: long } }]),
      stderr: '',
    });
    assert.match(message, /^wrangler exited 1: X+…$/);
    assert.ok(message.length <= 'wrangler exited 1: '.length + 301, `too long: ${message.length}`);

    // A non-JSON stdout still yields text rather than an empty tail, and stderr is the fallback.
    assert.match(describeD1Failure({ code: 2, stdout: 'boom', stderr: '' }), /exited 2: boom/);
    assert.match(
      describeD1Failure({ code: 3, stdout: '', stderr: 'stderr text' }),
      /exited 3: stderr text/
    );
    assert.match(
      describeD1Failure({ code: 4, stdout: '', stderr: '' }),
      /exited 4: no error text on stdout or stderr/
    );
  } finally {
    f.close();
  }
});

test('a statement over a D1 limit is refused before it is sent, naming the builder', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const {
      createRemoteExecutor,
      assertStatementFitsD1,
      D1_MAX_STATEMENT_BYTES,
      D1_MAX_COMPOUND_TERMS,
      compoundTermCount,
    } = await import('./legacy-cancel.mjs');
    // The shape that broke production: six tables as one UNION ALL is six SELECT terms, and D1
    // documents a maximum of five. Local SQLite accepts it, which is why the copy proof passed.
    const sixTerms = ['a', 'b', 'c', 'd', 'e', 'f']
      .map(name => `SELECT 1 AS x FROM t_${name}`)
      .join(' UNION ALL ');
    assert.equal(compoundTermCount(sixTerms), 6);
    assert.throws(
      () => assertStatementFitsD1(sixTerms, 'model enumeration'),
      error =>
        /model enumeration/.test(error.message) &&
        /6 compound SELECT terms/.test(error.message) &&
        new RegExp(String(D1_MAX_COMPOUND_TERMS)).test(error.message)
    );
    // Five is the documented maximum, so it must pass.
    const fiveTerms = ['a', 'b', 'c', 'd', 'e']
      .map(name => `SELECT 1 AS x FROM t_${name}`)
      .join(' UNION ALL ');
    assert.doesNotThrow(() => assertStatementFitsD1(fiveTerms, 'five'));

    const long = `SELECT '${'y'.repeat(D1_MAX_STATEMENT_BYTES)}' AS v`;
    assert.ok(Buffer.byteLength(long, 'utf8') > D1_MAX_STATEMENT_BYTES);
    assert.throws(
      () => assertStatementFitsD1(long, 'oversized read'),
      error => /oversized read/.test(error.message) && /100000-byte limit/.test(error.message)
    );

    // And the live transport enforces it, so nothing invalid reaches wrangler.
    const { calls, spawnImpl } = fakeFailingWrangler(() => ({
      stdout: JSON.stringify([{ success: true, results: [] }]),
    }));
    const remote = createRemoteExecutor({ spawnImpl });
    await assert.rejects(() => remote.read(sixTerms), /compound SELECT terms/);
    await assert.rejects(() => remote.write([long]), /100000-byte limit/);
    assert.equal(calls.length, 0, 'no refused statement may reach wrangler');
  } finally {
    f.close();
  }
});

test('an apply whose whole scope stays inside the D1 statement limits', async () => {
  const f = oversizedFixture();
  try {
    // Every statement the batched path builds — including the two-part model enumeration — must
    // fit D1's documented limits. This is the regression the production dry-run hit.
    const {
      createRemoteExecutor,
      D1_MAX_STATEMENT_BYTES,
      D1_MAX_COMPOUND_TERMS,
      compoundTermCount,
    } = await import('./legacy-cancel.mjs');
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const local = createLocalExecutor(f.path);
    const kinds = [];
    const { spawnImpl } = fakeFailingWrangler(sql => {
      const bytes = Buffer.byteLength(sql, 'utf8');
      if (bytes > D1_MAX_STATEMENT_BYTES) {
        return {
          exit: 1,
          stdout: JSON.stringify({ error: { text: `statement too long: ${bytes}` } }),
        };
      }
      if (compoundTermCount(sql) > D1_MAX_COMPOUND_TERMS) {
        return {
          exit: 1,
          stdout: JSON.stringify({
            error: { text: `too many terms in compound SELECT (${compoundTermCount(sql)})` },
          }),
        };
      }
      const explain = /^\s*EXPLAIN QUERY PLAN\s+([\s\S]+)$/i.exec(sql);
      if (explain) {
        kinds.push('explain');
        return {
          stdout: JSON.stringify(rowsEnvelope(local.plan(explain[1]).map(detail => ({ detail })))),
        };
      }
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        kinds.push('read');
        return { stdout: JSON.stringify(rowsEnvelope(local.read(sql))) };
      }
      kinds.push('write');
      const changed = local.write([sql]);
      return { stdout: JSON.stringify(writeEnvelope(changed[0])) };
    });
    const remote = createRemoteExecutor({ spawnImpl });
    const lines = [];
    const code = await runLegacyCancel({
      argv: ['--apply', '--remote', '--expect-token', OPERATOR, '--min-remaining-ms', '600000'],
      executor: remote,
      log: line => lines.push(line),
    });
    assert.equal(code, EXIT.ok, lines.join('\n'));
    // The enumeration really ran, in two parts, and reads happened after it.
    assert.ok(kinds.filter(kind => kind === 'read').length > 4);
    assert.ok(kinds.includes('write'));
    local.close();
  } finally {
    f.close();
  }
});

test('packing keeps every batch inside the D1 statement budget, not just the row cap', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { leanBatchSizeSql, leanCancelledSql, LEAN_MAX_BATCH_BYTES, D1_MAX_STATEMENT_BYTES } =
      await import('./legacy-cancel.mjs');
    // Six small runs, each split into many model groups: the row cap alone would pack dozens of
    // OR-chained segments into one statement, which can exceed D1's 100 KB limit.
    const runIds = Array.from({ length: 6 }, (_, i) => `user-2026-11-21T06-53-54-446Z-${i}`);
    const models = Array.from(
      { length: 64 },
      (_, i) => `vendor/some-long-model-name-${String(i).padStart(2, '0')}`
    );
    const probed = [];
    for (const runId of runIds) {
      for (const model of models)
        probed.push({ candidate: { runIds: [runId], models: [model] }, rows: 1 });
    }
    // The unpacked worst case really is over the limit: this is what makes the budget necessary.
    const all = probed.map(p => p.candidate);
    assert.ok(
      Math.max(
        Buffer.byteLength(leanBatchSizeSql(all), 'utf8'),
        Buffer.byteLength(leanCancelledSql(all), 'utf8')
      ) > D1_MAX_STATEMENT_BYTES,
      'the fixture must exceed 100 KB if packed by rows alone'
    );

    // packBatches is the real packer the scope uses.
    const { packBatches } = await import('./legacy-cancel.mjs');
    const packed = packBatches(probed);
    assert.ok(packed.length > 1, 'the byte budget must split the scope');
    for (const segments of packed) {
      // Every probed candidate is one row, so the row cap is the segment count here.
      assert.ok(segments.length <= LEAN_MAX_SCOPED_ROWS, 'a packed batch exceeded the row cap');
      assert.ok(
        Buffer.byteLength(leanBatchSizeSql(segments), 'utf8') <= LEAN_MAX_BATCH_BYTES,
        'a packed batch exceeded the byte budget'
      );
      assert.ok(
        Buffer.byteLength(leanCancelledSql(segments), 'utf8') <= LEAN_MAX_BATCH_BYTES,
        'a packed batch exceeded the byte budget'
      );
    }
    // Every segment lands in exactly one batch: the byte budget must not drop or duplicate one.
    const keys = packed.flatMap(segments =>
      segments.map(segment => `${segment.runIds[0]}|${segment.models[0]}`)
    );
    assert.equal(new Set(keys).size, probed.length);
    assert.equal(keys.length, probed.length);
  } finally {
    f.close();
  }
});

test('a write envelope without meta.changes is a transport error, not a silent zero', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createRemoteExecutor } = await import('./legacy-cancel.mjs');
    const { calls, spawnImpl } = fakeWrangler(sql => {
      if (/^\s*EXPLAIN QUERY PLAN/i.test(sql)) {
        return rowsEnvelope([{ detail: 'SEARCH row USING INDEX case_results (run_id=?)' }]);
      }
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        return rowsEnvelope([]);
      }
      // The old bug shape: rows with a `changes` field and no meta.
      return [{ success: true, results: [{ changes: 3 }] }];
    });
    const remote = createRemoteExecutor({ spawnImpl });
    await assert.rejects(
      () => remote.write(["UPDATE benchmark_runs SET status = 'failed' WHERE 0;"]),
      error => /meta\.changes/.test(error.message)
    );
    assert.ok(calls.length > 0);
  } finally {
    f.close();
  }
});

test('a missing or malformed plan refuses before any payload read or write', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createRemoteExecutor } = await import('./legacy-cancel.mjs');
    // A plan row without `detail`, and an unsuccessful envelope, are both transport errors.
    for (const handler of [
      () => rowsEnvelope([{ notDetail: 'x' }]),
      () => [{ success: false, results: [] }],
    ]) {
      const { calls, spawnImpl } = fakeWrangler(handler);
      const remote = createRemoteExecutor({ spawnImpl });
      await assert.rejects(() => remote.plan('SELECT 1'), /malformed|unsuccessful/);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /EXPLAIN QUERY PLAN/);
    }
    // An EMPTY plan is a *guard* refusal: the transport returns it, assertLeanPlan rejects it
    // before any payload read or write.
    const empty = fakeWrangler(() => rowsEnvelope([]));
    const emptyRemote = createRemoteExecutor({ spawnImpl: empty.spawnImpl });
    const { assertLeanPlan } = await import('./legacy-cancel.mjs');
    await assert.rejects(
      () => assertLeanPlan(emptyRemote, 'SELECT 1'),
      error => /plan was empty/.test(error.message)
    );
    assert.equal(empty.calls.length, 1);
    assert.match(empty.calls[0].sql, /EXPLAIN QUERY PLAN/);
  } finally {
    f.close();
  }
});

test('assertLeanPlan refuses a transport with no plan capability', async () => {
  const { assertLeanPlan } = await import('./legacy-cancel.mjs');
  await assert.rejects(
    () => assertLeanPlan({}, 'SELECT 1'),
    error => /cannot report a query plan/.test(error.message)
  );
});

test('a live run outside the sized baseline aborts before any write', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    let injected = false;
    const executor = {
      lean: true,
      plan: inner.plan,
      read: sql => {
        const rows = inner.read(sql);
        // Admit a run immediately AFTER the size probe — i.e. after sizing, before the write
        // loop's validating read. This is exactly the race the guard must catch pre-write.
        if (!injected && /AS cancelled_chunks/.test(sql)) {
          injected = true;
          insertDeciderRun(f.sqlite, { id: 'run-race', startedAt: '2026-11-20T17:00:00.000Z' });
        }
        return rows;
      },
      write: inner.write,
      close: inner.close,
    };
    const chunksBefore = f.sqlite
      .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status='completed'")
      .get().n;
    const lines = [];
    const code = await runLegacyCancel({
      argv: leanArgs('--apply', f.path),
      executor,
      log: line => lines.push(line),
    });
    assert.equal(code, EXIT.verifyFailed, lines.join('\n'));
    assert.ok(injected, 'the race must actually have been injected');
    assert.match(JSON.stringify(lines), /outside the sized baseline/);
    // Nothing was written: the reviewed runs are still live and no chunk was closed.
    assert.deepEqual(
      f.sqlite
        .prepare("SELECT id FROM benchmark_runs WHERE status='running' ORDER BY id")
        .all()
        .map(r => r.id),
      ['run-live-a', 'run-live-b', 'run-race']
    );
    assert.equal(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status='completed'").get()
        .n,
      chunksBefore
    );
  } finally {
    f.close();
  }
});

test('the plan guard requires run_id keying, not merely a SEARCH', async () => {
  const { assertLeanPlan } = await import('./legacy-cancel.mjs');
  // A SEARCH on a non-run_id key is still an unbounded read and must be rejected.
  await assert.rejects(
    () =>
      assertLeanPlan(
        { plan: async () => ['SEARCH cancelled_case USING INDEX idx_status (status=?)'] },
        'SELECT 1'
      ),
    error => /not keyed by run_id/.test(error.message)
  );
  // A SCAN of a physical history or scope table must be rejected, whether the plan names the
  // table or only the alias the real bounded queries use for it.
  for (const line of [
    'SCAN case_results',
    'SCAN benchmark_runs',
    'SCAN routing_tables',
    'SCAN run',
    'SCAN served',
  ]) {
    await assert.rejects(
      () => assertLeanPlan({ plan: async () => [line] }, 'SELECT 1'),
      error => /not keyed by run_id/.test(error.message),
      `${line} must be refused`
    );
  }
  await assert.rejects(
    () => assertLeanPlan({ plan: async () => ['SCAN unrelated'] }, 'SELECT 1'),
    error => /does not prove indexed history access/.test(error.message)
  );
  // The two global status gates are the explicit exception.
  const ok = await assertLeanPlan(
    {
      plan: async () => [
        'SEARCH row USING INDEX sqlite_autoindex_case_results_1 (run_id=?)',
        'SCAN benchmark_runs USING COVERING INDEX IX_benchmark_runs_running',
        'SEARCH chunk USING COVERING INDEX IX_scheduler_chunks_pending (status=?)',
      ],
    },
    'SELECT 1'
  );
  assert.ok(Array.isArray(ok));
});

test('the size probe rejects a missing, null or negative count', async () => {
  const f = fixture();
  try {
    seed(f.sqlite);
    const { createLocalExecutor } = await import('./legacy-cancel.mjs');
    const inner = createLocalExecutor(f.path);
    for (const bad of [{}, { cancelled_case_results: null }, { cancelled_case_results: -1 }]) {
      const real = inner.read;
      const executor = {
        lean: true,
        plan: inner.plan,
        read: sql => {
          // Substitute the size-probe row only; every other read is real.
          if (sql.includes('AS cancelled_chunks')) {
            const full = {
              cancelled_case_results: 0,
              served_case_results: 0,
              cancelled_summaries: 0,
              served_summaries: 0,
              cancelled_chunks: 0,
              ...bad,
            };
            // `{}` means "the probe omitted the field entirely".
            if (Object.keys(bad).length === 0) delete full.cancelled_case_results;
            return [full];
          }
          return real(sql);
        },
        write: inner.write,
        close: () => {},
      };
      const lines = [];
      const code = await runLegacyCancel({
        argv: leanArgs('--apply', f.path),
        executor,
        log: line => lines.push(line),
      });
      assert.equal(code, EXIT.verifyFailed, JSON.stringify(bad) + ' ' + lines.join('\n'));
      assert.match(JSON.stringify(lines), /invalid|did not report/);
    }
    inner.close();
  } finally {
    f.close();
  }
});
