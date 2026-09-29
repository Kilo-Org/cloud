import 'server-only';

import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { user_feedback } from '@kilocode/db/schema';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@/lib/config.server';

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
 */
async function enforceFeedbackRateLimit(userId: string, now: number): Promise<void> {
  const [mostRecent] = await db
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
 * Throws {@link FeedbackRateLimitError} when the user submitted feedback within
 * the last {@link FEEDBACK_RATE_LIMIT_WINDOW_MS}.
 */
export async function submitUserFeedback(
  input: SubmitUserFeedbackInput
): Promise<SubmitUserFeedbackResult> {
  const now = Date.now();
  await enforceFeedbackRateLimit(input.userId, now);

  const [inserted] = await db
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

  notifySlack(input);

  return { id: inserted.id };
}
