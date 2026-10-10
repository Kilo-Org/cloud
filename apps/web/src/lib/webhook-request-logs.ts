import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getWorkerRequest, type CapturedRequest } from '@/lib/webhook-agent/webhook-agent-client';
import { fetchSessionSnapshot } from '@/lib/session-ingest-client';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import {
  v1BlobToLogEntries,
  v2SnapshotToLogEntries,
  type SessionLogEntry,
} from '@/lib/code-reviews/session-log';

export type WebhookRequestLogs = {
  logs: SessionLogEntry[];
  processStatus: CapturedRequest['processStatus'];
  logsReady: boolean;
};

export async function getWebhookRequestLogs(
  userId: string | undefined,
  organizationId: string | undefined,
  triggerId: string,
  requestId: string
): Promise<WebhookRequestLogs> {
  const result = await getWorkerRequest(userId, organizationId, triggerId, requestId);
  if (!result.success) {
    throw new TRPCError({
      code: result.status === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: result.status === 404 ? 'Request not found' : 'Failed to fetch request',
    });
  }

  const empty: WebhookRequestLogs = {
    logs: [],
    processStatus: result.data.processStatus,
    logsReady: false,
  };
  const cloudAgentSessionId = result.data.cloudAgentSessionId;
  if (!cloudAgentSessionId) return empty;

  const [v1, duplicateV1] = await db
    .select({ blobUrl: cliSessions.ui_messages_blob_url })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId),
        organizationId
          ? eq(cliSessions.organization_id, organizationId)
          : and(eq(cliSessions.kilo_user_id, userId ?? ''), isNull(cliSessions.organization_id))
      )
    )
    .limit(2);

  if (duplicateV1) return empty;
  if (v1) {
    if (!v1.blobUrl) return empty;
    let content: unknown;
    try {
      content = await getBlobContent(v1.blobUrl);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return empty;
      throw error;
    }
    if (content === null) return empty;
    return { ...empty, logs: v1BlobToLogEntries(content), logsReady: true };
  }

  const [v2, duplicateV2] = await db
    .select({ sessionId: cli_sessions_v2.session_id, userId: cli_sessions_v2.kilo_user_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId),
        organizationId
          ? eq(cli_sessions_v2.organization_id, organizationId)
          : and(
              eq(cli_sessions_v2.kilo_user_id, userId ?? ''),
              isNull(cli_sessions_v2.organization_id)
            )
      )
    )
    .limit(2);

  if (!v2 || duplicateV2) return empty;
  const snapshot = await fetchSessionSnapshot(v2.sessionId, v2.userId);
  if (!snapshot) return empty;
  return { ...empty, logs: v2SnapshotToLogEntries(snapshot), logsReady: true };
}
