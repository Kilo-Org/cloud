import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  type AutoRouter,
  type BenchmarkPair,
} from '@kilocode/auto-routing-contracts';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { benchmarkProfiles, benchmarkRuns, caseResults, profileAttemptHistory } from './db-schema';
import {
  profileFailureAssignments,
  profileFailureResetAssignments,
  type ProfileFailure,
} from './profile-failure';
import { variantToStorage } from './reasoning-effort';

/**
 * Outcome semantics of `profile_attempt_history` (declared in `db-schema.ts`):
 * - `progress` — the run produced at least one newly completed valid case for the pair
 *   (a valid score of zero counts; a copied/reused row never does).
 * - `failed` — an actual attempt failed and produced no newly completed valid case.
 * - `reset` — explicit re-admission. It is not an attempt: it only moves the streak's
 *   lower bound forward.
 *
 * Cancelled runs, runs that were not attempted, operator-fenced legacy work and runs
 * whose only results were copied from earlier runs are never recorded; they neither
 * extend nor break the streak.
 *
 * Only proven attempts enter the table: a finalization that saw the run's own durable
 * results (and lane-failure evidence) calls {@link settleProfileRunAttempts}. Nothing is
 * inferred from `run_models.enqueued` rows, and nothing from `scheduler_executions`,
 * which the scheduler prunes after a day. Attempts made before the table existed are
 * unknown, not assumed: they keep the profile's stored status exactly, never extend a
 * ledger streak, and never make a pair permanent. The migration is create-only and there
 * is no history backfill.
 */
export const PROFILE_ATTEMPT_OUTCOMES = ['progress', 'failed', 'reset'] as const;
export type ProfileAttemptOutcome = (typeof PROFILE_ATTEMPT_OUTCOMES)[number];

/**
 * Every `case_results` column a prior result copy preserves: both reuse paths copy the
 * source row column for column and only replace `run_id`. Identity columns
 * (run_id/model/variant/case_id/rep) are compared separately, so two rows are the same
 * stored measurement exactly when these values are equal. A test pins this list to the
 * schema so a future result column cannot silently escape copy detection.
 */
export const COPIED_CASE_RESULT_COLUMNS = [
  'route_key',
  'score',
  'latency_ms',
  'cost_usd',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'error',
  'fallback_reason',
  'route_hit',
  'retried',
  'exit_code',
  'output_prefix',
  'event_count',
  'last_event_types',
  'tool_calls',
  'tool_names',
  'step_count',
  'final_finish_reason',
  'timed_out',
  'prompt_revision',
] as const;

export type CaseResultRow = typeof caseResults.$inferSelect;

/**
 * Deterministic stored-measurement signature. A row whose signature already exists in
 * an earlier run of the same pair at the same engine is a copy: the copy paths write the
 * source values unchanged, so a genuinely new measurement cannot collide except by
 * reproducing every measured value including latency, tokens and output prefix.
 */
export function caseResultSignature(
  row: Pick<CaseResultRow, 'case_id' | 'rep' | (typeof COPIED_CASE_RESULT_COLUMNS)[number]>
): string {
  return JSON.stringify([
    row.case_id,
    row.rep,
    ...COPIED_CASE_RESULT_COLUMNS.map(column => row[column] ?? null),
  ]);
}

/** A case result that is a real measurement: a wrong answer (score 0) is still valid. */
export function isValidNewCaseResult(
  row: Pick<CaseResultRow, 'error' | 'timed_out' | 'exit_code'>
) {
  return row.error === null && row.timed_out === 0 && row.exit_code === 0;
}

export type FreshCaseCount = { freshValid: number; copiedValid: number };

/**
 * Split a run's rows for one exact pair into newly measured valid cases and copies of
 * earlier runs' rows. Only rows with no error, no timeout and a clean exit are valid; the
 * score is irrelevant, so zero accuracy is progress. A copied row is never progress.
 */
export function splitFreshValidCases(
  rows: readonly CaseResultRow[],
  priorSignatures: ReadonlySet<string>
): FreshCaseCount {
  let freshValid = 0;
  let copiedValid = 0;
  for (const row of rows) {
    if (!isValidNewCaseResult(row)) continue;
    if (priorSignatures.has(caseResultSignature(row))) copiedValid += 1;
    else freshValid += 1;
  }
  return { freshValid, copiedValid };
}

/**
 * Every stored measurement of this pair at this engine from a strictly earlier run,
 * restricted to the run's own (case, repetition) slots. Used to recognise copied rows
 * deterministically from local source history, not from timing or lane bookkeeping that
 * the scheduler prunes.
 */
export async function priorResultSignatures(
  db: D1Database,
  input: {
    runId: string;
    router: AutoRouter;
    engineIdentity: string;
    model: string;
    /** Storage-form variant. */
    variant: string;
    slots: readonly { caseId: string; rep: number }[];
  }
): Promise<Set<string>> {
  if (input.slots.length === 0) return new Set();
  const orm = drizzle(db);
  const slotJson = JSON.stringify(input.slots);
  const prior = await orm
    .select({
      case_id: caseResults.case_id,
      rep: caseResults.rep,
      route_key: caseResults.route_key,
      score: caseResults.score,
      latency_ms: caseResults.latency_ms,
      cost_usd: caseResults.cost_usd,
      input_tokens: caseResults.input_tokens,
      cached_input_tokens: caseResults.cached_input_tokens,
      output_tokens: caseResults.output_tokens,
      reasoning_tokens: caseResults.reasoning_tokens,
      error: caseResults.error,
      fallback_reason: caseResults.fallback_reason,
      route_hit: caseResults.route_hit,
      retried: caseResults.retried,
      exit_code: caseResults.exit_code,
      output_prefix: caseResults.output_prefix,
      event_count: caseResults.event_count,
      last_event_types: caseResults.last_event_types,
      tool_calls: caseResults.tool_calls,
      tool_names: caseResults.tool_names,
      step_count: caseResults.step_count,
      final_finish_reason: caseResults.final_finish_reason,
      timed_out: caseResults.timed_out,
      prompt_revision: caseResults.prompt_revision,
    })
    .from(caseResults)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, caseResults.run_id))
    .where(
      and(
        eq(benchmarkRuns.router, input.router),
        eq(benchmarkRuns.engine_identity, input.engineIdentity),
        eq(benchmarkRuns.kind, 'decider'),
        inArray(benchmarkRuns.status, ['completed', 'failed']),
        eq(caseResults.model, input.model),
        eq(caseResults.variant, input.variant),
        sql`(${benchmarkRuns.started_at}, ${benchmarkRuns.id}) < (
          SELECT current.started_at, current.id FROM benchmark_runs AS current
          WHERE current.id = ${input.runId}
        )`,
        sql`EXISTS (
          SELECT 1 FROM json_each(${slotJson}) AS slot
          WHERE json_extract(slot.value, '$.caseId') = ${caseResults.case_id}
            AND json_extract(slot.value, '$.rep') = ${caseResults.rep}
        )`
      )
    );
  return new Set(prior.map(row => caseResultSignature(row)));
}

/**
 * Why an attempt was not recorded. None of these extend or break the streak, and none
 * of them is treated as progress.
 */
export const PROFILE_ATTEMPT_SKIP_REASONS = [
  /** The run never enqueued the pair (carried/skipped entry). */
  'not_attempted',
  /** Paused, cancelled, or an operator fence stopped the work. */
  'cancelled',
  /** Billing admission failed for the new paid flow: no model call happened. */
  'payer_failure',
  /** Operator-fenced legacy work: not this flow's attempt. */
  'fenced',
  /** The run only reused earlier results; a copy is not new progress. */
  'copied_only',
  /** No fresh valid case and no settled failure: nothing to record yet. */
  'not_settled',
] as const;
export type ProfileAttemptSkipReason = (typeof PROFILE_ATTEMPT_SKIP_REASONS)[number];

export type ProfileAttemptClassification =
  | { kind: 'progress'; freshValid: number; copiedValid: number }
  | { kind: 'failed'; failure: ProfileFailure; freshValid: 0; copiedValid: number }
  | { kind: 'skip'; reason: ProfileAttemptSkipReason };

export type ProfileAttemptClassificationInput = {
  /** `run_models.enqueued` for this run's pair. */
  enqueued: boolean;
  /** Set when the pause/cancel path stopped this pair's work (paid flow, caller abort). */
  cancelled: boolean;
  /**
   * Set when the new paid flow refused or failed to admit/reserve for this pair's case
   * runs. No model call happened, so it is neither an attempt nor a failure of the model.
   */
  payerFailure: boolean;
  /** Set on operator-fenced legacy work. */
  fenced: boolean;
  /** The run settled this pair as failed, or null when it completed it. */
  failure: ProfileFailure | null;
  freshValid: number;
  copiedValid: number;
};

/**
 * One attempt's outcome for the permanent-failure rule. A settled failure with at least
 * one newly completed valid case is progress: the streak restarts even though the entry
 * still fails (a dead lane, a partial measurement). A copied result never restarts it.
 *
 * Admission and billing are not model failures: a payer failure (insufficient credit, a
 * refused reservation, a failed paid admission) means no inference was requested, so it is
 * skipped like a cancellation and never counts toward the model's streak.
 */
export function classifyProfileAttempt(
  input: ProfileAttemptClassificationInput
): ProfileAttemptClassification {
  if (input.fenced) return { kind: 'skip', reason: 'fenced' };
  if (!input.enqueued) return { kind: 'skip', reason: 'not_attempted' };
  if (input.cancelled) return { kind: 'skip', reason: 'cancelled' };
  if (input.payerFailure) return { kind: 'skip', reason: 'payer_failure' };
  if (input.freshValid > 0) {
    return { kind: 'progress', freshValid: input.freshValid, copiedValid: input.copiedValid };
  }
  if (input.failure) {
    return {
      kind: 'failed',
      failure: input.failure,
      freshValid: 0,
      copiedValid: input.copiedValid,
    };
  }
  if (input.copiedValid > 0) return { kind: 'skip', reason: 'copied_only' };
  return { kind: 'skip', reason: 'not_settled' };
}

export type ProfileFailurePair = {
  router: AutoRouter;
  model: string;
  /** Storage-form variant. */
  variant: string;
  engineIdentity: string;
};

/**
 * Failed attempts in the current streak, counted across repetition counts, ending with
 * the attempt just recorded. The streak starts after the newest `progress`/`reset` marker
 * for the pair at this engine — progress being any run that completed a new valid case,
 * reset being an explicit re-admission. Nothing row-local bounds the streak: a row's
 * `first_failed_at` belongs to one repetition count, and counting from it would drop
 * failures recorded on a sibling repetition row.
 */
export function profileFailureStreakExpression(pair: ProfileFailurePair): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*) FROM ${profileAttemptHistory} AS attempt
    WHERE attempt.router = ${pair.router}
      AND attempt.model = ${pair.model}
      AND attempt.variant = ${pair.variant}
      AND attempt.engine_identity = ${pair.engineIdentity}
      AND attempt.outcome = 'failed'
      AND (attempt.attempted_at || char(31) || attempt.run_id) > COALESCE((
        SELECT marker.attempted_at || char(31) || marker.run_id
        FROM ${profileAttemptHistory} AS marker
        WHERE marker.router = ${pair.router}
          AND marker.model = ${pair.model}
          AND marker.variant = ${pair.variant}
          AND marker.engine_identity = ${pair.engineIdentity}
          AND marker.outcome IN ('progress', 'reset')
        ORDER BY marker.attempted_at DESC, marker.run_id DESC
        LIMIT 1
      ), '')
  )`;
}

export type ProfileAttemptRowInput = {
  pair: ProfileFailurePair;
  runId: string;
  repetitions: number;
  outcome: ProfileAttemptOutcome;
  failure: ProfileFailure | null;
  attemptedAt: string;
};

function attemptRow(input: ProfileAttemptRowInput) {
  return {
    router: input.pair.router,
    model: input.pair.model,
    variant: input.pair.variant,
    engine_identity: input.pair.engineIdentity,
    run_id: input.runId,
    repetitions: input.repetitions,
    outcome: input.outcome,
    failure_class: input.failure?.failureClass ?? null,
    failure_reason:
      input.failure?.reason?.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH) ?? null,
    attempted_at: input.attemptedAt,
  };
}

/** Idempotent attempt insert: the same run finalized twice records one attempt. */
export function profileAttemptInsertStatement(
  orm: DrizzleD1Database,
  input: ProfileAttemptRowInput
) {
  return orm.insert(profileAttemptHistory).values(attemptRow(input)).onConflictDoNothing();
}

/**
 * Explicit re-admission marker: moves the streak's lower bound forward. Not an attempt.
 * It only writes when the same batch's profile UPDATE actually re-admitted the pair: the
 * update sets `status='pending'` and stamps `requested_at`/`updated_at` with the
 * re-admission time, so a pair a concurrent claim kept out of the update gets no marker.
 * The guard deliberately ignores `invalidated_at`: re-admission must not discard
 * compatible prior results, so it no longer invalidates them.
 */
export const PROFILE_ATTEMPT_RESET_INSERT_SQL = `
INSERT INTO profile_attempt_history (
  router, model, variant, engine_identity, run_id, repetitions, outcome,
  failure_class, failure_reason, attempted_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'reset', NULL, NULL, ?7
WHERE EXISTS (
  SELECT 1 FROM benchmark_profiles
  WHERE router = ?1 AND model = ?2 AND variant = ?3
    AND engine_identity = ?4 AND repetitions = ?6
    AND status = 'pending' AND requested_at = ?7 AND updated_at = ?7
)
ON CONFLICT (router, model, variant, engine_identity, run_id) DO NOTHING`;

/**
 * The one write an explicit re-admission makes to the attempt history. It must be applied
 * in the same batch as the profile UPDATE that clears the failure history: the UPDATE's
 * streak read uses the row's pre-update `first_failed_at`, which the re-admission sets to
 * NULL, so without this marker the next failure would count the pre-admission streak.
 */
export function profileAdmissionResetStatement(
  db: D1Database,
  input: ProfileFailurePair & {
    repetitions: number;
    /**
     * The re-admission time. The batch's UPDATE writes it to `requested_at` and
     * `updated_at`, so the marker only writes for a row carrying this stamp.
     */
    admittedAt: string;
    /** Distinguishes a re-admission from an earlier one at the same instant. */
    requestId: string;
  }
): D1PreparedStatement {
  return db
    .prepare(PROFILE_ATTEMPT_RESET_INSERT_SQL)
    .bind(
      input.router,
      input.model,
      input.variant,
      input.engineIdentity,
      `admit:${input.admittedAt}:${input.requestId}`,
      input.repetitions,
      input.admittedAt
    );
}

export type SettleProfileAttempt = {
  entry: BenchmarkPair;
  /** `run_models.enqueued`: false for a skipped/carried entry, which is not an attempt. */
  enqueued?: boolean;
  /** Set when the run settled this entry as failed; null when it completed the entry. */
  failure: ProfileFailure | null;
  cancelled?: boolean;
  /** Paid admission/billing failed before inference: not an attempt, not a model failure. */
  payerFailure?: boolean;
  fenced?: boolean;
};

export type SettleProfileRunAttemptsInput = {
  runId: string;
  router: AutoRouter;
  engineIdentity: string;
  repetitions: number;
  nowIso?: string;
  /** This run's case results (`getCaseResults`). */
  rows: readonly CaseResultRow[];
  /** Every enqueued entry of the run, with its settled failure if it has one. */
  attempts: readonly SettleProfileAttempt[];
};

export type SettledProfileAttempt = {
  entry: BenchmarkPair;
  outcome: ProfileAttemptOutcome | 'skip';
  reason?: ProfileAttemptSkipReason;
  freshValid: number;
  copiedValid: number;
  permanent: boolean;
};

/**
 * The one call a decider run makes at finalization, before `markProfilesReadyForRun`:
 * it records one attempt per enqueued entry from the run's own results, applies the
 * failure transition with the aggregate consecutive-failure streak, and returns which
 * pairs became permanent. Safe to call twice: attempt inserts are keyed by run id and
 * every profile UPDATE keeps the `run_id` + `status='running'` no-clobber guard.
 *
 * Entries it skips (not attempted, cancelled, fenced, copied only) write nothing, so
 * they neither extend nor break the streak.
 */
export async function settleProfileRunAttempts(
  db: D1Database,
  input: SettleProfileRunAttemptsInput
): Promise<SettledProfileAttempt[]> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const orm = drizzle(db);
  const rowsByEntry = new Map<string, CaseResultRow[]>();
  for (const row of input.rows) {
    const key = JSON.stringify([row.model, row.variant]);
    const list = rowsByEntry.get(key);
    if (list) list.push(row);
    else rowsByEntry.set(key, [row]);
  }

  const assessments = await Promise.all(
    input.attempts.map(async attempt => {
      const variant = variantToStorage(attempt.entry.variant);
      if (
        attempt.enqueued === false ||
        attempt.cancelled === true ||
        attempt.payerFailure === true ||
        attempt.fenced === true
      ) {
        return { attempt, variant, freshValid: 0, copiedValid: 0 };
      }
      const rows = rowsByEntry.get(JSON.stringify([attempt.entry.model, variant])) ?? [];
      const priorSignatures = await priorResultSignatures(db, {
        runId: input.runId,
        router: input.router,
        engineIdentity: input.engineIdentity,
        model: attempt.entry.model,
        variant,
        slots: rows.map(row => ({ caseId: row.case_id, rep: row.rep })),
      });
      return { attempt, variant, ...splitFreshValidCases(rows, priorSignatures) };
    })
  );

  const settled: SettledProfileAttempt[] = [];
  const inserts: BatchItem<'sqlite'>[] = [];
  const updates: BatchItem<'sqlite'>[] = [];

  for (const { attempt, variant, freshValid, copiedValid } of assessments) {
    const pair: ProfileFailurePair = {
      router: input.router,
      model: attempt.entry.model,
      variant,
      engineIdentity: input.engineIdentity,
    };
    const classification = classifyProfileAttempt({
      enqueued: attempt.enqueued !== false,
      cancelled: attempt.cancelled === true,
      payerFailure: attempt.payerFailure === true,
      fenced: attempt.fenced === true,
      failure: attempt.failure,
      freshValid,
      copiedValid,
    });
    if (classification.kind === 'skip') {
      settled.push({
        entry: attempt.entry,
        outcome: 'skip',
        reason: classification.reason,
        freshValid,
        copiedValid,
        permanent: false,
      });
      continue;
    }
    inserts.push(
      profileAttemptInsertStatement(orm, {
        pair,
        runId: input.runId,
        repetitions: input.repetitions,
        outcome: classification.kind,
        failure: classification.kind === 'failed' ? classification.failure : null,
        attemptedAt: nowIso,
      })
    );
    if (classification.kind === 'failed') {
      const streak = profileFailureStreakExpression(pair);
      updates.push(
        orm
          .update(benchmarkProfiles)
          .set(profileFailureAssignments(classification.failure, nowIso, streak))
          .where(
            and(
              eq(benchmarkProfiles.router, input.router),
              eq(benchmarkProfiles.model, attempt.entry.model),
              eq(benchmarkProfiles.variant, variant),
              eq(benchmarkProfiles.engine_identity, input.engineIdentity),
              eq(benchmarkProfiles.repetitions, input.repetitions),
              eq(benchmarkProfiles.run_id, input.runId),
              eq(benchmarkProfiles.status, 'running')
            )
          )
      );
    } else if (attempt.failure) {
      // The entry still fails, but the run completed new valid cases: the streak restarts
      // and the row keeps its failure reason with a fresh one-hour retry window.
      updates.push(
        orm
          .update(benchmarkProfiles)
          .set({
            ...profileFailureResetAssignments,
            ...profileFailureAssignments(attempt.failure, nowIso, 0),
          })
          .where(
            and(
              eq(benchmarkProfiles.router, input.router),
              eq(benchmarkProfiles.model, attempt.entry.model),
              eq(benchmarkProfiles.variant, variant),
              eq(benchmarkProfiles.engine_identity, input.engineIdentity),
              eq(benchmarkProfiles.repetitions, input.repetitions),
              eq(benchmarkProfiles.run_id, input.runId),
              eq(benchmarkProfiles.status, 'running')
            )
          )
      );
    }
    settled.push({
      entry: attempt.entry,
      outcome: classification.kind,
      freshValid,
      copiedValid,
      permanent: false,
    });
  }

  const statements = [...inserts, ...updates];
  // All inserts precede all streak UPDATEs, so every aggregate sees its run's attempt.
  // Chunked because one run can hold far more entries than D1 accepts in one batch.
  for (let index = 0; index < statements.length; index += 40) {
    await orm.batch(
      statements.slice(index, index + 40) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
    );
  }

  if (settled.some(item => item.outcome === 'failed')) {
    const permanent = await orm
      .select({ model: benchmarkProfiles.model, variant: benchmarkProfiles.variant })
      .from(benchmarkProfiles)
      .where(
        and(eq(benchmarkProfiles.run_id, input.runId), eq(benchmarkProfiles.status, 'unavailable'))
      );
    const permanentKeys = new Set(permanent.map(row => JSON.stringify([row.model, row.variant])));
    for (const item of settled) {
      item.permanent = permanentKeys.has(
        JSON.stringify([item.entry.model, variantToStorage(item.entry.variant)])
      );
    }
  }
  return settled;
}
