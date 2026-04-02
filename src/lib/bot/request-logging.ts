import 'server-only';
import { db } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import { bot_requests, type BotRequestStatus, type BotRequestStep } from '@kilocode/db/schema';

type CreateBotRequestParams = {
  createdBy: string;
  organizationId: string | null;
  platformIntegrationId: string;
  platform: string;
  platformThreadId: string;
  platformMessageId: string | undefined;
  userMessage: string;
  modelUsed: string | undefined;
};

/**
 * Insert a pending bot_requests row at the start of message handling.
 * Returns the row ID on success, or undefined if the insert fails
 * (logging should never break the main flow).
 */
export async function createBotRequest(
  params: CreateBotRequestParams
): Promise<string | undefined> {
  try {
    const [row] = await db
      .insert(bot_requests)
      .values({
        created_by: params.createdBy,
        organization_id: params.organizationId,
        platform_integration_id: params.platformIntegrationId,
        platform: params.platform,
        platform_thread_id: params.platformThreadId,
        platform_message_id: params.platformMessageId ?? null,
        user_message: params.userMessage,
        model_used: params.modelUsed ?? null,
        status: 'pending',
      })
      .returning({ id: bot_requests.id });

    return row?.id;
  } catch (error) {
    captureException(error, { tags: { component: 'bot-request-log', op: 'create' } });
    return undefined;
  }
}

type UpdateBotRequestParams = {
  status?: BotRequestStatus;
  errorMessage?: string;
  modelUsed?: string;
  steps?: BotRequestStep[];
  responseTimeMs?: number;
};

async function performUpdate(id: string, params: UpdateBotRequestParams): Promise<void> {
  try {
    await db
      .update(bot_requests)
      .set({
        ...(params.status !== undefined && { status: params.status }),
        ...(params.errorMessage !== undefined && { error_message: params.errorMessage }),
        ...(params.modelUsed !== undefined && { model_used: params.modelUsed }),
        ...(params.steps !== undefined && { steps: params.steps }),
        ...(params.responseTimeMs !== undefined && { response_time_ms: params.responseTimeMs }),
      })
      .where(eq(bot_requests.id, id));
  } catch (error) {
    captureException(error, { tags: { component: 'bot-request-log', op: 'update' } });
  }
}

/**
 * Schedule an update to an existing bot_requests row via `after()`.
 * The write is deferred so it never blocks bot message processing.
 */
export function updateBotRequest(id: string, params: UpdateBotRequestParams): void {
  after(() => performUpdate(id, params));
}

/**
 * Persist `cloud_agent_session_id` synchronously so callback routes can
 * correlate on it immediately. Unlike `updateBotRequest`, this awaits
 * the DB write — use it only for fields that external systems depend on
 * before the current request finishes.
 */
export async function linkBotRequestToSession(
  botRequestId: string,
  cloudAgentSessionId: string
): Promise<void> {
  try {
    await db
      .update(bot_requests)
      .set({ cloud_agent_session_id: cloudAgentSessionId })
      .where(eq(bot_requests.id, botRequestId));
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'link-session' },
      extra: { botRequestId, cloudAgentSessionId },
    });
  }
}
