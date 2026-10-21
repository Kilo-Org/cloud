import 'server-only';

import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_feedback } from '@kilocode/db/schema';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { containedKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { SLACK_USER_FEEDBACK_WEBHOOK_URL } from '@kilocode/web-shared/lib/config.server';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { enforceFeedbackRateLimit, isFeedbackRateLimitError } from '@/lib/feedback/rate-limit';
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

/** v1 Kilo sessions identify themselves with a UUID. */
const LEGACY_KILO_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kilo session ids are either a v1 UUID or the v2 `ses_` + 26 alphanumerics
 * contract. Only an id of one of those shapes may be used to build the admin
 * link that the Slack notification carries.
 */
const kiloSessionIdSchema = z
  .string()
  .refine(
    value =>
      containedKiloSessionIdSchema.safeParse(value).success ||
      LEGACY_KILO_SESSION_ID_PATTERN.test(value),
    { message: 'Invalid Kilo session id' }
  );

const CreateCloudAgentFeedbackInputSchema = z.object({
  cloud_agent_session_id: z
    .string()
    .regex(
      /^(agent|workspace)_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    )
    .optional(),
  kilo_session_id: kiloSessionIdSchema.optional(),
  session_type: feedbackSessionTypeSchema.optional(),
  organization_id: z.string().uuid().optional(),
  feedback_text: z.string().min(1).max(10_000),
  model: z.string().max(255).optional(),
  repository: z.string().max(500).optional(),
  is_streaming: z.boolean().optional(),
  message_count: z.number().int().nonnegative().optional(),
  recent_messages: z.array(recentMessageSchema).max(10).optional(),
});

type CloudAgentFeedbackInput = z.infer<typeof CreateCloudAgentFeedbackInputSchema>;

/** Advisory-lock namespace for this surface; the shared feedback path has its own. */
const RATE_LIMIT_NAMESPACE = 'cloud_agent_feedback_rate_limit';

/**
 * Insert one submission under the per-user feedback window. The window read and
 * the insert share a transaction and the advisory lock that
 * {@link enforceFeedbackRateLimit} takes, so two concurrent submissions from one
 * user cannot both observe an empty window.
 */
async function insertFeedback(userId: string, input: CloudAgentFeedbackInput) {
  return db.transaction(async tx => {
    await enforceFeedbackRateLimit(tx, {
      namespace: RATE_LIMIT_NAMESPACE,
      userId,
      readMostRecentCreatedAt: async () => {
        const [mostRecent] = await tx
          .select({ created_at: cloud_agent_feedback.created_at })
          .from(cloud_agent_feedback)
          .where(eq(cloud_agent_feedback.kilo_user_id, userId))
          .orderBy(desc(cloud_agent_feedback.created_at))
          .limit(1);
        return mostRecent?.created_at;
      },
    });

    const [row] = await tx
      .insert(cloud_agent_feedback)
      .values({
        kilo_user_id: userId,
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

    return row;
  });
}

/** Best-effort Slack notification; never blocks or fails the submission. */
function notifySlack(input: CloudAgentFeedbackInput): void {
  if (!SLACK_USER_FEEDBACK_WEBHOOK_URL) return;

  const metadataLines = [
    `• session: ${input.kilo_session_id ?? 'unknown'}`,
    `• session type: ${
      input.session_type ? feedbackSessionTypeLabels[input.session_type] : 'unknown'
    }`,
  ];

  const trimmedFeedback = input.feedback_text.trim();
  const feedbackText = trimmedFeedback.slice(0, 500) + (trimmedFeedback.length > 500 ? '...' : '');

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

export const cloudAgentNextFeedbackRouter = createTRPCRouter({
  create: baseProcedure
    .input(CreateCloudAgentFeedbackInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.organization_id) {
        await ensureOrganizationAccess(ctx, input.organization_id);
      }

      let inserted: { id: string };
      try {
        inserted = await insertFeedback(ctx.user.id, input);
      } catch (error) {
        if (isFeedbackRateLimitError(error)) {
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
        }
        throw error;
      }

      notifySlack(input);

      return inserted;
    }),
});
