import 'server-only';
import { db } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { after } from 'next/server';
import {
  bot_request_cloud_agent_sessions,
  bot_requests,
  type BotRequestStatus,
  type BotRequestStep,
} from '@kilocode/db/schema';
import type { TerminalBotRequestCloudAgentSessionStatus } from '@/lib/bot/cloud-agent-session-groups';

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

type MarkBotRequestCloudAgentSessionTerminalParams = {
  botRequestId: string;
  cloudAgentSessionId: string;
  status: TerminalBotRequestCloudAgentSessionStatus;
  executionId?: string;
  kiloSessionId?: string;
  errorMessage?: string;
  terminalAt?: string;
};

type RecordBotRequestCloudAgentSessionResultParams = {
  botRequestId: string;
  cloudAgentSessionId: string;
  finalMessage: string;
  fetchedAt?: string;
};

type RecordBotRequestCloudAgentSessionResultErrorParams = {
  botRequestId: string;
  cloudAgentSessionId: string;
  errorMessage: string;
};

const MAX_FINAL_MESSAGE_ERROR_LENGTH = 4000;

function truncateFinalMessageError(errorMessage: string): string {
  if (errorMessage.length <= MAX_FINAL_MESSAGE_ERROR_LENGTH) {
    return errorMessage;
  }

  return errorMessage.slice(0, MAX_FINAL_MESSAGE_ERROR_LENGTH);
}

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
      .onConflictDoUpdate({
        target: bot_request_cloud_agent_sessions.cloud_agent_session_id,
        set: {
          bot_request_id: params.botRequestId,
          spawn_group_id: params.spawnGroupId,
          ...(params.kiloSessionId !== undefined && { kilo_session_id: params.kiloSessionId }),
          ...(params.mode !== undefined && { mode: params.mode }),
          ...(params.githubRepo !== undefined && { github_repo: params.githubRepo }),
          ...(params.gitlabProject !== undefined && { gitlab_project: params.gitlabProject }),
          ...(params.callbackStep !== undefined && { callback_step: params.callbackStep }),
        },
      });
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'record-child-session' },
      extra: {
        botRequestId: params.botRequestId,
        spawnGroupId: params.spawnGroupId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      },
    });
  }
}

export async function markBotRequestCloudAgentSessionTerminalStrict(
  params: MarkBotRequestCloudAgentSessionTerminalParams
): Promise<boolean> {
  const [row] = await db
    .update(bot_request_cloud_agent_sessions)
    .set({
      status: params.status,
      terminal_at: params.terminalAt ?? new Date().toISOString(),
      error_message: params.errorMessage ?? null,
      ...(params.executionId !== undefined && { execution_id: params.executionId }),
      ...(params.kiloSessionId !== undefined && { kilo_session_id: params.kiloSessionId }),
    })
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
        eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, params.cloudAgentSessionId)
      )
    )
    .returning({ id: bot_request_cloud_agent_sessions.id });

  return Boolean(row);
}

export async function markBotRequestCloudAgentSessionTerminal(
  params: MarkBotRequestCloudAgentSessionTerminalParams
): Promise<void> {
  try {
    await markBotRequestCloudAgentSessionTerminalStrict(params);
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'mark-child-session-terminal' },
      extra: {
        botRequestId: params.botRequestId,
        cloudAgentSessionId: params.cloudAgentSessionId,
        status: params.status,
      },
    });
  }
}

export async function recordBotRequestCloudAgentSessionResultStrict(
  params: RecordBotRequestCloudAgentSessionResultParams
): Promise<boolean> {
  const [row] = await db
    .update(bot_request_cloud_agent_sessions)
    .set({
      final_message: params.finalMessage,
      final_message_fetched_at: params.fetchedAt ?? new Date().toISOString(),
      final_message_error: null,
    })
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
        eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, params.cloudAgentSessionId)
      )
    )
    .returning({ id: bot_request_cloud_agent_sessions.id });

  return Boolean(row);
}

export async function recordBotRequestCloudAgentSessionResult(
  params: RecordBotRequestCloudAgentSessionResultParams
): Promise<void> {
  try {
    await recordBotRequestCloudAgentSessionResultStrict(params);
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'record-child-session-result' },
      extra: {
        botRequestId: params.botRequestId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      },
    });
  }
}

export async function recordBotRequestCloudAgentSessionResultErrorStrict(
  params: RecordBotRequestCloudAgentSessionResultErrorParams
): Promise<boolean> {
  const [row] = await db
    .update(bot_request_cloud_agent_sessions)
    .set({
      final_message: null,
      final_message_fetched_at: null,
      final_message_error: truncateFinalMessageError(params.errorMessage),
    })
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
        eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, params.cloudAgentSessionId)
      )
    )
    .returning({ id: bot_request_cloud_agent_sessions.id });

  return Boolean(row);
}

export async function recordBotRequestCloudAgentSessionResultError(
  params: RecordBotRequestCloudAgentSessionResultErrorParams
): Promise<void> {
  try {
    await recordBotRequestCloudAgentSessionResultErrorStrict(params);
  } catch (error) {
    captureException(error, {
      tags: { component: 'bot-request-log', op: 'record-child-session-result-error' },
      extra: {
        botRequestId: params.botRequestId,
        cloudAgentSessionId: params.cloudAgentSessionId,
      },
    });
  }
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
