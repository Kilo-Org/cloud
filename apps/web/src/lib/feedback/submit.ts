import 'server-only';

import { desc, eq } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { user_feedback } from '@kilocode/db/schema';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@kilocode/web-shared/lib/config.server';
import { enforceFeedbackRateLimit } from '@/lib/feedback/rate-limit';
import { buildUserFeedbackSlackMessage } from '@/lib/feedback/slack-message';

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
 * Advisory-lock namespace for this surface. `cloudAgentNextFeedback.create`
 * uses its own, so the two feedback surfaces keep independent windows.
 */
const RATE_LIMIT_NAMESPACE = 'user_feedback_rate_limit';

/**
 * Best-effort notification to the Kilo Slack workspace. Uses an Incoming Webhook
 * URL so it is not coupled to any user/org Slack installation, and never blocks
 * or fails the submission.
 */
function notifySlack(input: SubmitUserFeedbackInput): void {
  if (!SLACK_USER_FEEDBACK_WEBHOOK_URL) return;

  fetch(SLACK_USER_FEEDBACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildUserFeedbackSlackMessage(input)),
  }).catch(error => {
    console.error('[UserFeedback] Failed to post to Slack webhook', error);
  });
}

/**
 * Persist one feedback submission for an authenticated user.
 *
 * The rate-limit read and the insert run in one transaction under the advisory
 * lock taken by {@link enforceFeedbackRateLimit}, so a concurrent submission
 * cannot slip between the read and the write.
 *
 * Throws {@link FeedbackRateLimitError} when the user submitted feedback within
 * the last {@link FEEDBACK_RATE_LIMIT_WINDOW_MS}.
 */
export async function submitUserFeedback(
  input: SubmitUserFeedbackInput
): Promise<SubmitUserFeedbackResult> {
  const inserted = await db.transaction(async (tx: DrizzleTransaction) => {
    await enforceFeedbackRateLimit(tx, {
      namespace: RATE_LIMIT_NAMESPACE,
      userId: input.userId,
      readMostRecentCreatedAt: async () => {
        const [mostRecent] = await tx
          .select({ created_at: user_feedback.created_at })
          .from(user_feedback)
          .where(eq(user_feedback.kilo_user_id, input.userId))
          .orderBy(desc(user_feedback.created_at))
          .limit(1);
        return mostRecent?.created_at;
      },
    });

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
