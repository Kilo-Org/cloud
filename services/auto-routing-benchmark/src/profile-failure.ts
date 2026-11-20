import {
  BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH,
  BenchmarkProfileFailureClassSchema,
  type BenchmarkProfileFailure,
  type BenchmarkProfileFailureClass,
  type BenchmarkProfileStatus,
} from '@kilocode/auto-routing-contracts';
import { sql } from 'drizzle-orm';
import { stripVTControlCharacters } from 'node:util';
import { benchmarkProfiles, type BenchmarkProfileRowStatus } from './db-schema';

export type ProfileFailure = { failureClass: BenchmarkProfileFailureClass; reason: string };

type FailureTier = 'terminal' | 'model' | 'infrastructure';

/**
 * Terminal classes fail the profile permanently at once. Model classes count against the
 * model's budget. Infrastructure classes say nothing about the model and count only
 * toward the overall budget, so an outage that never clears still ends.
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

/** Runs failed for a model-transient class since the last ready measurement before the failure is permanent. */
export const PROFILE_MODEL_FAILURE_BUDGET = 3;
/** Consecutive failed runs of any retryable class before the failure is permanent. */
export const PROFILE_FAILURE_BUDGET = 5;
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
 */
export function profileFailureAssignments(failure: ProfileFailure, nowIso: string) {
  const recorded = {
    failure_class: failure.failureClass,
    failure_reason: failure.reason.slice(0, BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH),
    failure_attempts: sql`${benchmarkProfiles.failure_attempts} + 1`,
    first_failed_at: sql`COALESCE(${benchmarkProfiles.first_failed_at}, ${nowIso})`,
    updated_at: nowIso,
    completed_at: nowIso,
  };
  const tier = FAILURE_TIER[failure.failureClass];
  if (tier === 'terminal') {
    return { ...recorded, status: 'unavailable' as const, retry_after: null };
  }
  const modelIncrement = tier === 'model' ? 1 : 0;
  const exhausted = sql`(${benchmarkProfiles.model_failure_attempts} + ${modelIncrement} >= ${PROFILE_MODEL_FAILURE_BUDGET}
    OR ${benchmarkProfiles.failure_attempts} + 1 >= ${PROFILE_FAILURE_BUDGET})`;
  return {
    ...recorded,
    model_failure_attempts: sql`${benchmarkProfiles.model_failure_attempts} + ${modelIncrement}`,
    status: sql<BenchmarkProfileRowStatus>`CASE WHEN ${exhausted} THEN 'unavailable' ELSE 'failed' END`,
    retry_after: sql<
      string | null
    >`CASE WHEN ${exhausted} THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${nowIso},
      '+' || MIN(${RETRY_BACKOFF_MAX_HOURS}, 1 << ${benchmarkProfiles.failure_attempts}) || ' hours') END`,
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
  modelAttempts: number;
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
  return history.modelAttempts >= PROFILE_MODEL_FAILURE_BUDGET
    ? 'model_budget_exhausted'
    : 'infrastructure_budget_exhausted';
}

/** The one reader of a profile row's status and failure columns. */
export function parseProfileState(row: ProfileStateRow): ProfileState {
  const lastFailedAt = row.completed_at ?? row.updated_at;
  const history: FailureHistory | null =
    row.failure_attempts > 0 || row.status === 'failed' || row.status === 'unavailable'
      ? {
          failureClass: parseFailureClass(row.failure_class),
          attempts: Math.max(row.failure_attempts, 1),
          modelAttempts: row.model_failure_attempts,
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
        modelAttempts: history?.modelAttempts ?? 0,
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
