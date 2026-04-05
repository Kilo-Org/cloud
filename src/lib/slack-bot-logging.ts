import 'server-only';
import { db } from '@/lib/drizzle';
import {
  slack_bot_requests,
  type NewSlackBotRequest,
  type SlackBotEventType,
  type SlackBotRequestStatus,
} from '@kilocode/db/schema';
import type { PlatformIntegration } from '@kilocode/db/schema';

type LogSlackBotRequestParams = {
  // Slack identifiers
  slackTeamId: string;
  slackTeamName?: string;
  slackChannelId: string;
  slackUserId: string;
  slackThreadTs?: string;

  // Event info
  eventType: SlackBotEventType;

  // Request details
  userMessage: string;

  // Response details
  status: SlackBotRequestStatus;
  errorMessage?: string;
  responseTimeMs?: number;

  // Model and tool usage
  modelUsed?: string;
  toolCallsMade?: string[];

  // Cloud Agent session (if spawned)
  cloudAgentSessionId?: string;

  // Integration info (optional - will be looked up if not provided)
  integration?: PlatformIntegration | null;
};

/**
 * Log a Slack bot request to the database for admin debugging and statistics
 */
export async function logSlackBotRequest(params: LogSlackBotRequestParams): Promise<void> {
  try {
    const truncatedMessage = params.userMessage.slice(0, 200);

    const record: NewSlackBotRequest = {
      // Ownership from integration
      owned_by_organization_id: params.integration?.owned_by_organization_id ?? null,
      owned_by_user_id: params.integration?.owned_by_user_id ?? null,
      platform_integration_id: params.integration?.id ?? null,

      // Slack identifiers
      slack_team_id: params.slackTeamId,
      slack_team_name: params.slackTeamName ?? null,
      slack_channel_id: params.slackChannelId,
      slack_user_id: params.slackUserId,
      slack_thread_ts: params.slackThreadTs ?? null,

      // Event info
      event_type: params.eventType,

      // Request details
      user_message: params.userMessage,
      user_message_truncated: truncatedMessage,

      // Response details
      status: params.status,
      error_message: params.errorMessage ?? null,
      response_time_ms: params.responseTimeMs ?? null,

      // Model and tool usage
      model_used: params.modelUsed ?? null,
      tool_calls_made: params.toolCallsMade ?? null,

      // Cloud Agent session
      cloud_agent_session_id: params.cloudAgentSessionId ?? null,
    };

    await db.insert(slack_bot_requests).values(record);
    console.log('[SlackBot:Logging] Request logged successfully');
  } catch (error) {
    // Don't let logging failures break the main flow
    console.error('[SlackBot:Logging] Failed to log request:', error);
  }
}
