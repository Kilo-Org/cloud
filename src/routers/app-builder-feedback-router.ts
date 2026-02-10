import 'server-only';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { app_builder_feedback } from '@/db/schema';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/app-builder-service';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import * as z from 'zod';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@/lib/config.server';
import type { Owner } from '@/lib/integrations/core/types';

const recentMessageSchema = z.object({
  role: z.string().max(50),
  text: z.string().max(10_000),
  ts: z.number(),
});

const CreateAppBuilderFeedbackInputSchema = z.object({
  project_id: z.string().uuid(),
  organization_id: z.string().uuid().optional(),
  feedback_text: z.string().min(1).max(10_000),
  model: z.string().max(255).optional(),
  preview_status: z.string().max(100).optional(),
  is_streaming: z.boolean().optional(),
  message_count: z.number().int().nonnegative().optional(),
  recent_messages: z.array(recentMessageSchema).max(10).optional(),
});

export const appBuilderFeedbackRouter = createTRPCRouter({
  create: baseProcedure
    .input(CreateAppBuilderFeedbackInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.organization_id) {
        await ensureOrganizationAccess(ctx, input.organization_id);
      }

      const owner: Owner = input.organization_id
        ? { type: 'org', id: input.organization_id }
        : { type: 'user', id: ctx.user.id };

      const project = await getProjectWithOwnershipCheck(input.project_id, owner);
      const sessionId = project.session_id ?? undefined;

      const [inserted] = await db
        .insert(app_builder_feedback)
        .values({
          kilo_user_id: ctx.user.id,
          project_id: input.project_id,
          feedback_text: input.feedback_text,
          session_id: sessionId,
          model: input.model,
          preview_status: input.preview_status,
          is_streaming: input.is_streaming,
          message_count: input.message_count,
          recent_messages: input.recent_messages,
        })
        .returning({ id: app_builder_feedback.id });

      // Best-effort Slack notification
      if (SLACK_USER_FEEDBACK_WEBHOOK_URL) {
        const adminLink = `https://app.kilo.ai/admin/app-builder/${input.project_id}`;
        const trimmedFeedback = input.feedback_text.trim();
        const wasTruncated = trimmedFeedback.length > 500;
        const feedbackText = trimmedFeedback.slice(0, 500) + (wasTruncated ? '...' : '');

        fetch(SLACK_USER_FEEDBACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'New App Builder feedback',
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: 'New App Builder feedback :hammer_and_wrench:',
                },
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `<${adminLink}|View project>`,
                },
              },
              {
                type: 'section',
                text: {
                  type: 'plain_text',
                  text: feedbackText,
                },
              },
            ],
          }),
        }).catch(error => {
          console.error('[AppBuilderFeedback] Failed to post to Slack webhook', error);
        });
      }

      return inserted;
    }),
});
