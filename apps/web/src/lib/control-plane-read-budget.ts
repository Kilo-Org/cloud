import 'server-only';

import { TRPCError } from '@trpc/server';
import { RequestDeadlineError, withDeadline } from '@kilocode/event-service';
import { CONTROL_PLANE_PROCEDURE_BUDGET_MS } from '@kilocode/web-shared/lib/trpc/control-plane-budget';

/**
 * Budget held back from the mobile procedure budget so a read that expires
 * still sends its answer before that outer budget turns the whole call into an
 * opaque `INTERNAL_SERVER_ERROR`.
 */
const RESPONSE_SLACK_MS = 2_000;

/**
 * The context fields that say whether the caller has a mobile procedure
 * budget: `createTRPCContext` stamps `controlPlaneStartedAt` for a mobile
 * client only, so its presence is the same test the budget middleware makes.
 */
export type ControlPlaneReadClock = { controlPlaneStartedAt?: number };

export type ControlPlaneReadBudgetOptions<TResult> = {
  /** The procedure context (`ctx`); only the budget clock is read. */
  clock: ControlPlaneReadClock;
  /** Retryable copy for the deadline answer. Fixed text, never an upstream message. */
  message: string;
  /** The read. A fetch forwards `signal`; a database read can ignore it. */
  read: (signal: AbortSignal) => Promise<TResult>;
};

/**
 * Remaining budget for one read, or null for a caller with no mobile budget
 * (web, CLI, tests).
 */
function remainingBudgetMs(clock: ControlPlaneReadClock): number | null {
  if (clock.controlPlaneStartedAt === undefined) return null;
  return (
    CONTROL_PLANE_PROCEDURE_BUDGET_MS -
    (performance.now() - clock.controlPlaneStartedAt) -
    RESPONSE_SLACK_MS
  );
}

/**
 * Bound one read inside a mobile control-plane procedure.
 *
 * The app gives each control-plane call 15 s and the server budgets the whole
 * procedure at 10 s (`control-plane-budget.ts`). Without a bound of its own a
 * read that stalls leaves that outer budget to fire, and the app is told the
 * procedure failed as an internal error 10 s later at the earliest. This runs
 * the read under what remains of the procedure budget (minus
 * {@link RESPONSE_SLACK_MS}) and answers the stall with `SERVICE_UNAVAILABLE`:
 * a retryable state the app already renders, reached before the outer budget.
 *
 * Web and CLI callers are returned untouched — they have no such budget and may
 * legitimately wait for a slow read.
 *
 * The deadline only settles this promise; a read that ignores `signal` keeps
 * running to its own end. That is the same trade the procedure budget makes and
 * the reason the settled answer stays retryable.
 */
export async function withControlPlaneReadBudget<TResult>({
  clock,
  message,
  read,
}: ControlPlaneReadBudgetOptions<TResult>): Promise<TResult> {
  const budgetMs = remainingBudgetMs(clock);
  if (budgetMs === null) return read(new AbortController().signal);
  if (budgetMs <= 0) throw unavailable(message);

  try {
    return await withDeadline(budgetMs, signal => read(signal));
  } catch (error) {
    if (error instanceof RequestDeadlineError) throw unavailable(message, error);
    throw error;
  }
}

function unavailable(message: string, cause?: unknown) {
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message, cause });
}
