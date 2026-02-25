import 'server-only';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { cloud_agent_feedback } from '@/db/schema';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import * as z from 'zod';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@/lib/config.server';

const recentMessageSchema = z.object({
  role: z.string().max(50),
  text: z.string().max(10_000),
  ts: z.number(),
});

const CreateCloudAgentFeedbackInputSchema = z.object({
  cloud_agent_session_id: z.string().max(500).optional(),
  kilo_session_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
  feedback_text: z.string().min(1).max(10_000),
  model: z.string().max(255).optional(),
  repository: z.string().max(500).optional(),
  is_streaming: z.boolean().optional(),
  message_count: z.number().int().nonnegative().optional(),
  recent_messages: z.array(recentMessageSchema).max(10).optional(),
});

export const cloudAgentNextFeedbackRouter = createTRPCRouter({
  create: baseProcedure
    .input(CreateCloudAgentFeedbackInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.organization_id) {
        await ensureOrganizationAccess(ctx, input.organization_id);
      }

      const [inserted] = await db
        .insert(cloud_agent_feedback)
        .values({
          kilo_user_id: ctx.user.id,
          cloud_agent_session_id: input.cloud_agent_session_id,
          organization_id: input.organization_id,
          feedback_text: input.feedback_text,
          model: input.model,
          repository: input.repository,
          is_streaming: input.is_streaming,
          message_count: input.message_count,
          recent_messages: input.recent_messages,
        })
        .returning({ id: cloud_agent_feedback.id });

      // Best-effort Slack notification
      if (SLACK_USER_FEEDBACK_WEBHOOK_URL) {
        const sessionLink = input.kilo_session_id
          ? `<https://app.kilo.ai/admin/session-traces?sessionId=${input.kilo_session_id}|${input.kilo_session_id}>`
          : '_unknown_';

        const metadataLines = [`• session: ${sessionLink}`];

        const trimmedFeedback = input.feedback_text.trim();
        const feedbackText =
          trimmedFeedback.slice(0, 500) + (trimmedFeedback.length > 500 ? '...' : '');

        fetch(SLACK_USER_FEEDBACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'New Cloud Agent feedback',
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*New Cloud Agent feedback:* :robot_face:' },
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: metadataLines.join('\n') },
              },
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '• feedback:' },
              },
              {
                type: 'section',
                text: { type: 'plain_text', text: feedbackText || '<empty>' },
              },
            ],
          }),
        }).catch(error => {
          console.error('[CloudAgentFeedback] Failed to post to Slack webhook', error);
        });
      }

      return inserted;
    }),
});
