import 'server-only';
import { db } from '@/lib/drizzle';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  bot_request_cloud_agent_sessions,
  type BotRequestCloudAgentSession,
  type BotRequestCloudAgentSessionStatus,
} from '@kilocode/db/schema';

export type TerminalBotRequestCloudAgentSessionStatus = Extract<
  BotRequestCloudAgentSessionStatus,
  'completed' | 'failed' | 'interrupted'
>;

export function isTerminalBotRequestCloudAgentSessionStatus(
  status: BotRequestCloudAgentSessionStatus
): status is TerminalBotRequestCloudAgentSessionStatus {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
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

  const missingResultSessions = group.sessions.filter(
    session =>
      session.status === 'completed' && !session.final_message && !session.final_message_error
  );
  if (missingResultSessions.length > 0) {
    return { status: 'waiting-for-result', sessions: group.sessions, missingResultSessions };
  }

  const resultErrorSessions = group.sessions.filter(
    session => session.status === 'completed' && session.final_message_error
  );
  if (resultErrorSessions.length > 0) {
    return { status: 'result-error', sessions: group.sessions, resultErrorSessions };
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
  const missingResultSessions = group.sessions.filter(
    session =>
      session.status === 'completed' && !session.final_message && !session.final_message_error
  );
  if (
    waitingSessions.length > 0 ||
    (failedSessions.length === 0 && missingResultSessions.length > 0)
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
