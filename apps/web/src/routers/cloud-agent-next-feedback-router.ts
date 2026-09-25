import 'server-only';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { cloud_agent_feedback } from '@kilocode/db/schema';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import * as z from 'zod';
import { desc, eq } from 'drizzle-orm';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@/lib/config.server';

const DEFAULT_FEEDBACK_HISTORY_LIMIT = 5;
const MAX_FEEDBACK_HISTORY_LIMIT = 20;

const ListCloudAgentFeedbackInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_FEEDBACK_HISTORY_LIMIT).optional(),
});

/**
 * Normalize a Postgres `timestamptz` value to UTC ISO for the JSON boundary.
 * The driver returns text ("YYYY-MM-DD HH:MM:SS.sss+00"), which strict
 * validators reject. Return null for missing or invalid values.
 */
function toIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.includes('T')
    ? value
    : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

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
  cloud_agent_session_id: z.string().max(500).optional(),
  kilo_session_id: z.string().max(500).optional(),
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
  /**
   * The caller's own recent Cloud Agent feedback, newest first.
   *
   * Scoped to `kilo_user_id`, so a user can only read back what they submitted.
   * Used by the feedback dialog to show prior submissions and answer "did I
   * already report this?".
   */
  list: baseProcedure
    .input(ListCloudAgentFeedbackInputSchema.optional())
    .query(async ({ ctx, input }) => {
      const rows = await db
        .select({
          id: cloud_agent_feedback.id,
          feedback_text: cloud_agent_feedback.feedback_text,
          created_at: cloud_agent_feedback.created_at,
        })
        .from(cloud_agent_feedback)
        .where(eq(cloud_agent_feedback.kilo_user_id, ctx.user.id))
        .orderBy(desc(cloud_agent_feedback.created_at), desc(cloud_agent_feedback.id))
        .limit(input?.limit ?? DEFAULT_FEEDBACK_HISTORY_LIMIT);

      return rows.map(row => ({
        ...row,
        created_at: toIsoTimestamp(row.created_at),
      }));
    }),

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
        const sessionLink = input.kilo_session_id
          ? `<https://app.kilo.ai/admin/session-traces?sessionId=${input.kilo_session_id}|${input.kilo_session_id}>`
          : '_unknown_';

        const metadataLines = [
          `• session: ${sessionLink}`,
          `• session type: ${
            input.session_type ? feedbackSessionTypeLabels[input.session_type] : '_unknown_'
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
