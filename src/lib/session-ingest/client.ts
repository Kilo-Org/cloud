import 'server-only';

import { captureException } from '@sentry/nextjs';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A message part from the session-ingest export.
 * Uses loose typing since the ingest service preserves all fields from the CLI.
 */
export type SessionExportPart = {
  id: string;
  type?: string;
  text?: string;
  messageID?: string;
  [key: string]: unknown;
};

/**
 * A message from the session-ingest export.
 * Each message has an info object (metadata like role, timestamps, tokens)
 * and an array of parts (text content, tool calls, etc.).
 */
export type SessionExportMessage = {
  info: {
    id: string;
    role?: string;
    [key: string]: unknown;
  };
  parts: SessionExportPart[];
};

/**
 * The session export snapshot from the session-ingest service.
 * Contains the final compacted state of all messages — NOT streaming deltas.
 * Each message/part is stored via UPSERT, so only the latest version exists.
 */
export type SharedSessionSnapshot = {
  info: Record<string, unknown>;
  messages: SessionExportMessage[];
};

// ---------------------------------------------------------------------------
// Session export fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the full session export from the session-ingest service.
 *
 * The ingest service stores compacted final-state messages (UPSERT by item ID),
 * so the export contains the complete text of each message, not streaming deltas.
 *
 * @param kiloSessionId - The Kilo session ID (ses_ prefix)
 * @param userId - The user ID for JWT authentication
 * @returns The session snapshot, or null if the session was not found
 */
export async function fetchSessionExport(
  kiloSessionId: string,
  userId: string
): Promise<SharedSessionSnapshot | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL not configured');
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(kiloSessionId)}/export`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest export failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'export' },
      extra: { kiloSessionId, status: response.status },
    });
    throw error;
  }

  return (await response.json()) as SharedSessionSnapshot;
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

/**
 * Extract the last assistant message text from a session export snapshot.
 *
 * Iterates messages in reverse order to find the last assistant message,
 * then concatenates all text-type parts into a single string.
 *
 * @param snapshot - The session export snapshot from the ingest service
 * @returns The full text of the last assistant message, or null if none found
 */
export function extractLastAssistantMessage(snapshot: SharedSessionSnapshot): string | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg.info.role !== 'assistant') continue;

    const text = msg.parts
      .filter(
        (p): p is SessionExportPart & { text: string } =>
          p.type === 'text' && typeof p.text === 'string'
      )
      .map(p => p.text)
      .join('');

    if (text.length > 0) return text;
  }
  return null;
}
