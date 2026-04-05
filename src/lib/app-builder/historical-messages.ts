import 'server-only';
import { db } from '@/lib/drizzle';
import { cliSessions } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import type { CloudMessage } from '@/components/cloud-agent/types';
import {
  stripSystemContext,
  determineMessageType,
  shouldParseTextAsMetadata,
  parseTextAsJson,
} from '@/lib/app-builder/message-utils';

/**
 * Fetch historical messages from R2 for a project's cloud agent session.
 *
 * This is used for legacy sessions that don't have preparedAt set,
 * meaning the DO doesn't have stored events for WebSocket replay.
 * The messages are linked through cli_sessions.cloud_agent_session_id.
 *
 * @param cloudAgentSessionId - The cloud agent session ID (e.g., "agent_xxx")
 * @returns Array of CloudMessage objects from R2, or empty array if none found
 */
export async function getHistoricalMessages(cloudAgentSessionId: string): Promise<CloudMessage[]> {
  // Find the cli_session linked to this cloud agent session
  const [cliSession] = await db
    .select({
      ui_messages_blob_url: cliSessions.ui_messages_blob_url,
    })
    .from(cliSessions)
    .where(eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId))
    .limit(1);

  if (!cliSession?.ui_messages_blob_url) {
    return [];
  }

  // Fetch messages from R2
  const rawMessages = await getBlobContent(cliSession.ui_messages_blob_url);

  if (!Array.isArray(rawMessages)) {
    return [];
  }

  // Convert to CloudMessage format (simplified conversion)
  return convertRawMessagesToCloudMessages(rawMessages);
}

/**
 * Convert raw messages from R2 to CloudMessage format.
 * This is a simplified version of the conversion logic from db-session-atoms.ts.
 */
export function convertRawMessagesToCloudMessages(
  rawMessages: Array<Record<string, unknown>>
): CloudMessage[] {
  return rawMessages
    .map((msg): CloudMessage | null => {
      // Get timestamp
      const ts = msg.ts as number | undefined;
      const timestampStr = msg.timestamp as string | undefined;
      const timestamp = ts || (timestampStr ? new Date(timestampStr).getTime() : Date.now());

      // Get message content
      let text = (msg.text as string) || (msg.content as string) || '';
      const content = (msg.content as string) || (msg.text as string) || '';
      const say = msg.say as string | undefined;
      const ask = msg.ask as string | undefined;
      // Historical messages are always complete - never partial
      // (they're loaded from storage, not actively streaming)
      const partial = false;

      // Handle metadata
      const rawMetadata = msg.metadata;
      let metadata =
        rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
          ? (rawMetadata as Record<string, unknown>)
          : undefined;

      // Parse text as metadata for certain message types
      if (!metadata && shouldParseTextAsMetadata(ask, say)) {
        metadata = parseTextAsJson(text);
      }

      // Determine message type based on raw type/role
      const rawType = msg.type as string | undefined;
      const rawRole = msg.role as string | undefined;
      const messageType = determineMessageType(rawType, rawRole, say, text);

      // Strip system context prefix from user messages (for historical messages)
      if (messageType === 'user') {
        text = stripSystemContext(text, timestamp);
      }

      return {
        ts: timestamp,
        type: messageType,
        say,
        ask,
        text,
        content,
        partial,
        metadata,
      };
    })
    .filter((msg): msg is CloudMessage => msg !== null);
}
