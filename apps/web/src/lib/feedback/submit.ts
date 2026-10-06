import 'server-only';

import { desc, eq, sql } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { user_feedback } from '@kilocode/db/schema';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@kilocode/web-shared/lib/config.server';

/**
 * Shared feedback submission service.
 *
 * Both the `userFeedback.create` tRPC mutation (published in the MCP catalog and
 * reachable via `kilo_call`) and the HTTP `/feedback` endpoint funnel through
 * here so an authenticated agent gets the same storage and the same limit.
 *
 * Authentication is the caller's responsibility: it resolves the authenticated
 * user and passes the user id in. This module never reads auth headers itself.
 *
 * Storage: submissions are written to the existing `user_feedback` PostgreSQL
 * table in `apps/web`. `apps/web` has no Cloudflare D1 or R2 binding, so the
 * "d2" store maps to this table, which is where the repo already keeps
 * user feedback.
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

export type SubmitUserFeedbackInput = {
  /** Resolved authenticated user id. */
  userId: string;
  feedbackText?: string;
  feedbackFor?: string;
  feedbackBatch?: string;
  source?: string;
  contextJson?: Record<string, unknown>;
};

export type SubmitUserFeedbackResult = {
  id: string;
};

/**
 * Parse the PostgreSQL `timestamptz` text Drizzle returns with `mode: 'string'`
 * (for example `2026-04-29 01:16:12.945+00`). Returns null for unparseable text
 * so a malformed legacy row cannot block all future submissions.
 */
function parseCreatedAt(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Enforce the per-user rolling limit by reading the user's most recent
 * `user_feedback` row. `IDX_user_feedback_kilo_user_id` backs the lookup and
 * `IDX_user_feedback_created_at` backs the ordering.
 *
 * Runs inside the same transaction as the insert and under the per-user
 * advisory lock taken by {@link submitUserFeedback}, so a concurrent
 * submission cannot slip between this read and the write.
 */
async function enforceFeedbackRateLimit(
  tx: DrizzleTransaction,
  userId: string,
  now: number
): Promise<void> {
  const [mostRecent] = await tx
    .select({ created_at: user_feedback.created_at })
    .from(user_feedback)
    .where(eq(user_feedback.kilo_user_id, userId))
    .orderBy(desc(user_feedback.created_at))
    .limit(1);

  if (!mostRecent) return;

  const submittedAt = parseCreatedAt(mostRecent.created_at);
  if (submittedAt === null) return;

  const elapsedMs = now - submittedAt;
  if (elapsedMs < FEEDBACK_RATE_LIMIT_WINDOW_MS) {
    throw new FeedbackRateLimitError(FEEDBACK_RATE_LIMIT_WINDOW_MS - Math.max(elapsedMs, 0));
  }
}

/**
 * Best-effort notification to the Kilo Slack workspace. Uses an Incoming Webhook
 * URL so it is not coupled to any user/org Slack installation, and never blocks
 * or fails the submission.
 */
function notifySlack(input: SubmitUserFeedbackInput): void {
  if (!SLACK_USER_FEEDBACK_WEBHOOK_URL) return;

  const textLines = [
    '*New user feedback:* :old_man_yells_at_kilo:',
    `• user: \`${input.userId}\``,
    `• for: \`${input.feedbackFor ?? FeedbackFor.Unknown}\``,
    `• source: \`${input.source ?? FeedbackSource.Unknown}\``,
    input.feedbackBatch ? `• batch: \`${input.feedbackBatch}\`` : null,
    '',
    '• raw feedback:',
    '```',
    input.feedbackText?.trim() ? input.feedbackText.trim() : '_<empty>_',
    '```',
  ].filter((line): line is string => !!line);

  fetch(SLACK_USER_FEEDBACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: textLines.join('\n') }),
  }).catch(error => {
    console.error('[UserFeedback] Failed to post to Slack webhook', error);
  });
}

/**
 * Persist one feedback submission for an authenticated user.
 *
 * The rate-limit read and the insert run in one transaction that first takes a
 * transaction-scoped Postgres advisory lock keyed on the user id. Two concurrent
 * submissions from the same user therefore serialize: the second waits for the
 * first to commit, then observes its row and is refused. Without the lock the
 * read and the insert are separate statements, and both callers could observe an
 * empty window and both insert, breaking the one-per-minute guarantee.
 *
 * Throws {@link FeedbackRateLimitError} when the user submitted feedback within
 * the last {@link FEEDBACK_RATE_LIMIT_WINDOW_MS}.
 */
export async function submitUserFeedback(
  input: SubmitUserFeedbackInput
): Promise<SubmitUserFeedbackResult> {
  const inserted = await db.transaction(async tx => {
    // `pg_advisory_xact_lock` releases automatically on commit/rollback, so the
    // lock never outlives the transaction it guards. The first key namespaces
    // this feature (so it cannot contend with another feature's advisory locks);
    // `hashtext` maps the arbitrary user id (which is not always a UUID) to the
    // second key. A hash collision only serializes two users, never grants a
    // second submission.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('user_feedback_rate_limit'), hashtext(${input.userId}))`
    );

    await enforceFeedbackRateLimit(tx, input.userId, Date.now());

    const [row] = await tx
      .insert(user_feedback)
      .values({
        kilo_user_id: input.userId,
        feedback_text: input.feedbackText ?? '',
        feedback_for: input.feedbackFor ?? FeedbackFor.Unknown,
        feedback_batch: input.feedbackBatch,
        source: input.source ?? FeedbackSource.Unknown,
        context_json: input.contextJson ?? {},
      })
      .returning({ id: user_feedback.id });

    return row;
  });

  notifySlack(input);

  return { id: inserted.id };
}
