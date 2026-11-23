#!/usr/bin/env node
/**
 * Explicit, guarded pre-deploy cancel of every live legacy benchmark run.
 *
 * Target schema: ONLY the pre-cutover benchmark D1 — migrations through 0037. The write modes
 * refuse to run on a post-cutover database (migration 0038), because on that schema a
 * `status = 'running'` cancel cannot tell a legacy run from one a user explicitly confirmed
 * through the paid flow. `--legacy-residue` is the read-only post-cutover check: it exists
 * precisely so the post-deploy step never re-runs the cancel.
 *
 * Why a standalone script: `scripts/deploy.mjs` stays unchanged. The operator runs this
 * under the retained operator lease, reviews the dry run, applies, and
 * re-runs `--verify` immediately before `wrangler d1 migrations apply`.
 *
 * ## What this operation does and does not guarantee
 *
 * Guarantees, all asserted after the write:
 * - no `benchmark_runs` row is `running` (so no run can finalize, publish or escalate);
 * - no `scheduler_chunks` row is `pending`/`queued`/`active`, including stale chunks left
 *   on already-terminal runs, so nothing is claimable and nothing is spendable — inference
 *   requires a chunk claim and a claim requires row 1 of `scheduler_dispatch_lock` to be
 *   free (`claimScheduledChunks` -> `acquireLease`);
 * - no `benchmark_profiles` row is `running`, and every run-owned claim is parked at
 *   `PARKED_REQUESTED_AT` so no drain selects it;
 * - every `profile_remeasures` claim is parked in place, keeping `run_id` — both the legacy
 *   and the paid claim paths require `run_id IS NULL`, so a kept claim can never be
 *   re-claimed. Its row survives as history instead of being deleted;
 * - no `case_results`, `model_summaries`, `routing_tables`, `routing_table_candidates`,
 *   `run_lane_failures`, `scheduler_executions`, `pending_decider_outputs`,
 *   `benchmark_subscriptions` or `probe_activations` row changes, and no profile becomes
 *   `failed`, so no model-failure counter or published artifact moves.
 *
 * NOT guaranteed — and this is why `--verify` is mandatory, not optional:
 * admission. The legacy `drainQueue` selects `benchmark_profiles.status = 'pending'` and
 * `profile_remeasures` with no request-time floor, and the same code re-sets the demand
 * flags on the next reconcile, so no data state can stop it. An admitted run is harmless
 * while the lease is held (nothing can be claimed, so nothing is spent) and the deploy's
 * first `dispatchScheduler` pass retires it (`retireLegacyRuns`, fail-closed on error,
 * before any claim pass). `--verify` is how an admission inside the window is detected:
 * it exits 4 and the operator re-runs `--apply` (idempotent) before deploying.
 *
 * ### `--verify` is timestamp-independent, on purpose
 *
 * It asserts CURRENT STATE, never a timestamp comparison. It does not read
 * `benchmark_cutover`, `started_at`, `requested_at` or any other clock. That is required,
 * not incidental: the legacy writer stays able to start a run whose `started_at` is AFTER
 * the new worker's cutover instant (row 1 fences claims, not admission — see
 * `the operator lease fences claims but provably not run initialization` in the fixture).
 * A retirement rule keyed on `started_at < cutover_at` would therefore miss exactly the run
 * this operation must catch. Durable product provenance for the paid cutover belongs to the
 * new worker's own case store (`benchmark_case_runs`, migration 0038) and is not this
 * script's business; this script stays strictly on the 0037 surface and the existing
 * operator pause.
 *
 * ### Operator sequence, including the post-new-worker check
 *
 * 1. Before the migration, under the retained `operator-pause-userpay` lease:
 *      --dry-run  (review the exact statements)
 *      --apply --baseline-out <path>
 *      --verify  --baseline <path>      -> exit 0 required, else do NOT deploy
 * 2. Deploy. The new worker's first `dispatchScheduler` retires any pre-cutover run and
 *    parks its claims; then the migration adds 0038.
 * 3. After the new worker is live and BEFORE releasing the pause: run
 *    `--legacy-residue`, never `--apply`. It is the only mode defined for the post-cutover
 *    schema and is read-only. A legacy run is one with `benchmark_runs.admission_marker IS
 *    NULL`; the check exits 4 if any such run is `running` or owns an unfinished chunk, and
 *    reports paid work separately. Keep the hold and escalate on a nonzero legacy count; do
 *    not re-run the legacy cancel. A paid request or paid run live under the hold is an
 *    expected user confirmation, never a reason to cancel.
 *
 * `--dry-run`, `--apply` and `--verify` refuse on a post-cutover database (exit 4, no
 * writes): every table they need survives migration 0038, so that schema cannot tell a
 * legacy run from a run a user explicitly confirmed through the paid flow.
 *
 * Classifiers are outside the chunk/lease path: a classifier run is enqueued straight to
 * the queue by `startRun` and its `processJob` returns immediately unless
 * `benchmark_runs.status = 'running'`. There is no automatic classifier enqueue anywhere
 * (`startRun` is called only from `POST /admin/runs` and from the decider `drainQueue`), so
 * cancelling the row stops every in-flight classifier message from spending, and no
 * automatic path can start a new one. A classifier message already inside `processJob`
 * cannot be revoked; that work is real, already-paid measurement and is left in place.
 *
 * Exit codes
 *   0  ok
 *   2  usage or configuration error (nothing was written)
 *   3  guard refused: row 1 is not the expected operator lease, or too little remains
 *   4  verification failed: live work remained or a protected digest changed — DO NOT deploy
 *   5  D1/transport error
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const directory = fileURLToPath(new URL('..', import.meta.url));
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const localWrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));

/** `PARKED_REQUESTED_AT` in `src/db.ts`: earlier than any cutover, so no drain selects it. */
export const PARKED_REQUESTED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Stored in `benchmark_runs.error` on the cancelled run. The legacy wire only has
 * `running`/`completed`/`failed`, so an operator cancel has to take `failed`; this marker
 * is what distinguishes it from a model failure. No code reads it as a failure class, and
 * no profile is failed alongside it.
 */
export const CANCEL_ERROR =
  'Cancelled by operator before the user-paid benchmark cutover (legacy cancel-all): not a model failure.';

export const EXIT = { ok: 0, usage: 2, guardRefused: 3, verifyFailed: 4, d1Error: 5 };

const OPERATOR_PREFIX = 'operator-pause-';
/** Every accepted mode. `legacy-residue` is the read-only post-cutover one. */
const MODES = new Set(['--dry-run', '--apply', '--verify', '--legacy-residue']);
/** Bounded re-reads, so a run admitted mid-apply is cancelled in the same invocation. */
const MAX_PASSES = 5;

/** Epoch milliseconds and ISO time as the DATABASE computes them. */
const SQL_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
const SQL_NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;

class UsageError extends Error {}
class GuardRefused extends Error {}
class VerifyFailed extends Error {}
class D1Error extends Error {}

function usage() {
  return [
    'usage: legacy-cancel.mjs <--dry-run|--apply|--verify|--legacy-residue>',
    '         <--remote|--local-file <path>>',
    '         --expect-token <operator-pause-...> --min-remaining-ms <n>',
    '         [--baseline-out <path>] [--baseline <path>]',
    '',
    '  --dry-run         read only: print the lease guard, the before state and the exact SQL',
    '  --apply           run the guarded statements, re-read, and prove the result',
    '  --verify          mandatory last pre-deploy gate: exact lease, zero live work, unchanged digests',
    '  --legacy-residue  read only, post-cutover only: report unmarked legacy work; never cancels',
    '  --remote          live D1 through `wrangler d1 execute BENCH_DB --remote`',
    '  --local-file      local SQLite file (fixture proof only; no network, no credentials)',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = {
    mode: undefined,
    remote: false,
    localFile: undefined,
    expectToken: undefined,
    minRemainingMs: undefined,
    baselineOut: undefined,
    baseline: undefined,
    help: false,
  };
  const take = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${name} needs a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      args.help = true;
    } else if (argument === '--remote') {
      args.remote = true;
    } else if (MODES.has(argument)) {
      const mode = argument.slice(2);
      if (args.mode !== undefined && args.mode !== mode) {
        throw new UsageError('choose exactly one mode');
      }
      args.mode = mode;
    } else if (argument === '--local-file') {
      args.localFile = take(argument, index);
      index += 1;
    } else if (argument === '--expect-token') {
      args.expectToken = take(argument, index);
      index += 1;
    } else if (argument === '--min-remaining-ms') {
      args.minRemainingMs = Number(take(argument, index));
      index += 1;
    } else if (argument === '--baseline-out') {
      args.baselineOut = take(argument, index);
      index += 1;
    } else if (argument === '--baseline') {
      args.baseline = take(argument, index);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${argument}`);
    }
  }
  if (args.help) return args;
  if (args.mode === undefined) throw new UsageError('choose --dry-run, --apply or --verify');
  if (args.remote === (args.localFile !== undefined)) {
    throw new UsageError('choose exactly one of --remote and --local-file');
  }
  if (args.expectToken === undefined) throw new UsageError('--expect-token is required');
  if (!args.expectToken.startsWith(OPERATOR_PREFIX)) {
    throw new UsageError(`--expect-token must start with ${OPERATOR_PREFIX}`);
  }
  if (
    args.minRemainingMs === undefined ||
    !Number.isSafeInteger(args.minRemainingMs) ||
    args.minRemainingMs <= 0
  ) {
    throw new UsageError('--min-remaining-ms must be a positive integer');
  }
  if (args.mode === 'apply' && args.baselineOut === undefined && args.baseline === undefined) {
    args.baselineOut = `${process.env.TMPDIR ?? '/tmp'}/legacy-cancel-baseline.json`;
  }
  if (args.mode === 'verify' && args.baseline === undefined) {
    throw new UsageError('--verify requires --baseline <the file --apply --baseline-out wrote>');
  }
  return args;
}

/**
 * Lease guard carried by EVERY write. The clock is evaluated by the database inside the
 * statement, so a request that waited before reaching D1 fails closed instead of writing on
 * the strength of a timestamp read before it was sent. `--min-remaining-ms` is additionally
 * checked once up front, so an obviously stale lease is refused before any statement is
 * built; keeping the same cushion inside the statement means a lease that ran down while the
 * request was in flight also writes nothing.
 */
export function lockGuardSql(expectToken, minRemainingMs) {
  return `EXISTS (SELECT 1 FROM scheduler_dispatch_lock
        WHERE id = 1
          AND token = ${sqlString(expectToken)}
          AND lease_until > (${SQL_NOW_MS}) + ${Math.trunc(minRemainingMs)})`;
}

const notRunning = column => `NOT EXISTS (
          SELECT 1 FROM benchmark_runs AS run
          WHERE run.id = ${column} AND run.status = 'running')`;

const idList = ids => `(${ids.map(sqlString).join(', ')})`;

/**
 * The statements for one pass, in the only order whose every prefix is safe.
 *
 * `runIds` selects the runs to cancel (statements 1-2); `sweep` selects the global sweep
 * (statements 3-5). A batched apply calls this once per run with `sweep: false`, then once with
 * `runIds: []` and `sweep: true`, so the sweep still runs exactly once per pass.
 *
 * 1. Park the registry claims of the runs about to be cancelled. `status = 'running'` is
 *    part of the predicate, so a `ready` or `failed` row can never be parked by accident —
 *    `run_id IN (…)` alone would match a `ready` row whose provenance run id still points at
 *    a run that has since been cancelled, and that would destroy a published measurement.
 *    This runs BEFORE the run flip so the 6-hour orphan reaper can never observe a terminal
 *    run that still owns a `running` profile; a chunk completion racing this pass is inert
 *    because both ready/fail transitions require `run_id = <this run>` and `status='running'`.
 * 2. Flip the captured runs to `failed` with the cancel marker.
 * 3. Sweep any profile still `running` under a run that is not running: covers claims the
 *    capture missed, claims of already-terminal runs, and `run_id IS NULL` leftovers. Still
 *    guarded by `status = 'running'`.
 * 4. Close every unfinished chunk of a run that is not running — `pending`, `queued` and
 *    `active`, including stale chunks on already-terminal runs. `completed` is the value the
 *    legacy worker itself writes on chunk completion and on recovery; it is never published
 *    on its own, because publication and the `ready` transition only run while
 *    `benchmark_runs.status = 'running'`. Writing `failed` here would fabricate a lane
 *    failure, so it is never written and no `run_lane_failures` row is created.
 * 5. Park every re-measure claim left pointing at a run that is not running, keeping
 *    `run_id` and clearing `claimed_at`. `run_id IS NULL` is required by both claim paths, so
 *    a kept `run_id` is what makes the row unclaimable; a NULL `claimed_at` also keeps it out
 *    of the orphan reaper's `claimed_at < cutoff` delete, so the demand survives as history.
 */
export function buildStatements({ expectToken, minRemainingMs, runIds = [], sweep = true }) {
  const guard = lockGuardSql(expectToken, minRemainingMs);
  const parkProfile = `UPDATE benchmark_profiles
SET status = 'pending',
    run_id = NULL,
    requested_at = ${sqlString(PARKED_REQUESTED_AT)},
    updated_at = ${SQL_NOW_ISO}
WHERE status = 'running'
  AND `;
  const targeted = runIds.length > 0;
  return [
    targeted
      ? `${parkProfile}run_id IN ${idList(runIds)}
  AND ${guard};`
      : null,
    targeted
      ? `UPDATE benchmark_runs
SET status = 'failed',
    error = ${sqlString(CANCEL_ERROR)},
    completed_at = ${SQL_NOW_ISO}
WHERE status = 'running'
  AND id IN ${idList(runIds)}
  AND ${guard};`
      : null,
    sweep
      ? `${parkProfile}(run_id IS NULL OR ${notRunning('benchmark_profiles.run_id')})
  AND ${guard};`
      : null,
    sweep
      ? `UPDATE scheduler_chunks
SET status = 'completed',
    slot = NULL,
    token = NULL,
    lease_until = 0
WHERE status IN ('pending', 'queued', 'active')
  AND ${notRunning('scheduler_chunks.run_id')}
  AND ${guard};`
      : null,
    sweep
      ? `UPDATE profile_remeasures
SET requested_at = ${sqlString(PARKED_REQUESTED_AT)},
    claimed_at = NULL
WHERE run_id IS NOT NULL
  AND ${notRunning('profile_remeasures.run_id')}
  AND ${guard};`
      : null,
  ].filter(statement => statement !== null);
}

export function runningRunsSql() {
  return `SELECT id, kind, purpose, started_at FROM benchmark_runs
WHERE status = 'running' ORDER BY started_at`;
}

export function lockSql() {
  return `SELECT token, lease_until, ${SQL_NOW_MS} AS now_ms
FROM scheduler_dispatch_lock WHERE id = 1`;
}

/** Tables this operation reads or must preserve. One missing means the wrong schema. */
const OPERATION_TABLES = [
  'benchmark_runs',
  'benchmark_profiles',
  'scheduler_chunks',
  'scheduler_dispatch_lock',
  'profile_remeasures',
  'case_results',
  'model_summaries',
  'routing_tables',
  'routing_table_candidates',
  'run_lane_failures',
  'scheduler_executions',
  'pending_decider_outputs',
  'benchmark_subscriptions',
  'probe_activations',
];
export const SCHEMA_TABLES_EXPECTED = OPERATION_TABLES.length;

export function schemaCheckSql() {
  return `SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${OPERATION_TABLES.map(sqlString).join(', ')})`;
}

/**
 * The post-cutover detector. This operation cancels by `status = 'running'`, which cannot tell a
 * legacy run from a run a user explicitly confirmed through the paid flow — so on a
 * post-migration database it would cancel real work. Both probes must therefore be absent
 * before any write:
 *
 * - `benchmark_cutover`, created only by migration 0038, is the paid-flow marker's home. Its
 *   presence means the schema is post-cutover.
 * - `benchmark_runs.admission_marker`, added by the same migration, is the durable positive
 *   proof the new Worker writes and a legacy writer never does
 *   (`SCHEDULER_LANE_HEADS_SQL` claims only `admission_marker IS NOT NULL`;
 *   `initializeScheduledRun` makes an unmarked run terminal). Checking the column, not only its
 *   values, is what makes this independent of whether a cutover row exists yet.
 *
 * A probe rather than a migration-name read on purpose: `d1_migrations` records what was applied,
 * while this asks the database what shape it actually has — the same thing the write statements
 * are about to run against. Both probes are ordinary reads, so `--dry-run` reports the refusal
 * instead of throwing.
 */
const CUTOVER_TABLE = 'benchmark_cutover';
const CUTOVER_COLUMN = 'admission_marker';

export function cutoverProbeSql() {
  return `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(CUTOVER_TABLE)}) AS cutover_table,
  (SELECT COUNT(*) FROM pragma_table_info('benchmark_runs') WHERE name = ${sqlString(CUTOVER_COLUMN)}) AS cutover_column`;
}

/**
 * Read-only inspection of legacy work after the cutover. `admission_marker IS NULL` is the exact
 * legacy predicate the new Worker itself uses (`retireLegacyRuns`), so this reports only work the
 * paid flow does not own: a run the new Worker admitted is never "unexpected" here, and a
 * user-confirmed paid run while the hold is retained is expected and is explicitly NOT a reason
 * to cancel anything.
 */
export function legacyResidueSql() {
  return `SELECT
  (SELECT COUNT(*) FROM benchmark_runs AS run
    WHERE run.status = 'running' AND run.admission_marker IS NULL) AS legacy_running_runs,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk
    WHERE chunk.status IN ('pending', 'queued', 'active')
      AND EXISTS (SELECT 1 FROM benchmark_runs AS owner
        WHERE owner.id = chunk.run_id AND owner.admission_marker IS NULL)) AS legacy_unfinished_chunks,
  (SELECT COUNT(*) FROM benchmark_runs AS run
    WHERE run.status = 'running' AND run.admission_marker IS NOT NULL) AS paid_running_runs,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk
    WHERE chunk.status IN ('pending', 'queued', 'active')
      AND EXISTS (SELECT 1 FROM benchmark_runs AS owner
        WHERE owner.id = chunk.run_id AND owner.admission_marker IS NOT NULL)) AS paid_unfinished_chunks`;
}

/**
 * The proof digest. Two groups, both of which the four statements provably never write.
 *
 * `<prefix>_artifacts` group — scoped to runs that are `completed`. That is exactly the
 * preservation claim an operator needs ("finished work and its published artifacts do not
 * move"): a `completed` run cannot be produced by the legacy worker inside this operation's
 * window, so this group is stable across an apply even when the legacy worker admits a new
 * run concurrently, and it is compared strictly before/after.
 *
 * Global group — true invariants summed over the whole table (`attempts`,
 * `throttle_deferrals`, failure ledger, executions, published artifacts, demand flags). The
 * operation writes none of these columns, so a change means something outside the reviewed
 * statements ran. Demand flags are summed, not counted-with-scope, because parking
 * necessarily moves a cancelled pair's `run_id` while the flags themselves must not move.
 *
 * Every correlated outer column is qualified with an explicit alias: an unqualified `id`
 * inside a `NOT EXISTS` over `benchmark_runs` would bind to the inner table and silently
 * make the predicate vacuous.
 */
export function stateSql() {
  const hallmark = sqlString(CANCEL_ERROR);
  const cancelledById = idExpression => `EXISTS (
        SELECT 1 FROM benchmark_runs AS cancelled
        WHERE cancelled.id = ${idExpression} AND cancelled.error = ${hallmark})`;
  // Artifacts of runs that are completed right now, i.e. the served output.
  const completedRun = `EXISTS (
        SELECT 1 FROM benchmark_runs AS served
        WHERE served.id = %s AND served.status = 'completed')`;
  const artifactRun = completedRun.replace('%s', 'run_id');
  return `SELECT
  (SELECT COUNT(*) FROM benchmark_runs AS run WHERE run.status = 'running') AS running_runs,
  (SELECT COUNT(*) FROM benchmark_runs AS run WHERE run.error = ${hallmark}) AS cancelled_runs_n,
  (SELECT COUNT(*) FROM benchmark_runs AS run
    WHERE run.status = 'completed' AND NOT ${cancelledById('run.id')}) AS completed_runs,
  (SELECT COALESCE(GROUP_CONCAT(signature, '|'), '') FROM (
      SELECT run.id || '@' || COALESCE(run.started_at, '') || '@' || COALESCE(run.completed_at, '')
        || '@' || run.status || '@' || COALESCE(run.error, '') AS signature
      FROM benchmark_runs AS run
      WHERE run.status = 'completed' AND NOT ${cancelledById('run.id')}
      ORDER BY run.id)) AS completed_run_signature,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status IN ('pending', 'queued', 'active')) AS unfinished_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'pending') AS pending_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'queued') AS queued_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'active') AS active_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'completed') AS completed_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'failed') AS failed_chunks,
  (SELECT COALESCE(TOTAL(chunk.attempts), 0) FROM scheduler_chunks AS chunk) AS chunk_attempts,
  (SELECT COALESCE(TOTAL(chunk.throttle_deferrals), 0) FROM scheduler_chunks AS chunk) AS chunk_throttle_deferrals,
  (SELECT COALESCE(GROUP_CONCAT(signature, '|'), '') FROM (
      SELECT chunk.run_id || ':' || chunk.model || ':' || chunk.variant || ':' || chunk.rep
        || ':' || chunk.chunk || ':' || chunk.case_ids AS signature
      FROM scheduler_chunks AS chunk
      WHERE ${completedRun.replace('%s', 'chunk.run_id')}
      ORDER BY chunk.run_id, chunk.model, chunk.variant, chunk.rep, chunk.chunk)) AS completed_chunk_signature,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'running') AS running_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'pending') AS pending_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'ready') AS ready_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'failed') AS failed_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile
    WHERE profile.status = 'running' AND ${cancelledById('profile.run_id')}) AS cancelled_running_profiles_n,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile
    WHERE profile.status IN ('running', 'pending')
      AND profile.run_id IS NOT NULL AND ${cancelledById('profile.run_id')}) AS cancelled_still_claimed_profiles_n,
  (SELECT COALESCE(SUM(profile.platform_requested), 0) FROM benchmark_profiles AS profile) AS platform_requested_sum,
  (SELECT COALESCE(SUM(profile.user_requested), 0) FROM benchmark_profiles AS profile) AS user_requested_sum,
  (SELECT COALESCE(GROUP_CONCAT(signature, '|'), '') FROM (
      SELECT profile.model || ':' || profile.variant || ':' || profile.status || ':'
        || COALESCE(profile.failure_class, '') || ':' || COALESCE(profile.failure_reason, '')
        || ':' || COALESCE(profile.completed_at, '') || ':' || COALESCE(profile.run_id, '') AS signature
      FROM benchmark_profiles AS profile
      WHERE profile.status IN ('ready', 'failed') ORDER BY profile.model, profile.variant)) AS settled_profile_signature,
  (SELECT COUNT(*) FROM case_results AS row WHERE ${artifactRun}) AS case_results_n,
  (SELECT COALESCE(TOTAL(row.score), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_score,
  (SELECT COALESCE(TOTAL(row.cost_usd), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_cost,
  (SELECT COALESCE(TOTAL(row.latency_ms), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_latency,
  (SELECT COALESCE(SUM(COALESCE(row.timed_out, 0)), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_timeouts,
  (SELECT COALESCE(SUM(LENGTH(COALESCE(row.error, ''))), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_error_length,
  (SELECT COALESCE(SUM(LENGTH(row.model || row.variant || row.case_id)), 0) FROM case_results AS row WHERE ${artifactRun}) AS case_results_key_length,
  (SELECT COUNT(*) FROM model_summaries AS row WHERE ${artifactRun}) AS summaries_n,
  (SELECT COALESCE(TOTAL(row.accuracy), 0) FROM model_summaries AS row WHERE ${artifactRun}) AS summaries_accuracy,
  (SELECT COALESCE(SUM(row.cases), 0) FROM model_summaries AS row WHERE ${artifactRun}) AS summaries_cases,
  (SELECT COUNT(*) FROM routing_tables AS served) AS routing_tables_n,
  (SELECT COALESCE(GROUP_CONCAT(signature, '|'), '') FROM (
      SELECT served.run_id || '@' || served.published_at || '@' || served.generated_at
        || '@' || served.source AS signature
      FROM routing_tables AS served ORDER BY served.run_id)) AS routing_tables_signature,
  (SELECT COUNT(*) FROM routing_table_candidates AS candidate) AS candidates_n,
  (SELECT COALESCE(TOTAL(candidate.accuracy), 0) FROM routing_table_candidates AS candidate) AS candidates_accuracy,
  (SELECT COALESCE(TOTAL(candidate.avg_cost_usd), 0) FROM routing_table_candidates AS candidate) AS candidates_cost,
  (SELECT COUNT(*) FROM run_lane_failures AS failure) AS lane_failures_n,
  (SELECT COUNT(*) FROM scheduler_executions AS execution) AS executions_n,
  (SELECT COUNT(*) FROM pending_decider_outputs AS pending) AS pending_outputs_n,
  (SELECT COUNT(*) FROM profile_remeasures AS claim) AS remeasures_n,
  (SELECT COUNT(*) FROM profile_remeasures AS claim WHERE claim.run_id IS NOT NULL) AS remeasure_claims_n,
  (SELECT COUNT(*) FROM profile_remeasures AS claim
    WHERE claim.run_id IS NOT NULL
      AND (claim.claimed_at IS NOT NULL OR claim.requested_at <> ${sqlString(PARKED_REQUESTED_AT)})
      AND ${cancelledById('claim.run_id')}) AS cancelled_unparked_claims_n,
  (SELECT COUNT(*) FROM benchmark_subscriptions AS subscription) AS subscriptions_n,
  (SELECT COUNT(*) FROM probe_activations AS activation) AS probe_activations_n;
`;
}

/**
 * Counters that may only ever GROW, never shrink. They are demand admission: the legacy
 * worker can admit a new platform pair in the deploy window (row 1 fences claims, not
 * admission), so growth is expected and is reported as admission evidence rather than as a
 * failure. Shrinking would mean demand silently disappeared, which is what this operation
 * must never cause, so a decrease fails verification.
 */
export const MONOTONE_FIELDS = new Set(['platform_requested_sum', 'user_requested_sum']);

/**
 * The live path never runs `stateSql()`: history-wide digests are what overloaded production
 * D1. It reads only the literal deploy gate (indexed `running_runs` + chunk status counts), the
 * CURRENT published artifact for the fixed router list, the runs being cancelled, and pool-sized
 * dimension tables. Scope is sized and plan-checked before any payload read or write.
 * `--local-file` keeps the exhaustive digest: an isolated copy is where byte comparison belongs.
 */
export const LEAN_MAX_RUNS = 50;
export const LEAN_MAX_SCOPED_ROWS = 50_000;
export const LEAN_MAX_PUBLICATIONS = 2_000;
/**
 * A single run's history may exceed the per-batch envelope on its own. Such a run is split into
 * disjoint `model` groups (the second column of every scoped primary key); this is the hard
 * ceiling on how large ONE run may be before even the split is refused, so the model enumeration
 * can never read an unbounded range.
 */
export const LEAN_MAX_SPLIT_ROWS = 4 * LEAN_MAX_SCOPED_ROWS;
/** A split run's model groups are enumerated with this cap; more distinct models refuse. */
export const LEAN_MAX_MODEL_GROUPS = 64;

/** The routers whose published artifact is compared (`AUTO_ROUTERS` in the contracts package). */
export const LEAN_ROUTERS = ['efficient', 'frontier'];

/** Running runs, capped with LIMIT+1 so an overrun is detected without an unbounded read. */
export function scopeRunsSql(limit = LEAN_MAX_RUNS) {
  return `SELECT id FROM benchmark_runs WHERE status = 'running' LIMIT ${limit + 1}`;
}

/** Read a capped publication history, then select the latest artifact for each router. */
export function scopePublishedSql(routers = LEAN_ROUTERS) {
  const current = routers
    .map(
      router => `SELECT ${sqlString(router)} AS router, history_rows, (
      SELECT t.run_id FROM publications AS t
      WHERE t.router = ${sqlString(router)}
      ORDER BY t.published_at DESC, t.ordinal DESC
      LIMIT 1) AS run_id
      FROM publication_count`
    )
    .join('\n  UNION ALL\n  ');
  // An upsert can republish an older row, so rowid cannot decide which table serves.
  // This pre-migration schema has no publication index. Refuse partial history.
  return `WITH publications AS MATERIALIZED (
    SELECT router, run_id, published_at, rowid AS ordinal FROM routing_tables
    LIMIT ${LEAN_MAX_PUBLICATIONS + 1}
  ), publication_count AS (SELECT COUNT(*) AS history_rows FROM publications)
  ${current}`;
}

const inList = ids => (ids.length === 0 ? 'IN (NULL)' : `IN (${ids.map(sqlString).join(', ')})`);

/**
 * One batch of the bounded scope. A batch is the unit whose scoped rows must fit inside
 * `LEAN_MAX_SCOPED_ROWS`, and the unit `--verify` re-reads.
 *
 * - `{ kind: 'global' }` — every scope-free counter plus the CURRENT published artifact. Exactly
 *   one per scope, always first.
 * - `{ kind: 'cancelled', runIds: [...] }` — the whole history of those runs.
 * - `{ kind: 'cancelled', runIds: [...], models: [...] }` — one `model` group of a run too large
 *   for a single batch.
 * - `{ kind: 'cancelled', runIds: [...], notModels: [...] }` — the rest of a split run. It is the
 *   exact complement of the enumerated groups, so a model that appears after planning (or one
 *   that only ever owned a chunk) is still read, and split batches still partition the run.
 */
function segmentWhere(batch, alias) {
  const runIds = (batch.runIds ?? []).map(String);
  const parts = [`${alias}.run_id ${inList(runIds)}`];
  if (Array.isArray(batch.models)) {
    if (batch.models.length === 0) throw new VerifyFailed('a bounded batch has an empty model set');
    parts.push(`${alias}.model IN (${batch.models.map(sqlString).join(', ')})`);
  }
  if (Array.isArray(batch.notModels)) {
    if (batch.notModels.length === 0) {
      // `NOT IN ()` is invalid SQL, and an empty complement is the whole run, not nothing.
      throw new VerifyFailed('a bounded batch has an empty model complement');
    }
    parts.push(`${alias}.model NOT IN (${batch.notModels.map(sqlString).join(', ')})`);
  }
  return parts.join(' AND ');
}

const probe = (alias, from, cap) => `(SELECT COUNT(*) FROM (
      SELECT 1 AS hit FROM ${from} LIMIT ${cap + 1}) AS ${alias})`;

/**
 * Size probes: `LIMIT <cap+1>` stops at the cap; a missing field is an error, never zero. The
 * probe covers one batch (a set of disjoint segments), and counts every table the cancelled
 * digest reads, so the envelope bounds the rows that will actually be read, not a proxy.
 */
export function leanBatchSizeSql(segments, cap = LEAN_MAX_SCOPED_ROWS) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new VerifyFailed('a bounded batch has no segments');
  }
  const where = alias => segments.map(segment => `(${segmentWhere(segment, alias)})`).join(' OR ');
  return `SELECT
  ${probe('cancelled_case_results', `case_results AS row WHERE ${where('row')}`, cap)} AS cancelled_case_results,
  ${probe('cancelled_summaries', `model_summaries AS row WHERE ${where('row')}`, cap)} AS cancelled_summaries,
  ${probe('cancelled_chunks', `scheduler_chunks AS chunk WHERE ${where('chunk')}`, cap)} AS cancelled_chunks,
  ${probe('cancelled_lane_failures', `run_lane_failures AS failure WHERE ${where('failure')}`, cap)} AS cancelled_lane_failures,
  ${probe('cancelled_executions', `scheduler_executions AS execution WHERE ${where('execution')}`, cap)} AS cancelled_executions,
  ${probe('cancelled_pending_outputs', `pending_decider_outputs AS pending WHERE ${where('pending')}`, cap)} AS cancelled_pending_outputs`;
}

/** The served half of the envelope: the two published runs' artifact and its contributors. */
export function leanServedSizeSql(publishedRunIds, cap = LEAN_MAX_SCOPED_ROWS) {
  const published = inList((publishedRunIds ?? []).map(String));
  return `SELECT
  ${probe('served_case_results', `case_results AS row WHERE row.run_id ${published}`, cap)} AS served_case_results,
  ${probe('served_summaries', `model_summaries AS row WHERE row.run_id ${published}`, cap)} AS served_summaries,
  ${probe('served_candidates', `routing_table_candidates AS candidate WHERE candidate.run_id ${published}`, cap)} AS served_candidates`;
}

/**
 * The scope-free counters plus the CURRENT published artifact. Every `cancelled_*` field is a
 * literal zero here: the combined digest takes those from the cancelled batches, and the zeros
 * keep the field set identical whether or not a scope has any cancelled runs.
 */
export function leanGlobalSql(publishedRunIds) {
  const published = inList((publishedRunIds ?? []).map(String));
  return `WITH
  served_case AS (SELECT
      COUNT(*) AS n, COALESCE(TOTAL(score), 0) AS score,
      COALESCE(TOTAL(cost_usd), 0) AS cost, COALESCE(TOTAL(latency_ms), 0) AS latency,
      COALESCE(SUM(COALESCE(timed_out, 0)), 0) AS timeouts,
      COALESCE(SUM(LENGTH(COALESCE(error, ''))), 0) AS error_length,
      COALESCE(SUM(LENGTH(model || variant || case_id)), 0) AS key_length
    FROM case_results AS row WHERE row.run_id ${published}),
  served_summary AS (SELECT COUNT(*) AS n, COALESCE(TOTAL(accuracy), 0) AS accuracy,
      COALESCE(SUM(cases), 0) AS cases
    FROM model_summaries AS row WHERE row.run_id ${published}),
  served_routing AS (SELECT
      COALESCE(GROUP_CONCAT(t.run_id || '@' || t.published_at || '@'
        || t.generated_at || '@' || t.source, '|'), '') AS signature
    FROM routing_tables AS t WHERE t.run_id ${published}),
  served_candidate AS (SELECT COUNT(*) AS n, COALESCE(TOTAL(accuracy), 0) AS accuracy,
      COALESCE(TOTAL(avg_cost_usd), 0) AS cost
    FROM routing_table_candidates AS candidate WHERE candidate.run_id ${published})
SELECT
  (SELECT COUNT(*) FROM benchmark_runs AS run WHERE run.status = 'running') AS running_runs,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk
    WHERE chunk.status IN ('pending', 'queued', 'active')) AS unfinished_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'pending') AS pending_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'queued') AS queued_chunks,
  (SELECT COUNT(*) FROM scheduler_chunks AS chunk WHERE chunk.status = 'active') AS active_chunks,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'running') AS running_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'pending') AS pending_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'ready') AS ready_profiles,
  (SELECT COUNT(*) FROM benchmark_profiles AS profile WHERE profile.status = 'failed') AS failed_profiles,
  (SELECT COALESCE(SUM(profile.platform_requested), 0) FROM benchmark_profiles AS profile) AS platform_requested_sum,
  (SELECT COALESCE(SUM(profile.user_requested), 0) FROM benchmark_profiles AS profile) AS user_requested_sum,
  (SELECT COUNT(*) FROM profile_remeasures AS claim) AS remeasures_n,
  (SELECT COUNT(*) FROM profile_remeasures AS claim WHERE claim.run_id IS NOT NULL) AS remeasure_claims_n,
  (SELECT COUNT(*) FROM benchmark_subscriptions AS subscription) AS subscriptions_n,
  (SELECT COUNT(*) FROM probe_activations AS activation) AS probe_activations_n,
  served_case.n AS served_case_results_n,
  served_case.score AS served_case_results_score,
  served_case.cost AS served_case_results_cost,
  served_case.latency AS served_case_results_latency,
  served_case.timeouts AS served_case_results_timeouts,
  served_case.error_length AS served_case_results_error_length,
  served_case.key_length AS served_case_results_key_length,
  served_summary.n AS served_summaries_n,
  served_summary.accuracy AS served_summaries_accuracy,
  served_summary.cases AS served_summaries_cases,
  served_routing.signature AS served_routing_signature,
  served_candidate.n AS served_candidates_n,
  served_candidate.accuracy AS served_candidates_accuracy,
  served_candidate.cost AS served_candidates_cost,
  0 AS cancelled_case_results_n,
  0 AS cancelled_case_results_score,
  0 AS cancelled_case_results_timeouts,
  0 AS cancelled_summaries_n,
  0 AS cancelled_chunks_n,
  0 AS cancelled_chunk_attempts,
  0 AS cancelled_lane_failures_n,
  0 AS cancelled_executions_n,
  0 AS cancelled_pending_outputs_n
FROM served_case, served_summary, served_routing, served_candidate;
`;
}

/**
 * The cancelled half of one batch. Each CTE is an AGGREGATE (one row), so SQLite cannot inline it
 * and each history table is read once per batch; the final SELECT cross-joins the one-row results.
 * The query plan proves it. Only `cancelled_*` fields come from here; a batch's rows are disjoint
 * from every other batch's, so summing the batches equals one aggregate over the whole scope.
 */
export function leanCancelledSql(batches) {
  const where = alias => batches.map(batch => `(${segmentWhere(batch, alias)})`).join(' OR ');
  return `WITH
  cancelled_case AS (SELECT
      COUNT(*) AS n, COALESCE(TOTAL(score), 0) AS score,
      COALESCE(SUM(COALESCE(timed_out, 0)), 0) AS timeouts
    FROM case_results AS row WHERE ${where('row')}),
  cancelled_summary AS (SELECT COUNT(*) AS n
    FROM model_summaries AS row WHERE ${where('row')}),
  cancelled_chunk AS (SELECT COUNT(*) AS n, COALESCE(TOTAL(attempts), 0) AS attempts
    FROM scheduler_chunks AS chunk WHERE ${where('chunk')}),
  cancelled_lane AS (SELECT COUNT(*) AS n FROM run_lane_failures AS failure
    WHERE ${where('failure')}),
  cancelled_execution AS (SELECT COUNT(*) AS n FROM scheduler_executions AS execution
    WHERE ${where('execution')}),
  cancelled_pending AS (SELECT COUNT(*) AS n FROM pending_decider_outputs AS pending
    WHERE ${where('pending')})
SELECT
  cancelled_case.n AS cancelled_case_results_n,
  cancelled_case.score AS cancelled_case_results_score,
  cancelled_case.timeouts AS cancelled_case_results_timeouts,
  cancelled_summary.n AS cancelled_summaries_n,
  cancelled_chunk.n AS cancelled_chunks_n,
  cancelled_chunk.attempts AS cancelled_chunk_attempts,
  cancelled_lane.n AS cancelled_lane_failures_n,
  cancelled_execution.n AS cancelled_executions_n,
  cancelled_pending.n AS cancelled_pending_outputs_n
FROM cancelled_case, cancelled_summary, cancelled_chunk, cancelled_lane,
     cancelled_execution, cancelled_pending;
`;
}

/** The additive fields the combined digest sums across disjoint batches. */
export const LEAN_SUMMED_FIELDS = [
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

/** Combine per-batch digests into the one flat digest `compareLean` compares. */
export function combineBatchStates(global, cancelledBatches) {
  const digest = { ...global };
  for (const field of LEAN_SUMMED_FIELDS) {
    let total = 0;
    for (const batch of cancelledBatches) {
      const value = Number(batch?.[field]);
      if (!Number.isFinite(value)) {
        throw new VerifyFailed(`a bounded batch reported an invalid ${field}`);
      }
      total += value;
    }
    digest[field] = total;
  }
  return digest;
}

/** Fields this operation changes on purpose in the bounded digest. */
export const LEAN_CHANGED_BY_DESIGN = new Set([
  'running_runs',
  'unfinished_chunks',
  'pending_chunks',
  'queued_chunks',
  'active_chunks',
  'running_profiles',
  'pending_profiles',
]);

/** Bounded-digest fields that may only grow (a late graded result legitimately adds a row). */
export const LEAN_MONOTONE_FIELDS = new Set([
  'platform_requested_sum',
  'user_requested_sum',
  'cancelled_case_results_n',
  'cancelled_case_results_score',
  'cancelled_case_results_timeouts',
  'cancelled_summaries_n',
  'cancelled_lane_failures_n',
  'cancelled_executions_n',
  'cancelled_pending_outputs_n',
]);

/** Fields this operation changes on purpose. Every other field must be byte-identical. */
export const CHANGED_BY_DESIGN = new Set([
  'running_runs',
  'cancelled_runs_n',
  'unfinished_chunks',
  'pending_chunks',
  'queued_chunks',
  'active_chunks',
  'completed_chunks',
  'running_profiles',
  'pending_profiles',
]);

function assertLease(lock, args) {
  if (!lock) throw new GuardRefused('scheduler_dispatch_lock row 1 is missing');
  if (lock.token !== args.expectToken) {
    throw new GuardRefused(
      `row 1 holds ${lock.token === null ? 'no token' : `token ${lock.token}`}, not ${args.expectToken}`
    );
  }
  const remaining = Number(lock.lease_until) - Number(lock.now_ms);
  if (!Number.isFinite(remaining) || remaining < args.minRemainingMs) {
    throw new GuardRefused(
      `lease has ${Math.max(0, Math.trunc(remaining / 1000))}s left, below the required ${Math.trunc(args.minRemainingMs / 1000)}s`
    );
  }
  return remaining;
}

function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new VerifyFailed(
      `cannot read baseline ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function compare(
  before,
  after,
  {
    requireZeroLive,
    changed = CHANGED_BY_DESIGN,
    monotone = MONOTONE_FIELDS,
    zeroLiveFields = [
      'running_runs',
      'unfinished_chunks',
      'running_profiles',
      'cancelled_running_profiles_n',
      'cancelled_still_claimed_profiles_n',
      'cancelled_unparked_claims_n',
    ],
  }
) {
  const failures = [];
  const n = key => Number(after[key]);
  if (requireZeroLive) {
    if (n('running_runs') !== 0) failures.push(`running_runs=${n('running_runs')}`);
    if (n('unfinished_chunks') !== 0) {
      failures.push(
        `unfinished_chunks=${n('unfinished_chunks')} (pending=${n('pending_chunks')} ` +
          `queued=${n('queued_chunks')} active=${n('active_chunks')})`
      );
    }
    for (const key of zeroLiveFields) {
      if (key === 'running_runs' || key === 'unfinished_chunks') continue;
      if (!(key in after)) continue;
      if (n(key) !== 0) failures.push(`${key}=${n(key)}`);
    }
  }
  for (const key of Object.keys(before)) {
    if (changed.has(key)) continue;
    const expected = before[key];
    const actual = after[key];
    if (monotone.has(key)) {
      if (Number(actual) < Number(expected))
        failures.push(`${key} shrank: ${expected} -> ${actual}`);
      continue;
    }
    const same =
      typeof expected === 'number'
        ? Number(actual) === Number(expected)
        : String(actual) === String(expected);
    if (!same) failures.push(`${key}: ${expected} -> ${actual}`);
  }
  return failures;
}

/** Compare two bounded digests: zero live work, monotone counters, everything else exact. */
function compareLean(before, after) {
  return compare(before, after, {
    requireZeroLive: true,
    changed: LEAN_CHANGED_BY_DESIGN,
    monotone: LEAN_MONOTONE_FIELDS,
    /**
     * Blocking fields only. `pending_profiles` is NOT one: parking a cancelled run's claim moves
     * rows TO `pending`, so it legitimately rises. `running_profiles` and `running_runs` are the
     * live-work assertions; `unfinished_chunks` is the spend fence.
     */
    zeroLiveFields: ['running_runs', 'unfinished_chunks', 'running_profiles'],
  });
}

/** Sum the probe fields of one batch; a missing field is a broken probe, never zero. */
function sumProbe(size, fields, label) {
  let rows = 0;
  for (const field of fields) {
    const raw = size?.[field];
    // A missing, null, negative or non-integer count is a broken probe, never zero.
    // `Number(null)` is 0, so null is rejected before the numeric check.
    const value = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isInteger(value) || value < 0) {
      throw new VerifyFailed(
        `the ${label} size probe reported an invalid ${field} (${size?.[field]}); refusing an unsized read`
      );
    }
    rows += value;
  }
  return rows;
}

const CANCELLED_SIZE_FIELDS = [
  'cancelled_case_results',
  'cancelled_summaries',
  'cancelled_chunks',
  'cancelled_lane_failures',
  'cancelled_executions',
  'cancelled_pending_outputs',
];
const SERVED_SIZE_FIELDS = ['served_case_results', 'served_summaries', 'served_candidates'];

/**
 * The `model` groups of one run, largest first, taken as the UNION of the models that appear in
 * every table the batch probe counts. `case_results` alone is not enough: a run can hold its bulk
 * in `scheduler_executions` (one row per executed case, and production has a run with 54,661 of
 * them), in a chunk, or in a pending output that has no graded result yet. Enumerating only graded
 * results would either refuse a splittable run ("no model groups") or push those rows into the
 * `NOT IN` complement until it exceeded the cap.
 *
 * Each branch is a `run_id` seek with its own GROUP BY, so SQLite materializes them instead of
 * flattening the compound and reading a table by something other than `run_id`. The size is
 * bounded twice: the run is provably under `LEAN_MAX_SPLIT_ROWS` before this is reached, and the
 * result is capped at `LEAN_MAX_MODEL_GROUPS + 1`.
 */
export function scopeRunModelsSql(runId, cap = LEAN_MAX_MODEL_GROUPS) {
  const key = sqlString(runId);
  const branch = (from, alias) =>
    `SELECT ${alias}.model AS model, COUNT(*) AS n FROM ${from} AS ${alias}
      WHERE ${alias}.run_id = ${key} GROUP BY ${alias}.model`;
  return `SELECT model, SUM(n) AS n FROM (
    ${branch('case_results', 'row')}
    UNION ALL ${branch('model_summaries', 'summary')}
    UNION ALL ${branch('scheduler_chunks', 'chunk')}
    UNION ALL ${branch('run_lane_failures', 'failure')}
    UNION ALL ${branch('scheduler_executions', 'execution')}
    UNION ALL ${branch('pending_decider_outputs', 'pending')}
  ) GROUP BY model ORDER BY n DESC, model ASC LIMIT ${cap + 1}`;
}

async function runModelGroups(executor, runId) {
  const sql = scopeRunModelsSql(runId);
  await assertLeanPlan(executor, sql);
  const rows = await executor.read(sql);
  if (rows.length > LEAN_MAX_MODEL_GROUPS) {
    throw new VerifyFailed(
      `the run has more than ${LEAN_MAX_MODEL_GROUPS} model groups; refusing to split it further`
    );
  }
  const models = rows.map(row => String(row.model));
  if (models.length === 0) throw new VerifyFailed('a split run has no model groups');
  return models;
}

/**
 * A run's total scoped rows, measured to the split ceiling rather than the batch cap: a run that
 * exceeds the batch envelope is examined once, and the enumeration below is only reached when the
 * run is provably under `LEAN_MAX_SPLIT_ROWS`. The probe stops at the ceiling, so it can never
 * read an unbounded range.
 */
export function leanRunCeilingSql(runId, cap = LEAN_MAX_SPLIT_ROWS) {
  const where = { runIds: [runId] };
  return `SELECT
  ${probe('cancelled_case_results', `case_results AS row WHERE ${segmentWhere(where, 'row')}`, cap)} AS cancelled_case_results,
  ${probe('cancelled_summaries', `model_summaries AS row WHERE ${segmentWhere(where, 'row')}`, cap)} AS cancelled_summaries,
  ${probe('cancelled_chunks', `scheduler_chunks AS chunk WHERE ${segmentWhere(where, 'chunk')}`, cap)} AS cancelled_chunks,
  ${probe('cancelled_lane_failures', `run_lane_failures AS failure WHERE ${segmentWhere(where, 'failure')}`, cap)} AS cancelled_lane_failures,
  ${probe('cancelled_executions', `scheduler_executions AS execution WHERE ${segmentWhere(where, 'execution')}`, cap)} AS cancelled_executions,
  ${probe('cancelled_pending_outputs', `pending_decider_outputs AS pending WHERE ${segmentWhere(where, 'pending')}`, cap)} AS cancelled_pending_outputs`;
}

/**
 * Split one run that exceeds the per-batch envelope into disjoint `model` groups plus the exact
 * complement. Returns `{ candidate, rows }`; a group that is still over the cap is refused here,
 * because `--apply` must stay bounded and there is no smaller disjoint key to split on.
 */
async function splitRun(executor, runId) {
  const models = await runModelGroups(executor, runId);
  const candidates = models.map(model => ({ runIds: [runId], models: [model] }));
  candidates.push({ runIds: [runId], notModels: models });
  const probed = [];
  for (const [index, candidate] of candidates.entries()) {
    const sql = leanBatchSizeSql([candidate]);
    await assertLeanPlan(executor, sql);
    const [size] = await executor.read(sql);
    const rows = sumProbe(size, CANCELLED_SIZE_FIELDS, 'model-group');
    if (rows > LEAN_MAX_SCOPED_ROWS) {
      const label = candidates[index].models ? `model group ${index + 1}` : 'the remaining rows';
      throw new VerifyFailed(
        `run ${runId}'s ${label} holds ${rows} scoped rows (limit ${LEAN_MAX_SCOPED_ROWS}); ` +
          'it cannot be split below the bounded envelope — this is an operator decision'
      );
    }
    if (rows > 0) probed.push({ candidate, rows });
  }
  return probed;
}

/** Pack probed candidates greedily so each batch's scoped rows stay inside the envelope. */
function packBatches(probed) {
  const batches = [];
  let current = null;
  let currentRows = 0;
  for (const { candidate, rows } of probed) {
    if (current !== null && currentRows + rows <= LEAN_MAX_SCOPED_ROWS) {
      current.push(candidate);
      currentRows += rows;
      continue;
    }
    current = [candidate];
    currentRows = rows;
    batches.push(current);
  }
  return batches;
}

/**
 * Resolve the bounded scope into batches, fail-closed. Every invocation re-probes each batch, so
 * a batch that grew past the envelope (a late graded result, a re-admitted run) refuses before any
 * read or write. `--verify` passes the baseline's batches and the SAME measurement runs again.
 */
async function resolveLeanScope(executor, previous = null) {
  const runningSql = scopeRunsSql();
  const runningPlan = await readQueryPlan(executor, runningSql);
  if (runningPlan.length !== 1 || !/\bIX_benchmark_runs_running\b/.test(runningPlan[0])) {
    throw new VerifyFailed('the live-run scope does not use the running-run index');
  }
  const runningRows = await executor.read(runningSql);
  const liveRunIds = runningRows.map(row => String(row.id)).sort();
  if (liveRunIds.length > LEAN_MAX_RUNS) {
    throw new VerifyFailed(
      `refusing a bounded verification over ${liveRunIds.length} running runs (limit ${LEAN_MAX_RUNS}); ` +
        'this is a larger operator decision, not a routine cancel'
    );
  }
  const publishedSql = scopePublishedSql();
  const publishedPlan = await readQueryPlan(executor, publishedSql);
  if (
    !publishedPlan.includes('MATERIALIZE publications') ||
    publishedPlan.filter(line => /^(SCAN|SEARCH) routing_tables\b/.test(line)).length !== 1
  ) {
    throw new VerifyFailed('the publication query does not use one capped read');
  }
  const publishedRows = await executor.read(publishedSql);
  if (
    publishedRows.length !== LEAN_ROUTERS.length ||
    publishedRows.some(row => !Number.isSafeInteger(row.history_rows) || row.history_rows < 0)
  ) {
    throw new VerifyFailed('the publication history probe is incomplete');
  }
  if (publishedRows.some(row => row.history_rows > LEAN_MAX_PUBLICATIONS)) {
    throw new VerifyFailed('publication history exceeds the bounded verification limit');
  }
  // A router with no publication yet yields NULL; it is not a served artifact and is not
  // compared. Only real run ids enter the scope.
  const publishedRunIds = [
    ...new Set(
      publishedRows.flatMap(row =>
        row.run_id === null || row.run_id === undefined ? [] : [String(row.run_id)]
      )
    ),
  ].sort();
  if (
    previous !== null &&
    (!Array.isArray(previous.runIds) || !Array.isArray(previous.publishedRunIds))
  ) {
    throw new VerifyFailed('the bounded baseline has no valid scope');
  }
  const runIds = previous?.runIds ?? liveRunIds;
  if (runIds.length > LEAN_MAX_RUNS) {
    throw new VerifyFailed('the bounded baseline exceeds the run limit');
  }

  // The cancelled runs become terminal. Keep their identities for comparison, and
  // require the current published identities to match before reading any results.
  if (previous) {
    const expected = [...new Set((previous.publishedRunIds ?? []).map(String))].sort();
    if (JSON.stringify(expected) !== JSON.stringify(publishedRunIds)) {
      throw new VerifyFailed(
        `the current published artifact changed since the baseline ` +
          `(${expected.length} vs ${publishedRunIds.length} run(s)); refusing to compare a different artifact`
      );
    }
    if (!Array.isArray(previous.batches) || previous.batches.length === 0) {
      throw new VerifyFailed('the bounded baseline has no valid batches');
    }
    const pinned = new Set(runIds.map(String));
    for (const batch of previous.batches) {
      if (batch?.kind !== 'cancelled') continue;
      if (!Array.isArray(batch.segments) || batch.segments.length === 0) {
        throw new VerifyFailed('a bounded baseline batch has no segments');
      }
      for (const segment of batch.segments) {
        const owners = (segment?.runIds ?? []).map(String);
        if (owners.length === 0 || owners.some(id => !pinned.has(id))) {
          throw new VerifyFailed(
            'a bounded baseline batch names a run outside the pinned scope; refusing to widen it'
          );
        }
      }
    }
  }

  // The served half is sized once, before any batch is read.
  const servedSql = leanServedSizeSql(publishedRunIds);
  await assertLeanPlan(executor, servedSql);
  const [servedSize] = await executor.read(servedSql);
  const servedRows = sumProbe(servedSize, SERVED_SIZE_FIELDS, 'published-artifact');

  // A pinned baseline keeps its exact batches; a fresh scope is planned here.
  const cancelledBatches = previous
    ? previous.batches.filter(batch => batch?.kind === 'cancelled')
    : await planBatches(executor, runIds);

  const sizes = [];
  for (const batch of cancelledBatches) {
    const sql = leanBatchSizeSql(batch.segments);
    // The size probe is itself a live read: prove it is indexed before running it.
    await assertLeanPlan(executor, sql);
    const [size] = await executor.read(sql);
    const rows = sumProbe(size, CANCELLED_SIZE_FIELDS, 'batch');
    if (rows > LEAN_MAX_SCOPED_ROWS) {
      throw new VerifyFailed(
        `a bounded batch holds ${rows} scoped rows (limit ${LEAN_MAX_SCOPED_ROWS}); ` +
          'refusing a history-sized comparison on live D1 — use the isolated copy instead'
      );
    }
    sizes.push(rows);
  }
  if (servedRows > LEAN_MAX_SCOPED_ROWS) {
    throw new VerifyFailed(
      `the published artifact holds ${servedRows} scoped rows (limit ${LEAN_MAX_SCOPED_ROWS}); ` +
        'refusing a history-sized comparison on live D1 — use the isolated copy instead'
    );
  }

  const batches = [
    { kind: 'global', segments: [], rows: servedRows, served: true },
    ...cancelledBatches.map((batch, index) => ({
      kind: 'cancelled',
      segments: batch.segments,
      rows: sizes[index],
    })),
  ];
  const scopeRows = sizes.reduce((total, rows) => total + rows, servedRows);
  return { runIds, publishedRunIds, batches, scopeRows };
}

/** Plan the cancelled batches for a fresh scope: whole runs first, then splits if one is too big. */
async function planBatches(executor, runIds) {
  if (runIds.length === 0) return [];
  // Probe every run as a single batch first; only an overrun needs the model split.
  const whole = [];
  for (const runId of runIds) {
    const candidate = { runIds: [runId] };
    const sql = leanRunCeilingSql(runId);
    await assertLeanPlan(executor, sql);
    const [size] = await executor.read(sql);
    whole.push({ candidate, rows: sumProbe(size, CANCELLED_SIZE_FIELDS, 'run') });
  }
  const probed = [];
  for (const entry of whole) {
    if (entry.rows <= LEAN_MAX_SCOPED_ROWS) {
      if (entry.rows > 0) probed.push(entry);
      continue;
    }
    if (entry.rows > LEAN_MAX_SPLIT_ROWS) {
      throw new VerifyFailed(
        `run ${entry.candidate.runIds[0]} holds ${entry.rows} scoped rows (limit ${LEAN_MAX_SPLIT_ROWS}); ` +
          'refusing to enumerate a run that large on live D1 — this is an operator decision'
      );
    }
    probed.push(...(await splitRun(executor, entry.candidate.runIds[0])));
  }
  return packBatches(probed).map(segments => ({ segments }));
}

/** Reject a plan that scans a history table instead of reaching it by `run_id`. */
const LEAN_PLAN_TABLES = [
  'case_results',
  'model_summaries',
  'scheduler_chunks',
  'run_lane_failures',
  'scheduler_executions',
  'pending_decider_outputs',
  'benchmark_runs',
  'routing_tables',
];

async function readQueryPlan(executor, sql) {
  if (typeof executor.plan !== 'function') {
    throw new VerifyFailed('the transport cannot report a query plan; refusing an unchecked read');
  }
  const plan = await executor.plan(sql);
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new VerifyFailed('the query plan was empty; refusing an unchecked read');
  }
  return plan;
}

export async function assertLeanPlan(executor, sql) {
  const plan = await readQueryPlan(executor, sql);
  /**
   * Every history alias must be a `SEARCH` on `run_id`; a SCAN or a SEARCH on another key is an
   * unbounded read and is refused. The two global status gates are allowlisted because their
   * indexes are partial on `status` (`IX_benchmark_runs_running`,
   * `IX_scheduler_chunks_pending`).
   */
  const runKeyed = [
    'cancelled_case',
    'served_case',
    'cancelled_summary',
    'served_summary',
    'cancelled_chunk',
    'served_routing',
    'served',
    'candidate',
    'cancelled_lane',
    'cancelled_execution',
    'cancelled_pending',
    'run',
    't',
  ];
  const statusGate = /(IX_benchmark_runs_running|IX_scheduler_chunks_pending)/;
  const failures = [];
  let sawKeyedHistory = false;
  for (const line of plan) {
    if (!/^(SEARCH|SCAN)\b/.test(line)) continue;
    const alias = line.replace(/^(SEARCH|SCAN)\s+/, '').split(/\s+/)[0];
    const table = LEAN_PLAN_TABLES.find(name => line.includes(name));
    if (statusGate.test(line)) continue;
    // A scan of a MATERIALIZED one-row aggregate CTE is the intended shape: those CTEs each
    // read their physical table once (verified by the SEARCH lines above).
    if (
      /SCAN\b/.test(line) &&
      /^SCAN (cancelled_|served_routing|served_case|served_summary|served_candidate)/.test(line)
    ) {
      continue;
    }
    // Known history aliases must be keyed by run_id; any other SEARCH on a history table name
    // must be too. The status gates are the only exception.
    if (runKeyed.includes(alias) || table) {
      if (/^SEARCH\b/.test(line) && /run_id=\?/.test(line)) {
        sawKeyedHistory = true;
        continue;
      }
      failures.push(line);
    }
  }
  if (failures.length > 0) {
    throw new VerifyFailed(
      `bounded verification plan was rejected (history access not keyed by run_id): ${failures[0]}`
    );
  }
  if (!sawKeyedHistory) {
    throw new VerifyFailed('the query plan does not prove indexed history access');
  }
  return plan;
}

/** Public proof is counts only: never emit run ids or row contents. */
function scopeReport(scope) {
  return {
    runs: scope.runIds.length,
    publishedRuns: scope.publishedRunIds.length,
    batches: scope.batches.map(batch => ({
      kind: batch.kind,
      segments: batch.segments.length,
      rows: batch.rows,
    })),
    scopedRows: scope.scopeRows,
  };
}

/** Before/after snapshot: bounded + scope-checked on live, exhaustive on the isolated copy. */
async function readState(executor, scope = null) {
  if (!executor.lean) return { digest: (await executor.read(stateSql()))[0], scope: null };
  const resolved = await resolveLeanScope(executor, scope);
  const globalSql = leanGlobalSql(resolved.publishedRunIds);
  await assertLeanPlan(executor, globalSql);
  const [global] = await executor.read(globalSql);
  const cancelled = [];
  for (const batch of resolved.batches) {
    if (batch.kind !== 'cancelled') continue;
    const sql = leanCancelledSql(batch.segments);
    await assertLeanPlan(executor, sql);
    const [rows] = await executor.read(sql);
    cancelled.push(rows);
  }
  return { digest: combineBatchStates(global, cancelled), scope: resolved };
}

function report(sink, event, fields = {}) {
  sink(JSON.stringify({ event: `legacy_cancel_${event}`, ...fields }));
}

/**
 * Parse and validate the real `wrangler d1 execute --json` envelope: rows in `results`, a
 * write's affected count in `meta.changes`. Malformed or unsuccessful is an error, never zero.
 */
function parseD1Entries(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new D1Error('D1 did not return JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new D1Error('D1 returned no results');
  for (const entry of parsed) {
    if (entry?.success !== true) throw new D1Error('D1 reported an unsuccessful statement');
    if (!Array.isArray(entry.results)) throw new D1Error('D1 entry has no results array');
    if (entry.meta !== undefined && typeof entry.meta.changes !== 'number') {
      throw new D1Error('D1 entry has a malformed meta envelope');
    }
  }
  return parsed;
}

/**
 * Production transport: one `wrangler d1 execute BENCH_DB --remote --json` per statement,
 * through the package-local binary. Statements are NOT batched into one command: every
 * statement carries the live-clock lease guard and is idempotent, so an interrupted run is
 * repaired by running `--apply` again, and a partial pass never leaves a spendable or
 * escalatable state (see the ordering rationale on `buildStatements`).
 */
export function createRemoteExecutor({ signal, spawnImpl = spawn } = {}) {
  const binary = existsSync(localWrangler) ? localWrangler : 'wrangler';
  const runEnvelope = sql =>
    new Promise((resolve, reject) => {
      const child = spawnImpl(
        binary,
        [
          '--config',
          config,
          '--env',
          '',
          'd1',
          'execute',
          'BENCH_DB',
          '--remote',
          '--json',
          '--command',
          sql,
        ],
        {
          cwd: directory,
          env: { ...process.env, CI: '1', CLOUDFLARE_ENV: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
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
      child.on('error', error => reject(new D1Error(`wrangler could not start: ${error.message}`)));
      child.on('close', code => {
        if (code !== 0) {
          const tail = stderr.trim().split('\n').slice(-5).join(' / ');
          reject(new D1Error(`wrangler exited ${code}: ${tail}`));
          return;
        }
        try {
          resolve(parseD1Entries(stdout));
        } catch (error) {
          reject(error);
        }
      });
      if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
  return {
    // The live path is the bounded one; `lean: true` is what selects it.
    lean: true,
    read: sql => runEnvelope(sql).then(entries => entries.at(-1).results),
    /** `EXPLAIN QUERY PLAN` rows, as the real transport reports them. */
    plan: sql =>
      runEnvelope(`EXPLAIN QUERY PLAN ${sql}`).then(entries =>
        entries
          .flatMap(entry => entry.results)
          .map(row => {
            if (row === null || typeof row !== 'object' || !('detail' in row)) {
              throw new D1Error('D1 returned a malformed EXPLAIN QUERY PLAN row');
            }
            return String(row.detail);
          })
      ),
    write: async statements => {
      const changed = [];
      for (const statement of statements) {
        // The affected count lives in `meta.changes`; `results` is normally empty.
        const entries = await runEnvelope(statement);
        const entry = entries.at(-1);
        if (!entry || entry.success !== true || typeof entry.meta?.changes !== 'number') {
          throw new D1Error('D1 write did not report meta.changes');
        }
        changed.push(Number(entry.meta.changes));
      }
      return changed;
    },
  };
}

/** Fixture transport. Reachable only through `--local-file`; never opens a network connection. */
export function createLocalExecutor(path) {
  let db;
  const open = () => {
    db ??= new DatabaseSync(path);
    return db;
  };
  return {
    lean: false,
    // Exposed so the isolated proof can assert the bounded plan too.
    plan: sql =>
      open()
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map(row => String(row.detail)),
    read: sql => open().prepare(sql).all(),
    write: statements => {
      const sqlite = open();
      const changed = [];
      for (const statement of statements) {
        const result = sqlite.prepare(statement).run();
        changed.push(Number(result.changes));
      }
      return changed;
    },
    close: () => db?.close(),
  };
}

export async function runLegacyCancel({
  argv,
  executor,
  log = message => process.stdout.write(`${message}\n`),
}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(usage());
    report(log, 'usage_error', { reason: error instanceof Error ? error.message : String(error) });
    return EXIT.usage;
  }
  if (args.help) {
    log(usage());
    return EXIT.ok;
  }

  try {
    const [schema] = await executor.read(schemaCheckSql());
    if (Number(schema?.present) !== SCHEMA_TABLES_EXPECTED) {
      throw new VerifyFailed(
        `this schema has ${schema?.present} of the ${SCHEMA_TABLES_EXPECTED} tables the operation needs; ` +
          'it targets the live legacy schema (through migration 0037) and refuses to guess'
      );
    }
    /**
     * Fail closed on a post-cutover database. Every table this operation needs survives
     * migration 0038, so the table count cannot tell the two schemas apart — and cancelling by
     * `status = 'running'` would then take a run a user explicitly confirmed through the paid
     * flow. The probe runs before the lease check and before any statement is built, for every
     * mode; `--legacy-residue` is the one mode defined for the post-cutover schema, and
     * `--dry-run`/`--apply`/`--verify` refuse.
     */
    const [cutover] = await executor.read(cutoverProbeSql());
    const postCutover =
      Number(cutover?.cutover_table) !== 0 || Number(cutover?.cutover_column) !== 0;
    if (args.mode !== 'legacy-residue' && postCutover) {
      throw new VerifyFailed(
        'this database is post-cutover (paid benchmark flow): ' +
          `${CUTOVER_TABLE}=${cutover?.cutover_table ?? '?'}, ${CUTOVER_COLUMN}=${cutover?.cutover_column ?? '?'}. ` +
          'The legacy cancel applies only before migration 0038 and refuses to touch paid runs. ' +
          'Use --legacy-residue for the read-only post-deploy check instead.'
      );
    }
    if (args.mode === 'legacy-residue' && !postCutover) {
      throw new VerifyFailed(
        'this database is pre-cutover: --legacy-residue reports legacy work after migration 0038. ' +
          'Before the cutover use --dry-run, --apply and --verify.'
      );
    }

    if (args.mode === 'legacy-residue') {
      // Read-only, post-cutover only. Reports legacy (unmarked) work the paid flow does not own
      // and separately counts paid work so an operator can see the hold is doing its job without
      // treating an expected user confirmation as a reason to cancel anything.
      const [lock] = await executor.read(lockSql());
      const remainingMs = assertLease(lock, args);
      const [residue] = await executor.read(legacyResidueSql());
      report(log, 'legacy_residue', residue);
      const legacyLive =
        Number(residue?.legacy_running_runs) !== 0 ||
        Number(residue?.legacy_unfinished_chunks) !== 0;
      report(log, legacyLive ? 'legacy_residue_unexpected' : 'legacy_residue_ok', {
        token: lock.token,
        remainingSeconds: Math.trunc(remainingMs / 1000),
        legacyRunningRuns: Number(residue?.legacy_running_runs),
        legacyUnfinishedChunks: Number(residue?.legacy_unfinished_chunks),
        paidRunningRuns: Number(residue?.paid_running_runs),
        paidUnfinishedChunks: Number(residue?.paid_unfinished_chunks),
        action: legacyLive
          ? 'keep the hold and escalate; do not re-run the legacy cancel and do not cancel paid runs'
          : 'none',
      });
      return legacyLive ? EXIT.verifyFailed : EXIT.ok;
    }

    const [lock] = await executor.read(lockSql());
    const remainingMs = assertLease(lock, args);
    report(log, 'lease_ok', {
      token: lock.token,
      remainingSeconds: Math.trunc(remainingMs / 1000),
      minRemainingMs: args.minRemainingMs,
    });

    if (args.mode === 'dry-run') {
      const running = await executor.read(runningRunsSql());
      const ids = running.map(row => String(row.id));
      const { digest: before, scope } = await readState(executor);
      if (scope) report(log, 'lean_scope', scopeReport(scope));
      report(log, 'before', before);
      report(log, 'would_cancel', {
        runs: running.map(row => ({
          id: row.id,
          kind: row.kind,
          purpose: row.purpose,
          startedAt: row.started_at,
        })),
      });
      log('');
      log('-- lease guard, re-evaluated inside every statement --');
      log(lockGuardSql(args.expectToken, args.minRemainingMs));
      // The exact statement set the batched apply sends: per run (park, flip), then the sweep.
      const planned = [];
      for (const id of ids) {
        planned.push({
          runId: id,
          statements: buildStatements({
            expectToken: args.expectToken,
            minRemainingMs: args.minRemainingMs,
            runIds: [id],
            sweep: false,
          }),
        });
      }
      planned.push({
        runId: null,
        statements: buildStatements({
          expectToken: args.expectToken,
          minRemainingMs: args.minRemainingMs,
          runIds: [],
          sweep: true,
        }),
      });
      let total = 0;
      for (const group of planned) {
        log('');
        log(`-- ${group.runId === null ? 'global sweep' : `run ${group.runId}`} --`);
        for (const statement of group.statements) {
          total += 1;
          log('');
          log(statement);
        }
      }
      if (args.baselineOut !== undefined) log('');
      report(log, 'dry_run_ok', { statements: total, writes: 0 });
      return EXIT.ok;
    }

    if (args.mode === 'apply') {
      // One resolve defines BOTH the digest and the runs that may be cancelled: a run that
      // appears after it is a race overrun, not part of the reviewed baseline.
      const beforeState = await readState(executor);
      const before = beforeState.digest;
      const scopedRunIds = beforeState.scope ? beforeState.scope.runIds : null;
      const first = scopedRunIds
        ? [...scopedRunIds]
        : (await executor.read(runningRunsSql())).map(row => String(row.id));
      if (beforeState.scope) report(log, 'lean_scope', scopeReport(beforeState.scope));
      report(log, 'before', before);
      const cancelled = new Set(first);
      let passes = 0;
      while (passes < MAX_PASSES) {
        const ids = (await executor.read(runningRunsSql())).map(row => String(row.id));
        if (scopedRunIds) {
          // A live run outside the sized baseline is a race overrun: abort before writing
          // rather than cancelling a run nobody reviewed.
          const outside = ids.filter(id => !scopedRunIds.includes(id));
          if (outside.length > 0) {
            throw new VerifyFailed(
              `a live run (${outside.length}) appeared outside the sized baseline; ` +
                'aborting before any write — re-run --dry-run to review the larger set'
            );
          }
        }
        for (const id of ids) cancelled.add(id);
        // Statements 1 and 2 are per-run (park that run's claims, then flip it terminal); the
        // global sweep (3-5) runs once per pass. Each batch's rows are read separately, so the
        // WRITE side never needs a batch: it is the same guarded statement set, per run.
        const changed = [];
        for (const id of ids) {
          changed.push(
            ...(await executor.write(
              buildStatements({
                expectToken: args.expectToken,
                minRemainingMs: args.minRemainingMs,
                runIds: [id],
                sweep: false,
              })
            ))
          );
        }
        // Terminal runs can still have unfinished chunks. Run the guarded sweep even
        // when there are no live runs to cancel.
        changed.push(
          ...(await executor.write(
            buildStatements({
              expectToken: args.expectToken,
              minRemainingMs: args.minRemainingMs,
              runIds: [],
              sweep: true,
            })
          ))
        );
        passes += 1;
        report(log, 'pass', { pass: passes, runIds: ids, changed });
        if (ids.length === 0) break;
        // Every statement is guarded by the database clock. A pass that wrote nothing while
        // live runs remain means the lease guard refused the writes (the lease ran down or
        // was replaced while the request was in flight). Retrying cannot help and would only
        // hide the refusal, so stop and report it.
        if (changed.every(count => count === 0)) {
          throw new GuardRefused(
            'every guarded statement wrote nothing while live runs remain: the operator lease refused the writes'
          );
        }
      }
      // Re-read with the SAME resolved scope; a scope that moved during the operation is
      // reported rather than silently widened.
      const afterState = await readState(executor, beforeState.scope);
      const after = afterState.digest;
      const [relock] = await executor.read(lockSql());
      report(log, 'after', after);
      const failures = beforeState.scope
        ? compareLean(before, after)
        : compare(before, after, { requireZeroLive: true });
      if (
        relock?.token !== args.expectToken ||
        Number(relock?.lease_until) !== Number(lock.lease_until)
      ) {
        throw new GuardRefused('the operator lease row changed during the operation');
      }
      if (failures.length > 0) {
        report(log, 'apply_verify_failed', { failures, passes });
        return EXIT.verifyFailed;
      }
      if (args.baselineOut !== undefined) {
        writeFileSync(
          args.baselineOut,
          `${JSON.stringify(
            {
              token: args.expectToken,
              leaseUntil: Number(lock.lease_until),
              cancelledRunIds: [...cancelled],
              // Exact identities this verification compared, so --verify re-reads the same
              // rows and cannot quietly re-scope to a different artifact.
              scope: beforeState.scope,
              lean: Boolean(beforeState.scope),
              state: after,
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );
        chmodSync(args.baselineOut, 0o600);
        report(log, 'baseline_written', { path: args.baselineOut });
      }
      report(log, 'apply_ok', {
        passes,
        cancelledRuns: [...cancelled],
        closedChunks: Number(before.unfinished_chunks),
        parkedProfiles: Number(after.pending_profiles) - Number(before.pending_profiles),
        failedProfilesUnchanged: Number(after.failed_profiles) === Number(before.failed_profiles),
      });
      return EXIT.ok;
    }

    // --verify: the mandatory last gate, run immediately before the migration.
    const baseline = readBaseline(args.baseline);
    const cancelledIds = baseline?.cancelledRunIds;
    if (!Array.isArray(cancelledIds) || baseline.state === undefined) {
      throw new VerifyFailed(`baseline ${args.baseline} is not an --apply baseline`);
    }
    if (baseline.token !== args.expectToken) {
      throw new VerifyFailed(`baseline was taken under ${baseline.token}, not ${args.expectToken}`);
    }
    if (Number(baseline.leaseUntil) !== Number(lock.lease_until)) {
      throw new VerifyFailed('the operator lease row changed since the baseline was taken');
    }
    // Recheck and resize the pinned scope before comparing the same rows.
    const baselineScope = baseline.scope ?? null;
    if (Boolean(baseline.lean) !== Boolean(executor.lean)) {
      throw new VerifyFailed(
        'the baseline was taken over a different transport than this run; refusing to compare'
      );
    }
    if (executor.lean && baselineScope === null) {
      throw new VerifyFailed('the bounded baseline has no scope');
    }
    const { digest: current } = await readState(executor, baselineScope);
    const failures = baseline.lean
      ? compareLean(baseline.state, current)
      : compare(baseline.state, current, { requireZeroLive: true });
    if (failures.length > 0) {
      report(log, 'verify_failed', { failures });
      return EXIT.verifyFailed;
    }
    report(log, 'verify_ok', {
      token: lock.token,
      remainingSeconds: Math.trunc(remainingMs / 1000),
      cancelledRuns: cancelledIds.length,
      writes: 0,
    });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof GuardRefused) {
      report(log, 'guard_refused', { reason: error.message });
      return EXIT.guardRefused;
    }
    if (error instanceof VerifyFailed) {
      report(log, 'verify_failed', { reason: error.message });
      return EXIT.verifyFailed;
    }
    if (error instanceof UsageError) {
      report(log, 'usage_error', { reason: error.message });
      return EXIT.usage;
    }
    if (error instanceof D1Error) {
      report(log, 'd1_error', { reason: error.message });
      return EXIT.d1Error;
    }
    report(log, 'd1_error', { reason: error instanceof Error ? error.message : String(error) });
    return EXIT.d1Error;
  } finally {
    await executor.close?.();
  }
}

const sink = message => process.stdout.write(`${message}\n`);
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let executor;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      process.exit(EXIT.ok);
    }
    executor = parsed.remote ? createRemoteExecutor() : createLocalExecutor(parsed.localFile);
  } catch (error) {
    process.stdout.write(`${usage()}\n`);
    report(sink, 'usage_error', {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exit(EXIT.usage);
  }
  process.exitCode = await runLegacyCancel({ argv, executor, log: sink });
}
