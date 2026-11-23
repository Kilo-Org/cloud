import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { COPIED_CASE_RESULT_COLUMNS } from './profile-failure-history';
import { PROFILE_FAILURE_BUDGET } from './profile-failure';

/**
 * Read-only classification of benchmark history for the failure rehearsal. It answers the
 * question `profile_attempt_history` cannot answer for time before it existed: for every
 * exact pair at the current engine, which completed/failed runs are *proven* attempts.
 *
 * Evidence only:
 * - `progress` — the run holds a valid case result for the pair that is not a copy of an
 *   earlier run (exact column equality over every copied result column). A score of zero
 *   still counts.
 * - `failed` — the run holds a dead lane for the pair (`run_lane_failures`, durable) and no
 *   fresh valid result.
 * - `unknown` — anything else: no durable proof either way. It never counts as progress and
 *   never counts as a failed attempt.
 *
 * Admission and billing leave no measurement: a payer failure or a paid admission refusal
 * produces no result row and no lane death. Like any other `unknown`, it never extends the
 * proven failure tail (and can only shorten it).
 *
 * Nothing here writes. It is meant for a read-only copy of benchmark D1, bounded by router,
 * engine identity and a start time.
 */
export type ProvenAttemptOutcome = 'progress' | 'failed' | 'unknown';

export type ProvenAttemptRow = {
  model: string;
  /** Storage-form variant ('' = default). */
  variant: string;
  runId: string;
  startedAt: string;
  outcome: ProvenAttemptOutcome;
};

export type ProvenAttemptSummary = {
  model: string;
  variant: string;
  provenProgressRuns: number;
  provenFailedRuns: number;
  unknownRuns: number;
  /**
   * Proven failed runs in the newest unbroken tail, walking newest to oldest. Copied-only
   * and unattempted history is not in this list at all; an `unknown` run stops the walk
   * because it could hide either outcome.
   */
  provenFailedTail: number;
  tailStop: 'progress' | 'unknown' | 'exhausted';
};

/**
 * One row per completed/failed decider run that enqueued the pair, newest first. `?nnn`
 * bindings: 1 router, 2 engine identity, 3 earliest run start, 4 model (null = all),
 * 5 variant (null = all).
 */
export function provenAttemptHistorySql(): string {
  return `
SELECT attempt.model AS model, attempt.variant AS variant, attempt.run_id AS run_id,
       attempt.started_at AS started_at,
       CASE
         WHEN attempt.fresh_valid > 0 THEN 'progress'
         WHEN attempt.lane_failed = 1 THEN 'failed'
         ELSE 'unknown'
       END AS outcome
FROM (
  SELECT run_model.model AS model, run_model.variant AS variant,
         run.id AS run_id, run.started_at AS started_at,
         EXISTS (
           SELECT 1 FROM run_lane_failures AS lane
           WHERE lane.run_id = run.id AND lane.model = run_model.model
             AND lane.variant = run_model.variant
         ) AS lane_failed,
         (
           SELECT COUNT(*) FROM case_results AS cur
           WHERE cur.run_id = run.id AND cur.model = run_model.model
             AND cur.variant = run_model.variant
             AND cur.error IS NULL AND cur.timed_out = 0 AND cur.exit_code = 0
             AND NOT EXISTS (
               SELECT 1 FROM case_results AS prior
               JOIN benchmark_runs AS prior_run ON prior_run.id = prior.run_id
               WHERE prior.model = cur.model AND prior.variant = cur.variant
                 AND prior.case_id = cur.case_id AND prior.rep = cur.rep
                 AND prior_run.router = run.router
                 AND prior_run.engine_identity = run.engine_identity
                 AND prior_run.kind = 'decider'
                 AND prior_run.status IN ('completed', 'failed')
                 AND (prior_run.started_at, prior_run.id) < (run.started_at, run.id)
                 AND ${COPIED_CASE_RESULT_COLUMNS.map(
                   column => `prior.${column} IS cur.${column}`
                 ).join('\n                 AND ')}
             )
         ) AS fresh_valid
  FROM run_models AS run_model
  JOIN benchmark_runs AS run ON run.id = run_model.run_id
  WHERE run_model.enqueued = 1
    AND run.kind = 'decider'
    AND run.router = ?1
    AND run.engine_identity = ?2
    AND run.status IN ('completed', 'failed')
    AND run.started_at >= ?3
    AND (?4 IS NULL OR run_model.model = ?4)
    AND (?5 IS NULL OR run_model.variant = ?5)
) AS attempt
ORDER BY attempt.model ASC, attempt.variant ASC, attempt.started_at DESC, attempt.run_id DESC`;
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The same query with its five values inlined as quoted SQL literals, for a read-only
 * rehearsal shell (`wrangler d1 execute --local --command`). Values are escaped as SQLite
 * string literals; nothing here writes.
 */
export function provenAttemptHistorySqlFor(input: {
  router: AutoRouter;
  engineIdentity: string;
  sinceIso: string;
  model?: string;
  variant?: string;
}): string {
  return provenAttemptHistorySql()
    .replaceAll('?1', sqliteStringLiteral(input.router))
    .replaceAll('?2', sqliteStringLiteral(input.engineIdentity))
    .replaceAll('?3', sqliteStringLiteral(input.sinceIso))
    .replaceAll('?4', input.model === undefined ? 'NULL' : sqliteStringLiteral(input.model))
    .replaceAll('?5', input.variant === undefined ? 'NULL' : sqliteStringLiteral(input.variant));
}

type RawProvenAttempt = {
  model: string;
  variant: string;
  run_id: string;
  started_at: string;
  outcome: ProvenAttemptOutcome;
};

export async function listProvenAttempts(
  db: D1Database,
  input: {
    router: AutoRouter;
    engineIdentity: string;
    /** Earliest run start to consider. Bounds the rehearsal's read. */
    sinceIso: string;
    model?: string;
    variant?: string;
  }
): Promise<ProvenAttemptRow[]> {
  const result = await db
    .prepare(provenAttemptHistorySql())
    .bind(
      input.router,
      input.engineIdentity,
      input.sinceIso,
      input.model ?? null,
      input.variant ?? null
    )
    .all<RawProvenAttempt>();
  // The SQL aliases stay snake_case; D1 returns the stored column names, so map once here
  // instead of pretending the driver returns the domain row.
  return result.results.map(row => ({
    model: row.model,
    variant: row.variant,
    runId: row.run_id,
    startedAt: row.started_at,
    outcome: row.outcome,
  }));
}

/**
 * Per-pair counts and the newest unbroken proven failure tail. Rows must be ordered newest
 * first within a pair (`listProvenAttempts` returns them that way).
 */
export function summarizeProvenAttempts(rows: readonly ProvenAttemptRow[]): ProvenAttemptSummary[] {
  const byPair = new Map<string, ProvenAttemptRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.model, row.variant]);
    const list = byPair.get(key);
    if (list) list.push(row);
    else byPair.set(key, [row]);
  }
  return [...byPair.values()].map(pairRows => {
    let provenFailedTail = 0;
    let tailStop: ProvenAttemptSummary['tailStop'] = 'exhausted';
    for (const row of pairRows) {
      if (row.outcome === 'failed') {
        provenFailedTail += 1;
        continue;
      }
      tailStop = row.outcome === 'progress' ? 'progress' : 'unknown';
      break;
    }
    return {
      model: pairRows[0]?.model ?? '',
      variant: pairRows[0]?.variant ?? '',
      provenProgressRuns: pairRows.filter(row => row.outcome === 'progress').length,
      provenFailedRuns: pairRows.filter(row => row.outcome === 'failed').length,
      unknownRuns: pairRows.filter(row => row.outcome === 'unknown').length,
      provenFailedTail,
      tailStop,
    };
  });
}

/** Pairs whose durable evidence alone would already cross the proven-failure budget. */
export function permanentByEvidence(
  summaries: readonly ProvenAttemptSummary[],
  budget: number = PROFILE_FAILURE_BUDGET
): ProvenAttemptSummary[] {
  return summaries.filter(summary => summary.provenFailedTail >= budget);
}
