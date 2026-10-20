import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

/**
 * Shared per-user feedback limit.
 *
 * Every feedback surface posts into Kilo's Slack workspace, so the limit is a
 * content-level abuse control on top of escaping: one submission per user per
 * rolling window. Each surface passes its own advisory-lock namespace, so the
 * surfaces keep independent windows.
 *
 * The read that measures the window must run in the same transaction as the
 * insert and after {@link enforceFeedbackRateLimit} has taken the lock; see the
 * function's contract.
 */

/** Rolling window in which a single user may submit at most one piece of feedback. */
export const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Message returned to a limited caller. It states the limit and asks the caller
 * to batch, so an agent can self-correct instead of retrying blindly.
 */
export const FEEDBACK_RATE_LIMIT_MESSAGE =
  'Feedback is limited to 1 submission per minute per user. Please batch your feedback into one submission and try again.';

/**
 * Thrown when a user already submitted feedback within the rolling window.
 * Callers map this to their transport error shape (tRPC `TOO_MANY_REQUESTS`,
 * HTTP 429) while preserving {@link FeedbackRateLimitError.message}.
 */
export class FeedbackRateLimitError extends Error {
  /** Milliseconds until the next submission is allowed. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(FEEDBACK_RATE_LIMIT_MESSAGE);
    this.name = 'FeedbackRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isFeedbackRateLimitError(error: unknown): error is FeedbackRateLimitError {
  return error instanceof FeedbackRateLimitError;
}

/**
 * Serialize submissions per user and enforce the rolling window.
 *
 * Takes a transaction-scoped Postgres advisory lock keyed on the user id before
 * reading, so two concurrent submissions from the same user serialize: the
 * second waits for the first to commit, then observes its row and is refused.
 * Without the lock the read and the insert are separate statements, and both
 * callers could observe an empty window and both insert.
 *
 * `readMostRecentCreatedAt` must query through the same transaction, so it sees
 * the in-flight insert of a concurrent submission once the lock is released.
 * The `timestamptz` text Drizzle returns with `mode: 'string'` (for example
 * `2026-04-29 01:16:12.945+00`) is parsed here; unparseable legacy text does not
 * block future submissions.
 */
export async function enforceFeedbackRateLimit(
  tx: DrizzleTransaction,
  input: {
    /** Advisory-lock namespace; one per feedback surface. */
    namespace: string;
    userId: string;
    readMostRecentCreatedAt: () => Promise<string | null | undefined>;
    now?: number;
  }
): Promise<void> {
  // `pg_advisory_xact_lock` releases automatically on commit/rollback, so the
  // lock never outlives the transaction it guards. The first key namespaces the
  // surface (so it cannot contend with another feature's advisory locks);
  // `hashtext` maps the arbitrary user id (which is not always a UUID) to the
  // second key. A hash collision only serializes two users, never grants a
  // second submission.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${input.namespace}), hashtext(${input.userId}))`
  );

  const lastCreatedAt = await input.readMostRecentCreatedAt();
  if (!lastCreatedAt) return;

  const submittedAt = new Date(lastCreatedAt).getTime();
  if (Number.isNaN(submittedAt)) return;

  const elapsedMs = (input.now ?? Date.now()) - submittedAt;
  if (elapsedMs < FEEDBACK_RATE_LIMIT_WINDOW_MS) {
    throw new FeedbackRateLimitError(FEEDBACK_RATE_LIMIT_WINDOW_MS - Math.max(elapsedMs, 0));
  }
}
