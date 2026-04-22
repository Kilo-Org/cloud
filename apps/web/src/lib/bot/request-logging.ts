import 'server-only';
import { db } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { after } from 'next/server';
import {
  bot_request_cloud_agent_sessions,
  bot_requests,
  type BotRequestCloudAgentSession,
  type BotRequestCloudAgentSessionStatus,
  type BotRequestStatus,
  type BotRequestStep,
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

export type TerminalBotRequestCloudAgentSessionStatus = Extract<
  BotRequestCloudAgentSessionStatus,
  'completed' | 'failed' | 'interrupted'
>;

export function isTerminalBotRequestCloudAgentSessionStatus(
  status: BotRequestCloudAgentSessionStatus
): status is TerminalBotRequestCloudAgentSessionStatus {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

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

export async function markBotRequestCloudAgentSessionTerminal(
  params: MarkBotRequestCloudAgentSessionTerminalParams
): Promise<void> {
  try {
    await db
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
      );
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

export async function recordBotRequestCloudAgentSessionResult(
  params: RecordBotRequestCloudAgentSessionResultParams
): Promise<void> {
  try {
    await db
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
      );
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

export async function recordBotRequestCloudAgentSessionResultError(
  params: RecordBotRequestCloudAgentSessionResultErrorParams
): Promise<void> {
  try {
    await db
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
      );
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

type BotRequestCloudAgentSessionGroup = {
  triggerSession: BotRequestCloudAgentSession | undefined;
  sessions: BotRequestCloudAgentSession[];
};

export type BotRequestCloudAgentSessionGroupReadiness =
  | { status: 'untracked'; sessions: [] }
  | {
      status: 'waiting-for-terminal';
      sessions: BotRequestCloudAgentSession[];
      waitingSessions: BotRequestCloudAgentSession[];
    }
  | {
      status: 'waiting-for-result';
      sessions: BotRequestCloudAgentSession[];
      missingResultSessions: BotRequestCloudAgentSession[];
    }
  | {
      status: 'result-error';
      sessions: BotRequestCloudAgentSession[];
      resultErrorSessions: BotRequestCloudAgentSession[];
    }
  | {
      status: 'terminal-failure';
      sessions: BotRequestCloudAgentSession[];
      failedSessions: BotRequestCloudAgentSession[];
    }
  | { status: 'ready'; sessions: BotRequestCloudAgentSession[] };

export async function getBotRequestCloudAgentSession(params: {
  botRequestId: string;
  cloudAgentSessionId: string;
}): Promise<BotRequestCloudAgentSession | undefined> {
  const [session] = await db
    .select()
    .from(bot_request_cloud_agent_sessions)
    .where(
      and(
        eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
        eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, params.cloudAgentSessionId)
      )
    )
    .limit(1);

  return session;
}

export async function getBotRequestCloudAgentSessionGroup(params: {
  botRequestId: string;
  cloudAgentSessionId: string;
}): Promise<BotRequestCloudAgentSessionGroup> {
  const triggerSession = await getBotRequestCloudAgentSession(params);
  if (!triggerSession) {
    return { triggerSession: undefined, sessions: [] };
  }

  const sessions = await db
    .select()
    .from(bot_request_cloud_agent_sessions)
    .where(
      triggerSession.spawn_group_id
        ? and(
            eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
            eq(bot_request_cloud_agent_sessions.spawn_group_id, triggerSession.spawn_group_id)
          )
        : and(
            eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
            eq(
              bot_request_cloud_agent_sessions.cloud_agent_session_id,
              triggerSession.cloud_agent_session_id
            )
          )
    )
    .orderBy(
      asc(bot_request_cloud_agent_sessions.callback_step),
      asc(bot_request_cloud_agent_sessions.created_at),
      asc(bot_request_cloud_agent_sessions.cloud_agent_session_id)
    );

  return { triggerSession, sessions };
}

export async function getBotRequestCloudAgentSessionGroupReadiness(params: {
  botRequestId: string;
  cloudAgentSessionId: string;
}): Promise<BotRequestCloudAgentSessionGroupReadiness> {
  const group = await getBotRequestCloudAgentSessionGroup(params);
  if (!group.triggerSession) {
    return { status: 'untracked', sessions: [] };
  }

  const waitingSessions = group.sessions.filter(
    session => !isTerminalBotRequestCloudAgentSessionStatus(session.status)
  );
  if (waitingSessions.length > 0) {
    return { status: 'waiting-for-terminal', sessions: group.sessions, waitingSessions };
  }

  const failedSessions = group.sessions.filter(session => session.status !== 'completed');
  if (failedSessions.length > 0) {
    return { status: 'terminal-failure', sessions: group.sessions, failedSessions };
  }

  const resultErrorSessions = group.sessions.filter(
    session => session.status === 'completed' && session.final_message_error
  );
  if (resultErrorSessions.length > 0) {
    return { status: 'result-error', sessions: group.sessions, resultErrorSessions };
  }

  const missingResultSessions = group.sessions.filter(session => !session.final_message);
  if (missingResultSessions.length > 0) {
    return { status: 'waiting-for-result', sessions: group.sessions, missingResultSessions };
  }

  return { status: 'ready', sessions: group.sessions };
}

export async function claimBotRequestCloudAgentSessionGroupContinuation(params: {
  botRequestId: string;
  cloudAgentSessionId: string;
}): Promise<boolean> {
  const readiness = await getBotRequestCloudAgentSessionGroupReadiness(params);
  if (
    readiness.status === 'untracked' ||
    readiness.status === 'waiting-for-terminal' ||
    readiness.status === 'waiting-for-result'
  ) {
    return false;
  }

  const group = await getBotRequestCloudAgentSessionGroup(params);
  if (!group.triggerSession || group.sessions.length !== readiness.sessions.length) return false;
  if (group.sessions.some(session => session.continuation_started_at)) {
    return false;
  }

  const waitingSessions = group.sessions.filter(
    session => !isTerminalBotRequestCloudAgentSessionStatus(session.status)
  );
  const failedSessions = group.sessions.filter(session => session.status !== 'completed');
  const resultErrorSessions = group.sessions.filter(
    session => session.status === 'completed' && session.final_message_error
  );
  const missingResultSessions = group.sessions.filter(session => !session.final_message);
  if (
    waitingSessions.length > 0 ||
    (failedSessions.length === 0 &&
      resultErrorSessions.length === 0 &&
      missingResultSessions.length > 0)
  ) {
    return false;
  }

  const updated = await db
    .update(bot_request_cloud_agent_sessions)
    .set({ continuation_started_at: new Date().toISOString() })
    .where(
      group.triggerSession.spawn_group_id
        ? and(
            eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
            eq(
              bot_request_cloud_agent_sessions.spawn_group_id,
              group.triggerSession.spawn_group_id
            ),
            isNull(bot_request_cloud_agent_sessions.continuation_started_at)
          )
        : and(
            eq(bot_request_cloud_agent_sessions.bot_request_id, params.botRequestId),
            eq(
              bot_request_cloud_agent_sessions.cloud_agent_session_id,
              group.triggerSession.cloud_agent_session_id
            ),
            isNull(bot_request_cloud_agent_sessions.continuation_started_at)
          )
    )
    .returning({ id: bot_request_cloud_agent_sessions.id });

  return updated.length === group.sessions.length;
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
