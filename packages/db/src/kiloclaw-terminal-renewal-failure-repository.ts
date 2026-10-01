import { and, count, eq, lt, sql } from 'drizzle-orm';

import type { WorkerDb } from './client';
import { kiloclaw_terminal_renewal_failures, type KiloClawTerminalRenewalFailure } from './schema';
import {
  KiloClawTerminalRenewalFailureStatus,
  type KiloClawTerminalRenewalFailureCode,
  type KiloClawTerminalRenewalFailureResolutionActorType,
} from './schema-types';

// Pick the slice of Drizzle's client this module actually needs. Repository
// functions take a writer/reader subset so they compose with both the Worker
// runtime client (`getWorkerDb`) and the Node test client (`db` in
// apps/web/src/lib/drizzle.ts) without forcing either dependency on
// `@kilocode/db`. Both clients are produced by `drizzle(...)` and structurally
// satisfy `Pick<WorkerDb, 'insert' | 'select' | 'update'>`.
export type TerminalRenewalFailureRepository = Pick<WorkerDb, 'insert' | 'select' | 'update'>;

export type RecordTerminalRenewalFailureInput = {
  subscriptionId: string;
  /**
   * ISO timestamp of the subscription's due `credit_renewal_at` boundary
   * being recorded as terminally failed. Combined with `subscriptionId` to
   * make terminal-failure recording idempotent.
   */
  renewalBoundary: string;
  /**
   * Total automatic processing attempts observed for this boundary at the
   * time of recording. Persisted as the running attempt count; on duplicate
   * recording the stored count advances to GREATEST(existing, supplied).
   */
  attempts: number;
  failureCode: KiloClawTerminalRenewalFailureCode;
  failureMessage?: string | null;
  /**
   * ISO timestamp at which the failure was observed and recorded. On insert
   * this becomes both `first_failure_at` and `last_failure_at`. On duplicate
   * recording it advances `last_failure_at` only; `first_failure_at` is
   * preserved.
   */
  observedAt: string;
};

export type FindUnresolvedTerminalRenewalFailureKey = {
  subscriptionId: string;
  renewalBoundary: string;
};

export type ListUnresolvedTerminalRenewalFailuresOptions = {
  subscriptionId?: string;
  limit?: number;
};

export type CountUnresolvedTerminalRenewalFailuresOptions = {
  subscriptionId?: string;
};

export type ResolveTerminalRenewalFailureInput = {
  subscriptionId: string;
  renewalBoundary: string;
  actor: {
    type: KiloClawTerminalRenewalFailureResolutionActorType;
    id: string;
  };
  reason: string;
  resolvedAt: string;
};

export type WaiveTerminalRenewalFailureInput = ResolveTerminalRenewalFailureInput;

export type SupersedeTerminalRenewalFailuresInput = {
  subscriptionId: string;
  /**
   * The subscription's new (advanced) credit-renewal boundary. Every
   * unresolved failure for this subscription with a strictly older boundary
   * is marked superseded; failures at the new boundary remain unresolved
   * because they still represent the active credit-renewal decision.
   */
  currentBoundary: string;
  actor: {
    type: KiloClawTerminalRenewalFailureResolutionActorType;
    id: string;
  };
  supersededAt: string;
};

/**
 * Record (insert or accumulate) a terminal credit-renewal failure for a
 * subscription-renewal boundary.
 *
 * - First call inserts an `unresolved` row with `first_failure_at =
 *   last_failure_at = observedAt`.
 * - Subsequent calls for the same `(subscription_id, renewal_boundary)`
 *   while the row is still `unresolved` advance `last_failure_at`,
 *   `last_failure_code`, and `last_failure_message`, and bump
 *   `attempt_count` to `GREATEST(existing, supplied)`. `first_failure_at`
 *   is preserved.
 *
 * Caller is responsible for validating that `failureCode` qualifies as a
 * terminal system failure and that `attempts` satisfies the configured
 * automatic-retry budget. This repository persists what the caller decided;
 * it does not re-evaluate retry policy.
 */
export async function recordTerminalRenewalFailure(
  database: TerminalRenewalFailureRepository,
  input: RecordTerminalRenewalFailureInput
): Promise<KiloClawTerminalRenewalFailure> {
  const [row] = await database
    .insert(kiloclaw_terminal_renewal_failures)
    .values({
      subscription_id: input.subscriptionId,
      renewal_boundary: input.renewalBoundary,
      status: KiloClawTerminalRenewalFailureStatus.Unresolved,
      attempt_count: input.attempts,
      first_failure_at: input.observedAt,
      last_failure_at: input.observedAt,
      last_failure_code: input.failureCode,
      last_failure_message: input.failureMessage ?? null,
    })
    .onConflictDoUpdate({
      target: [
        kiloclaw_terminal_renewal_failures.subscription_id,
        kiloclaw_terminal_renewal_failures.renewal_boundary,
      ],
      set: {
        attempt_count: sql`GREATEST(${kiloclaw_terminal_renewal_failures.attempt_count}, ${input.attempts})`,
        last_failure_at: sql`GREATEST(${kiloclaw_terminal_renewal_failures.last_failure_at}, ${input.observedAt}::timestamptz)`,
        last_failure_code: input.failureCode,
        last_failure_message: input.failureMessage ?? null,
        updated_at: sql`now()`,
      },
      setWhere: eq(
        kiloclaw_terminal_renewal_failures.status,
        KiloClawTerminalRenewalFailureStatus.Unresolved
      ),
    })
    .returning();

  if (row) return row;

  const [existing] = await database
    .select()
    .from(kiloclaw_terminal_renewal_failures)
    .where(
      and(
        eq(kiloclaw_terminal_renewal_failures.subscription_id, input.subscriptionId),
        eq(kiloclaw_terminal_renewal_failures.renewal_boundary, input.renewalBoundary)
      )
    )
    .limit(1);

  if (!existing) {
    throw new Error('terminal_renewal_failure_conflict_row_missing');
  }

  return existing;
}

/**
 * Fetch the unresolved terminal failure for a subscription-renewal boundary,
 * if any. Used by downstream enforcement to skip suspension/destruction work
 * for protected boundaries. Returns `null` for resolved, waived, superseded,
 * or absent rows. The lookup is served by the partial index on
 * `(subscription_id, renewal_boundary) WHERE status = 'unresolved'` so it is
 * cheap enough to run on the enforcement hot path.
 */
export async function findUnresolvedTerminalRenewalFailure(
  database: TerminalRenewalFailureRepository,
  key: FindUnresolvedTerminalRenewalFailureKey
): Promise<KiloClawTerminalRenewalFailure | null> {
  const rows = await database
    .select()
    .from(kiloclaw_terminal_renewal_failures)
    .where(
      and(
        eq(kiloclaw_terminal_renewal_failures.subscription_id, key.subscriptionId),
        eq(kiloclaw_terminal_renewal_failures.renewal_boundary, key.renewalBoundary),
        eq(
          kiloclaw_terminal_renewal_failures.status,
          KiloClawTerminalRenewalFailureStatus.Unresolved
        )
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * List unresolved terminal renewal failures for operator diagnostics, oldest
 * `first_failure_at` first. Optionally scope to a single subscription or cap
 * the returned row count for paginated operator views.
 */
export async function listUnresolvedTerminalRenewalFailures(
  database: TerminalRenewalFailureRepository,
  options: ListUnresolvedTerminalRenewalFailuresOptions = {}
): Promise<KiloClawTerminalRenewalFailure[]> {
  const ordered = database
    .select()
    .from(kiloclaw_terminal_renewal_failures)
    .where(unresolvedTerminalRenewalFailuresPredicate(options.subscriptionId))
    .orderBy(kiloclaw_terminal_renewal_failures.first_failure_at);

  if (options.limit !== undefined) {
    return await ordered.limit(options.limit);
  }
  return await ordered;
}

export async function countUnresolvedTerminalRenewalFailures(
  database: TerminalRenewalFailureRepository,
  options: CountUnresolvedTerminalRenewalFailuresOptions = {}
): Promise<number> {
  const [row] = await database
    .select({ count: count() })
    .from(kiloclaw_terminal_renewal_failures)
    .where(unresolvedTerminalRenewalFailuresPredicate(options.subscriptionId));

  return row?.count ?? 0;
}

function unresolvedTerminalRenewalFailuresPredicate(subscriptionId: string | undefined) {
  const statusPredicate = eq(
    kiloclaw_terminal_renewal_failures.status,
    KiloClawTerminalRenewalFailureStatus.Unresolved
  );

  if (!subscriptionId) {
    return statusPredicate;
  }

  return and(
    statusPredicate,
    eq(kiloclaw_terminal_renewal_failures.subscription_id, subscriptionId)
  );
}

/**
 * Mark a terminal renewal failure as resolved. Only succeeds when the row is
 * currently `unresolved`: the state invariant is enforced by the WHERE
 * clause, not by reading the row first. Returns the updated row, or `null`
 * when no unresolved row matched. Calling resolve again on the same boundary
 * is therefore a safe no-op.
 */
export async function markTerminalRenewalFailureResolved(
  database: TerminalRenewalFailureRepository,
  input: ResolveTerminalRenewalFailureInput
): Promise<KiloClawTerminalRenewalFailure | null> {
  const [row] = await database
    .update(kiloclaw_terminal_renewal_failures)
    .set({
      status: KiloClawTerminalRenewalFailureStatus.Resolved,
      resolution_actor_type: input.actor.type,
      resolution_actor_id: input.actor.id,
      resolution_at: input.resolvedAt,
      resolution_reason: input.reason,
    })
    .where(
      and(
        eq(kiloclaw_terminal_renewal_failures.subscription_id, input.subscriptionId),
        eq(kiloclaw_terminal_renewal_failures.renewal_boundary, input.renewalBoundary),
        eq(
          kiloclaw_terminal_renewal_failures.status,
          KiloClawTerminalRenewalFailureStatus.Unresolved
        )
      )
    )
    .returning();

  return row ?? null;
}

/**
 * Mark a terminal renewal failure as waived. Only succeeds when the row is
 * currently `unresolved`. Waiver removes enforcement protection without
 * pretending a successful renewal occurred: callers SHOULD also issue
 * out-of-band compensation (e.g. credit grant) if the user was charged or
 * denied a renewal they would otherwise have received. Returns the updated
 * row, or `null` when no unresolved row matched.
 */
export async function markTerminalRenewalFailureWaived(
  database: TerminalRenewalFailureRepository,
  input: WaiveTerminalRenewalFailureInput
): Promise<KiloClawTerminalRenewalFailure | null> {
  const [row] = await database
    .update(kiloclaw_terminal_renewal_failures)
    .set({
      status: KiloClawTerminalRenewalFailureStatus.Waived,
      resolution_actor_type: input.actor.type,
      resolution_actor_id: input.actor.id,
      resolution_at: input.resolvedAt,
      resolution_reason: input.reason,
    })
    .where(
      and(
        eq(kiloclaw_terminal_renewal_failures.subscription_id, input.subscriptionId),
        eq(kiloclaw_terminal_renewal_failures.renewal_boundary, input.renewalBoundary),
        eq(
          kiloclaw_terminal_renewal_failures.status,
          KiloClawTerminalRenewalFailureStatus.Unresolved
        )
      )
    )
    .returning();

  return row ?? null;
}

/**
 * Mark every unresolved terminal renewal failure for a subscription whose
 * recorded boundary is strictly older than `currentBoundary` as superseded.
 * Use when the subscription's `credit_renewal_at` advances past the failed
 * boundary so the failure no longer protects an active renewal decision.
 *
 * Returns the rows transitioned. Resolved, waived, and already-superseded
 * rows are left untouched: the WHERE clause requires `status = 'unresolved'`.
 * Failures at the current boundary are also preserved so the active renewal
 * remains protected from enforcement.
 */
export async function supersedeTerminalRenewalFailuresForBoundary(
  database: TerminalRenewalFailureRepository,
  input: SupersedeTerminalRenewalFailuresInput
): Promise<KiloClawTerminalRenewalFailure[]> {
  return await database
    .update(kiloclaw_terminal_renewal_failures)
    .set({
      status: KiloClawTerminalRenewalFailureStatus.Superseded,
      resolution_actor_type: input.actor.type,
      resolution_actor_id: input.actor.id,
      resolution_at: input.supersededAt,
      resolution_reason: 'subscription_boundary_advanced',
    })
    .where(
      and(
        eq(kiloclaw_terminal_renewal_failures.subscription_id, input.subscriptionId),
        lt(kiloclaw_terminal_renewal_failures.renewal_boundary, input.currentBoundary),
        eq(
          kiloclaw_terminal_renewal_failures.status,
          KiloClawTerminalRenewalFailureStatus.Unresolved
        )
      )
    )
    .returning();
}
