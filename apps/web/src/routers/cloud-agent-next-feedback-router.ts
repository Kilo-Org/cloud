import 'server-only';

import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_feedback } from '@kilocode/db/schema';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import * as z from 'zod';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@kilocode/web-shared/lib/config.server';
import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { feedbackPlainTextBlocks } from '@/lib/feedback/slack';

const recentMessageSchema = z.object({
  role: z.string().max(50),
  text: z.string().max(10_000),
  ts: z.number(),
});

const feedbackSessionTypeSchema = z.enum(['cloud-agent', 'remote', 'read-only']);

const feedbackSessionTypeLabels = {
  'cloud-agent': 'Cloud Agent',
  remote: 'Remote',
  'read-only': 'Read-only',
} as const satisfies Record<z.infer<typeof feedbackSessionTypeSchema>, string>;

const CreateCloudAgentFeedbackInputSchema = z.object({
  cloud_agent_session_id: z
    .string()
    .regex(
      /^(agent|workspace)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    )
    .optional(),
  kilo_session_id: containedKiloSessionIdSchema.optional(),
  session_type: feedbackSessionTypeSchema.optional(),
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
          session_type: input.session_type,
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
        const metadataLines = [
          `• session: ${input.kilo_session_id ?? 'unknown'}`,
          `• session type: ${
            input.session_type ? feedbackSessionTypeLabels[input.session_type] : 'unknown'
          }`,
        ];

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
            blocks: feedbackPlainTextBlocks(
              [
                'New Cloud Agent feedback:',
                ...metadataLines,
                '• feedback:',
                feedbackText || '<empty>',
              ].join('\n')
            ),
          }),
        }).catch(error => {
          console.error('[CloudAgentFeedback] Failed to post to Slack webhook', error);
        });
      }

      return inserted;
    }),
});
