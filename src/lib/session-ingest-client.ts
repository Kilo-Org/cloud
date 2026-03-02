import 'server-only';

import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import type { User } from '@kilocode/db/schema';

// ---------------------------------------------------------------------------
// Zod schema (mirrors cloudflare-session-ingest SharedSessionSnapshotSchema)
// ---------------------------------------------------------------------------

// Mirrors SharedSessionSnapshotSchema from cloudflare-session-ingest/src/util/share-output.ts.
// Kept in sync manually (same pattern as cloud-agent-client.ts).
const SessionSnapshotSchema = z.object({
  info: z.unknown(),
  messages: z.array(
    z.looseObject({
      info: z.looseObject({
        id: z.string(),
      }),
      parts: z.array(
        z.looseObject({
          id: z.string(),
        })
      ),
    })
  ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Snapshot returned by the session-ingest export endpoint.
 * Contains the final compacted state of all messages — NOT streaming deltas.
 */
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export type SessionMessage = SessionSnapshot['messages'][number];

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the session snapshot from the session-ingest service.
 *
 * Uses a short-lived internal service token (1h expiry, no User object needed).
 *
 * @returns The full snapshot (info + messages), or null if the session was not found.
 */
export async function fetchSessionSnapshot(
  sessionId: string,
  userId: string
): Promise<SessionSnapshot | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/export`;

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
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  return SessionSnapshotSchema.parse(await response.json());
}

/**
 * Convenience wrapper: fetch only the messages array for a session.
 * Accepts a full User object for compatibility with tRPC endpoint callers.
 */
export async function fetchSessionMessages(
  sessionId: string,
  user: User
): Promise<SessionMessage[] | null> {
  const snapshot = await fetchSessionSnapshot(sessionId, user.id);
  return snapshot?.messages ?? null;
}
