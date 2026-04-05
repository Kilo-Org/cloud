import 'server-only';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { user_feedback } from '@kilocode/db/schema';
import * as z from 'zod';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@/lib/config.server';

const CreateUserFeedbackInputSchema = z.object({
  feedback_text: z.string().optional().default(''),
  feedback_for: z.string().min(1).default(FeedbackFor.Unknown),
  feedback_batch: z.string().min(1).optional(),
  source: z.string().min(1).default(FeedbackSource.Web),
  context_json: z.record(z.string(), z.unknown()).default({}),
});

export const userFeedbackRouter = createTRPCRouter({
  create: baseProcedure.input(CreateUserFeedbackInputSchema).mutation(async ({ ctx, input }) => {
    const [inserted] = await db
      .insert(user_feedback)
      .values({
        kilo_user_id: ctx.user.id,
        feedback_text: input.feedback_text,
        feedback_for: input.feedback_for,
        feedback_batch: input.feedback_batch,
        source: input.source,
        context_json: input.context_json,
      })
      .returning({ id: user_feedback.id });

    // Best-effort notification to the Kilo Slack workspace.
    // This uses an Incoming Webhook URL so it is not coupled to any user/org Slack installation.
    if (SLACK_USER_FEEDBACK_WEBHOOK_URL) {
      const textLines = [
        '*New user feedback:* :old_man_yells_at_kilo:',
        `• user: \`${ctx.user.id}\``,
        `• for: \`${input.feedback_for}\``,
        `• source: \`${input.source}\``,
        input.feedback_batch ? `• batch: \`${input.feedback_batch}\`` : null,
        '',
        `• raw feedback:`,
        '```',
        input.feedback_text?.trim() ? input.feedback_text.trim() : '_<empty>_',
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

    return inserted;
  }),
});
