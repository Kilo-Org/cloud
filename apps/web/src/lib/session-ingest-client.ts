import 'server-only';

import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';
import type { User } from '@kilocode/db/schema';
import {
  kiloSdkMessageHistorySchema,
  type KiloSdkMessageHistory,
} from '@kilocode/session-ingest-contracts';

// ---------------------------------------------------------------------------
// Zod schema (mirrors cloudflare-session-ingest SharedSessionSnapshotSchema)
// ---------------------------------------------------------------------------

// Mirrors SharedSessionSnapshotSchema from cloudflare-session-ingest/src/util/share-output.ts.
// Kept in sync manually (same pattern as cloud-agent-client.ts).
const SessionInfoSchema = z.looseObject({
  id: z.string().optional(),
  parentID: z.string().optional(),
  model: z
    .object({
      providerID: z.string(),
      id: z.string(),
      variant: z.string().optional(),
    })
    .optional(),
});

const SessionSnapshotSchema = z.object({
  info: SessionInfoSchema,
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

// ---------------------------------------------------------------------------
// Paginated authorized session-message history
// ---------------------------------------------------------------------------

const SessionMessagesPageResponseSchema = z.object({
  success: z.literal(true),
  kiloSessionId: z.string().min(1),
  history: kiloSdkMessageHistorySchema.nullable(),
});

export type SessionMessagesPageOptions = {
  /** Bounded by the worker's shared maximum (100). Mobile default is 50. */
  limit?: number;
  /** Opaque cursor returned by a previous page; requires a positive limit. */
  before?: string;
};

export type SessionMessagesPageResult = {
  kiloSessionId: string;
  history: KiloSdkMessageHistory | null;
};

/**
 * Fetch a bounded page of persisted SDK messages for any Kilo session the
 * user owns. Mirrors the access-checked RPC the worker exposes via service
 * binding; returns `null` for sessions the user cannot read so the tRPC
 * router can surface a stable `NOT_FOUND`. Typed failure outcomes
 * (`retryable_failure`, `too_large`, `invalid_data`) are passed through
 * verbatim so the caller can distinguish retryable from non-retryable
 * failures without inferring retry semantics client-side.
 */
export async function fetchSessionMessagesPage(
  sessionId: string,
  userId: string,
  options: SessionMessagesPageOptions
): Promise<SessionMessagesPageResult | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options.before !== undefined) {
    params.set('before', options.before);
  }

  const query = params.toString();
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/messages${
    query ? `?${query}` : ''
  }`;

  const token = generateInternalServiceToken(userId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest messages page failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ''
      }`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'messagesPage' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  const parsed = SessionMessagesPageResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    const error = new Error(
      `Session ingest messages page returned an unexpected response: ${parsed.error.message}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'messagesPage' },
      extra: { sessionId, issues: parsed.error.issues },
    });
    throw error;
  }

  return { kiloSessionId: parsed.data.kiloSessionId, history: parsed.data.history };
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

const ShareResponseSchema = z.object({
  success: z.literal(true),
  public_id: z.string(),
});

/**
 * Share a session via the session-ingest worker.
 *
 * Calls POST /session/:sessionId/share which is idempotent — if the session
 * already has a public_id, the existing one is returned.
 *
 * @returns The public_id used to construct the /s/{public_id} share URL.
 */
export async function shareSession(
  sessionId: string,
  userId: string
): Promise<{ public_id: string }> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/share`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    throw new Error('Session not found');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest share failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'share' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  const body = ShareResponseSchema.parse(await response.json());
  return { public_id: body.public_id };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a session via the session-ingest worker.
 *
 * The ingest worker owns all DB deletion (recursive child sessions) and
 * ingest DO / cache cleanup. Returns void on success.
 */
export async function deleteSession(sessionId: string, userId: string): Promise<void> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    // Session already deleted or was never ingested — treat as success (idempotent delete).
    return;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest delete failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-ingest-client', endpoint: 'delete' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }
}
