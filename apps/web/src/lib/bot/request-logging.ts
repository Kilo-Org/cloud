import 'server-only';
import { db } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { eq, and, sql } from 'drizzle-orm';
import { after } from 'next/server';
import {
  bot_requests,
  bot_request_cloud_agent_sessions,
  type BotRequestStatus,
  type BotRequestStep,
  type BotRequestCloudAgentSessionStatus,
} from '@kilocode/db/schema';

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

type RecordBotRequestCloudAgentSessionParams = {
  botRequestId: string;
  spawnGroupId: string;
  cloudAgentSessionId: string;
  kiloSessionId?: string;
  mode?: 'code' | 'ask';
  githubRepo?: string;
  gitlabProject?: string;
  callbackStep?: number;
};

/**
 * Synchronously upsert a row in `bot_request_cloud_agent_sessions` by
 * `cloud_agent_session_id`. Idempotent so duplicate tool execution/callback
 * races do not create duplicate rows.
 */
export async function recordBotRequestCloudAgentSession(
  params: RecordBotRequestCloudAgentSessionParams
): Promise<void> {
  try {
    await db
      .insert(bot_request_cloud_agent_sessions)
      .values({
        bot_request_id: params.botRequestId,
        spawn_group_id: params.spawnGroupId,
        cloud_agent_session_id: params.cloudAgentSessionId,
        kilo_session_id: params.kiloSessionId ?? null,
        mode: params.mode ?? null,
        github_repo: params.githubRepo ?? null,
        gitlab_project: params.gitlabProject ?? null,
        callback_step: params.callbackStep ?? 0,
      })
      .onConflictDoNothing({
        target: bot_request_cloud_agent_sessions.cloud_agent_session_id,
      });
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'record-child-session' },
      extra: {
        botRequestId: params.botRequestId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      },
    });
  }
}

export async function getBotRequestCloudAgentSession(
  botRequestId: string,
  cloudAgentSessionId: string
) {
  const [row] = await db
    .select()
    .from(bot_request_cloud_agent_sessions)
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, botRequestId),
        eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);

  return row ?? null;
}

type MarkTerminalParams = {
  botRequestId: string;
  cloudAgentSessionId: string;
  status: Extract<BotRequestCloudAgentSessionStatus, 'completed' | 'failed' | 'interrupted'>;
  kiloSessionId?: string;
  executionId?: string;
  errorMessage?: string;
};

export async function markBotRequestCloudAgentSessionTerminal(
  params: MarkTerminalParams
): Promise<void> {
  try {
    await db
      .update(bot_request_cloud_agent_sessions)
      .set({
        status: params.status,
        ...(params.kiloSessionId !== undefined && { kilo_session_id: params.kiloSessionId }),
        ...(params.executionId !== undefined && { execution_id: params.executionId }),
        ...(params.errorMessage !== undefined && { error_message: params.errorMessage }),
        terminal_at: sql`now()`,
      })
      .where(
        and(
          eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
          eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, params.cloudAgentSessionId)
        )
      );
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'mark-child-terminal' },
      extra: {
        botRequestId: params.botRequestId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      },
    });
  }
}

export async function getBotRequestCloudAgentSessionsForGroup(
  botRequestId: string,
  spawnGroupId: string
) {
  return db
    .select()
    .from(bot_request_cloud_agent_sessions)
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, botRequestId),
        eq(bot_request_cloud_agent_sessions.spawn_group_id, spawnGroupId)
      )
    )
    .orderBy(bot_request_cloud_agent_sessions.created_at);
}

export async function getBotRequestCloudAgentSessions(botRequestId: string) {
  return db
    .select()
    .from(bot_request_cloud_agent_sessions)
    .where(eq(bot_request_cloud_agent_sessions.bot_request_id, botRequestId))
    .orderBy(bot_request_cloud_agent_sessions.created_at);
}

/**
 * Atomically claim a completed group of child sessions for continuation.
 * Sets `continuation_started_at = now()` on all terminal rows in the group
 * only when no rows are still `prepared`/`running` and none have already been
 * claimed. Returns the updated rows for the first caller; racing callers get
 * an empty array.
 */
export async function claimCompletedBotRequestSessionGroup(
  botRequestId: string,
  spawnGroupId: string
) {
  const result = await db.execute(sql`
    UPDATE ${bot_request_cloud_agent_sessions}
    SET continuation_started_at = now()
    WHERE bot_request_id = ${botRequestId}
      AND spawn_group_id = ${spawnGroupId}
      AND continuation_started_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${bot_request_cloud_agent_sessions}
        WHERE bot_request_id = ${botRequestId}
          AND spawn_group_id = ${spawnGroupId}
          AND status IN ('prepared', 'running')
      )
    RETURNING *
  `);

  return result.rows as Array<typeof bot_request_cloud_agent_sessions.$inferSelect>;
}
