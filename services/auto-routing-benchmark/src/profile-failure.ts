import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  BenchmarkProfileFailureClassSchema,
  type BenchmarkProfileFailure,
  type BenchmarkProfileFailureClass,
  type BenchmarkProfileStatus,
} from '@kilocode/auto-routing-contracts';
import { sql, type SQL } from 'drizzle-orm';
import { stripVTControlCharacters } from 'node:util';
import { benchmarkProfiles, type BenchmarkProfileRowStatus } from './db-schema';

export type ProfileFailure = { failureClass: BenchmarkProfileFailureClass; reason: string };

type FailureTier = 'terminal' | 'model' | 'infrastructure';

/**
 * Terminal classes fail the profile permanently at once, without any attempt history. The
 * other tiers say what a dead lane's class should be when several chunks died (a
 * model-class cause outranks an outage) and whether the model-specific counter advances;
 * neither tier can make a retryable failure permanent by count. Only the proven
 * consecutive-attempt budget does.
 */
const FAILURE_TIER: Record<BenchmarkProfileFailureClass, FailureTier> = {
  catalog_absent: 'terminal',
  context_too_small: 'terminal',
  model_not_found: 'terminal',
  unsupported: 'terminal',
  provider_unavailable: 'model',
  model_resolution: 'model',
  ambiguous_execution: 'infrastructure',
  container_capacity: 'infrastructure',
  catalog_load: 'infrastructure',
  grader: 'infrastructure',
  run_timed_out: 'infrastructure',
  orphaned_claim: 'infrastructure',
  run_init_failed: 'infrastructure',
  unknown: 'infrastructure',
};

const TIER_SEVERITY: Record<FailureTier, number> = { infrastructure: 0, model: 1, terminal: 2 };

/**
 * Consecutive proven zero-progress failed attempts, counted across repetition counts and
 * ending with the attempt being recorded, before the failure is permanent. `> 5`, so the
 * sixth proven failed attempt with no newly completed valid case since the last progress or
 * explicit re-admission is terminal. Cancelled runs, runs not attempted, copied results and
 * operator-fenced legacy work never count (src/profile-failure-history.ts).
 *
 * Nothing else makes a retryable failure permanent. A row's own counter never does: only
 * the attempt history proves a failed run, so writers with no history (a pre-paid refusal,
 * an orphan sweep) can only leave a retryable row retryable. The failure tier still
 * separates model from infrastructure classes for the class reported by a dead lane.
 */
export const PROFILE_FAILURE_BUDGET = 6;
const RETRY_BACKOFF_MAX_HOURS = 24;

export function parseFailureClass(value: string | null): BenchmarkProfileFailureClass {
  const parsed = BenchmarkProfileFailureClassSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

/** The class that says most about the model: a dead lane caused by the model outranks an outage. */
export function mostSevereFailureClass(
  classes: readonly BenchmarkProfileFailureClass[]
): BenchmarkProfileFailureClass {
  const [first, ...rest] = classes;
  if (first === undefined) return 'unknown';
  return rest.reduce(
    (worst, next) =>
      TIER_SEVERITY[FAILURE_TIER[next]] > TIER_SEVERITY[FAILURE_TIER[worst]] ? next : worst,
    first
  );
}

/**
 * Column assignments of the failed transition. Counters advance from the row's own values
 * in the same UPDATE, so concurrent writers never lose an attempt. A retryable failure
 * waits `2^(attempts-1)` hours, up to a day, before a bulk requeue may take it.
 *
 * `streak` is the aggregate consecutive-failure count from the attempt history, including
 * this attempt, counted across repetition counts. A value of 0 means this run still failed
 * but completed new valid cases, so the streak restarts. Omitted by writers that have no
 * attempt history (a pre-paid refusal, an orphan sweep): those can never make a retryable
 * failure permanent, because a row counter is not proof of a failed run.
 */
export function profileFailureAssignments(
  failure: ProfileFailure,
  nowIso: string,
  streak?: number | SQL
) {
  const recorded = {
    failure_class: failure.failureClass,
    failure_reason: failure.reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH),
    updated_at: nowIso,
    completed_at: nowIso,
  };
  const tier = FAILURE_TIER[failure.failureClass];
  if (tier === 'terminal') {
    return {
      ...recorded,
      failure_attempts:
        streak === undefined ? sql`${benchmarkProfiles.failure_attempts} + 1` : streak,
      first_failed_at: sql`COALESCE(${benchmarkProfiles.first_failed_at}, ${nowIso})`,
      status: 'unavailable' as const,
      retry_after: null,
    };
  }
  const modelIncrement = tier === 'model' ? 1 : 0;
  if (streak === undefined) {
    return {
      ...recorded,
      failure_attempts: sql`${benchmarkProfiles.failure_attempts} + 1`,
      model_failure_attempts: sql`${benchmarkProfiles.model_failure_attempts} + ${modelIncrement}`,
      first_failed_at: sql`COALESCE(${benchmarkProfiles.first_failed_at}, ${nowIso})`,
      status: 'failed' as const,
      retry_after: sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${nowIso},
        '+' || MIN(${RETRY_BACKOFF_MAX_HOURS}, 1 << ${benchmarkProfiles.failure_attempts}) || ' hours')`,
    };
  }
  const exhausted = sql`(${streak}) >= ${PROFILE_FAILURE_BUDGET}`;
  return {
    ...recorded,
    failure_attempts: streak,
    model_failure_attempts:
      typeof streak === 'number' && streak === 0
        ? 0
        : sql`${benchmarkProfiles.model_failure_attempts} + ${modelIncrement}`,
    first_failed_at:
      typeof streak === 'number' && streak === 0
        ? nowIso
        : sql`CASE WHEN (${streak}) > 0 THEN COALESCE(${benchmarkProfiles.first_failed_at}, ${nowIso}) ELSE ${nowIso} END`,
    status: sql<BenchmarkProfileRowStatus>`CASE WHEN ${exhausted} THEN 'unavailable' ELSE 'failed' END`,
    retry_after: sql<
      string | null
    >`CASE WHEN ${exhausted} THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${nowIso},
      '+' || MIN(${RETRY_BACKOFF_MAX_HOURS}, 1 << MAX(0, (${streak}) - 1)) || ' hours') END`,
  };
}

/** Column assignments that clear failure history: a ready measurement or an admin re-admit. */
export const profileFailureResetAssignments = {
  failure_reason: null,
  failure_class: null,
  failure_attempts: 0,
  model_failure_attempts: 0,
  first_failed_at: null,
  retry_after: null,
};

export type ProfileStateRow = {
  status: BenchmarkProfileRowStatus;
  run_id: string | null;
  failure_reason: string | null;
  failure_class: string | null;
  failure_attempts: number;
  model_failure_attempts: number;
  first_failed_at: string | null;
  retry_after: string | null;
  completed_at: string | null;
  updated_at: string;
};

type FailureHistory = {
  failureClass: BenchmarkProfileFailureClass;
  attempts: number;
  firstFailedAt: string;
};

type RecordedFailure = FailureHistory & { reason: string | null; lastFailedAt: string };

type PermanentCause = Extract<BenchmarkProfileFailure, { kind: 'permanent' }>['cause'];

export type ProfileState =
  | { kind: 'pending'; history: FailureHistory | null }
  | { kind: 'running'; runId: string | null; history: FailureHistory | null }
  | { kind: 'ready'; runId: string | null }
  | {
      kind: 'retryable_failure';
      runId: string | null;
      failure: RecordedFailure;
      retryAfter: string;
    }
  | {
      kind: 'permanent_failure';
      runId: string | null;
      failure: RecordedFailure;
      cause: PermanentCause;
    };

function permanentCause(history: FailureHistory): PermanentCause {
  if (FAILURE_TIER[history.failureClass] === 'terminal') return 'terminal_class';
  // Retryable classes are permanent only after the proven consecutive-failure budget, so
  // the generic attempt budget is the honest cause. The model-specific cause remains a
  // readable value for rows diagnosed before that rule existed; new rows never get it.
  return 'infrastructure_budget_exhausted';
}

/** The one reader of a profile row's status and failure columns. */
export function parseProfileState(row: ProfileStateRow): ProfileState {
  const lastFailedAt = row.completed_at ?? row.updated_at;
  const history: FailureHistory | null =
    row.failure_attempts > 0 || row.status === 'failed' || row.status === 'unavailable'
      ? {
          failureClass: parseFailureClass(row.failure_class),
          attempts: Math.max(row.failure_attempts, 1),
          firstFailedAt: row.first_failed_at ?? lastFailedAt,
        }
      : null;
  switch (row.status) {
    case 'pending':
      return { kind: 'pending', history };
    case 'running':
      return { kind: 'running', runId: row.run_id, history };
    case 'ready':
      return { kind: 'ready', runId: row.run_id };
    case 'failed':
    case 'unavailable': {
      const failure = {
        failureClass: history?.failureClass ?? 'unknown',
        attempts: history?.attempts ?? 1,
        firstFailedAt: history?.firstFailedAt ?? lastFailedAt,
        reason: row.failure_reason,
        lastFailedAt,
      };
      return row.status === 'failed'
        ? {
            kind: 'retryable_failure',
            runId: row.run_id,
            failure,
            retryAfter: row.retry_after ?? lastFailedAt,
          }
        : { kind: 'permanent_failure', runId: row.run_id, failure, cause: permanentCause(failure) };
    }
  }
}

export function wireProfileStatus(state: ProfileState): BenchmarkProfileStatus {
  switch (state.kind) {
    case 'pending':
    case 'running':
    case 'ready':
      return state.kind;
    case 'retryable_failure':
    case 'permanent_failure':
      return 'failed';
  }
}

export function wireProfileFailure(state: ProfileState): BenchmarkProfileFailure | null {
  if (state.kind !== 'retryable_failure' && state.kind !== 'permanent_failure') return null;
  const shared = {
    failureClass: state.failure.failureClass,
    reason: state.failure.reason,
    attempts: state.failure.attempts,
    firstFailedAt: state.failure.firstFailedAt,
    lastFailedAt: state.failure.lastFailedAt,
  };
  return state.kind === 'retryable_failure'
    ? { kind: 'retryable', ...shared, retryAfter: state.retryAfter }
    : { kind: 'permanent', ...shared, cause: state.cause };
}

/**
 * Share of an entry's measured cases that must fail with one provider rejection for the
 * entry to be `unsupported` instead of ready at zero accuracy.
 */
export const UNSUPPORTED_REJECTION_SHARE = 0.95;

/**
 * Errors that are valid measurements or transient conditions, never a capability
 * rejection: content filters, throttles, provider 5xx, empty output, timeouts, dropped
 * connections. Matched against the raw error, before numbers are normalized away.
 */
const NOT_A_REJECTION =
  /content filter|too many requests|rate.?limit|throttl|\b429\b|\b(?:HTTP|status|code)\s*:?\s*5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|no output|time ?out|timed out|connection lost|try again|overloaded/i;

/**
 * An entry whose cases nearly all failed with the same provider rejection (tool use
 * unsupported, region blocked, a fixed context limit) measured a capability the model
 * lacks, not its accuracy. Timed-out cases and transient errors never count as a rejection.
 */
export function unsupportedRejection(
  rows: readonly { error: string | null; timed_out: number }[]
): ProfileFailure | null {
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.timed_out !== 0 || row.error === null) continue;
    const raw = stripVTControlCharacters(row.error);
    if (NOT_A_REJECTION.test(raw)) continue;
    const key = raw
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^Error: /, '');
    if (key !== '') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let top: { key: string; count: number } | null = null;
  for (const [key, count] of counts) {
    if (!top || count > top.count) top = { key, count };
  }
  if (!top || top.count < Math.ceil(rows.length * UNSUPPORTED_REJECTION_SHARE)) return null;
  return {
    failureClass: 'unsupported',
    reason: `${top.count} of ${rows.length} measured cases failed with the same provider rejection: ${top.key}`,
  };
}
