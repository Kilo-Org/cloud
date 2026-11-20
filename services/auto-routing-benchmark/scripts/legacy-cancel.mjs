#!/usr/bin/env node
/**
 * Explicit, guarded pre-deploy cancel of every live legacy benchmark run.
 *
 * Target schema: the LIVE benchmark D1 as deployed today — migrations through 0037, i.e.
 * BEFORE the user-paid cutover migration 0038. Nothing here may reference a 0038 table
 * (`benchmark_cutover`, `paid_benchmark_*`, `benchmark_case_runs`, `benchmark_case_payers`,
 * `paid_model_requests`, `profile_attempt_history`), because those do not exist yet.
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
 * 1. Before the migration, under the retained operator lease:
 *      --dry-run  (review the exact statements)
 *      --apply --baseline-out <path>
 *      --verify  --baseline <path>      -> exit 0 required, else do NOT deploy
 * 2. Deploy. The new worker's first `dispatchScheduler` retires any pre-cutover run and
 *    parks its claims; then the migration adds 0038.
 * 3. After the new worker is live and BEFORE releasing the pause, re-run the read-only
 *    checks below. Both are legacy-shaped (`status`/`scheduler_chunks` counts), so they work
 *    on the 0037 surface and after 0038 without editing this script:
 *    a. LATE LEGACY: `benchmark_runs` rows with `status='running'` must be 0, and
 *       `scheduler_chunks` in pending/queued/active must be 0. A nonzero count means the old
 *       writer admitted work after the apply; do not release the pause — cancel it again
 *       with `--apply` (still idempotent, still guarded) and re-verify.
 *    b. NEW NO-BILLING ACTIVATION: no paid request is live and no paid case is running.
 *       On the post-0038 schema that is `SELECT COUNT(*) FROM paid_benchmark_requests
 *       WHERE status IN ('preparing','active')` and the equivalent on
 *       `benchmark_case_runs`; both must be 0 before the pause is released, because
 *       releasing the pause is what lets the new scheduler spend. This script does not
 *       query them: they do not exist pre-0038, and inventing a query for them here would
 *       either break the pre-deploy run or silently pass on a missing table.
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
    'usage: legacy-cancel.mjs <--dry-run|--apply|--verify> <--remote|--local-file <path>>',
    '         --expect-token <operator-pause-...> --min-remaining-ms <n>',
    '         [--baseline-out <path>] [--baseline <path>]',
    '',
    '  --dry-run     read only: print the lease guard, the before state and the exact SQL',
    '  --apply       run the guarded statements, re-read, and prove the result',
    '  --verify      mandatory last pre-deploy gate: exact lease, zero live work, unchanged digests',
    '  --remote      live D1 through `wrangler d1 execute BENCH_DB --remote`',
    '  --local-file  local SQLite file (fixture proof only; no network, no credentials)',
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
    } else if (argument === '--dry-run' || argument === '--apply' || argument === '--verify') {
      const mode = argument.slice(2);
      if (args.mode !== undefined && args.mode !== mode) {
        throw new UsageError('choose exactly one of --dry-run, --apply, --verify');
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
export function buildStatements({ expectToken, minRemainingMs, runIds = [] }) {
  const guard = lockGuardSql(expectToken, minRemainingMs);
  const parkProfile = `UPDATE benchmark_profiles
SET status = 'pending',
    run_id = NULL,
    requested_at = ${sqlString(PARKED_REQUESTED_AT)},
    updated_at = ${SQL_NOW_ISO}
WHERE status = 'running'
  AND `;
  return [
    runIds.length === 0
      ? null
      : `${parkProfile}run_id IN ${idList(runIds)}
  AND ${guard};`,
    runIds.length === 0
      ? null
      : `UPDATE benchmark_runs
SET status = 'failed',
    error = ${sqlString(CANCEL_ERROR)},
    completed_at = ${SQL_NOW_ISO}
WHERE status = 'running'
  AND id IN ${idList(runIds)}
  AND ${guard};`,
    `${parkProfile}(run_id IS NULL OR ${notRunning('benchmark_profiles.run_id')})
  AND ${guard};`,
    `UPDATE scheduler_chunks
SET status = 'completed',
    slot = NULL,
    token = NULL,
    lease_until = 0
WHERE status IN ('pending', 'queued', 'active')
  AND ${notRunning('scheduler_chunks.run_id')}
  AND ${guard};`,
    `UPDATE profile_remeasures
SET requested_at = ${sqlString(PARKED_REQUESTED_AT)},
    claimed_at = NULL
WHERE run_id IS NOT NULL
  AND ${notRunning('profile_remeasures.run_id')}
  AND ${guard};`,
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

function compare(before, after, { requireZeroLive }) {
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
    if (n('running_profiles') !== 0) failures.push(`running_profiles=${n('running_profiles')}`);
    if (n('cancelled_running_profiles_n') !== 0) {
      failures.push(`cancelled-run profiles still running=${n('cancelled_running_profiles_n')}`);
    }
    if (n('cancelled_still_claimed_profiles_n') !== 0) {
      failures.push(
        `profiles still claimed by a cancelled run=${n('cancelled_still_claimed_profiles_n')}`
      );
    }
    if (n('cancelled_unparked_claims_n') !== 0) {
      failures.push(
        `remeasure claims of cancelled runs still claimable=${n('cancelled_unparked_claims_n')}`
      );
    }
  }
  for (const key of Object.keys(before)) {
    if (CHANGED_BY_DESIGN.has(key)) continue;
    const expected = before[key];
    const actual = after[key];
    if (MONOTONE_FIELDS.has(key)) {
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

function report(sink, event, fields = {}) {
  sink(JSON.stringify({ event: `legacy_cancel_${event}`, ...fields }));
}

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
  const run = sql =>
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
          resolve(parseD1Entries(stdout).at(-1).results);
        } catch (error) {
          reject(error);
        }
      });
      if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
  return {
    read: sql => run(sql),
    write: async statements => {
      const changed = [];
      for (const statement of statements) {
        const results = await run(statement);
        changed.push(Number(results?.[0]?.changes ?? 0));
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
      const before = (await executor.read(stateSql()))[0];
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
      const statements = buildStatements({
        expectToken: args.expectToken,
        minRemainingMs: args.minRemainingMs,
        runIds: ids,
      });
      for (const [index, statement] of statements.entries()) {
        log('');
        log(`-- ${index + 1}/${statements.length}`);
        log(statement);
      }
      if (args.baselineOut !== undefined) log('');
      report(log, 'dry_run_ok', { statements: statements.length, writes: 0 });
      return EXIT.ok;
    }

    if (args.mode === 'apply') {
      const first = (await executor.read(runningRunsSql())).map(row => String(row.id));
      const before = (await executor.read(stateSql()))[0];
      report(log, 'before', before);
      const cancelled = new Set(first);
      let passes = 0;
      for (; passes < MAX_PASSES; passes += 1) {
        const ids = (await executor.read(runningRunsSql())).map(row => String(row.id));
        if (ids.length === 0) break;
        for (const id of ids) cancelled.add(id);
        const changed = await executor.write(
          buildStatements({
            expectToken: args.expectToken,
            minRemainingMs: args.minRemainingMs,
            runIds: ids,
          })
        );
        report(log, 'pass', { pass: passes + 1, runIds: ids, changed });
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
      const after = (await executor.read(stateSql()))[0];
      const [relock] = await executor.read(lockSql());
      report(log, 'after', after);
      const failures = compare(before, after, { requireZeroLive: true });
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
    const current = (await executor.read(stateSql()))[0];
    const failures = compare(baseline.state, current, { requireZeroLive: true });
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
