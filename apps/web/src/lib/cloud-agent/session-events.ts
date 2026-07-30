import 'server-only';

import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateInternalServiceToken } from '@/lib/tokens';

const RenameNotifyResponseSchema = z.object({
  delivered: z.boolean(),
});

type NotifyCliSessionRenamedInput = {
  sessionId: string;
  title: string;
  userId: string;
};

/**
 * Best-effort notify to the session-ingest worker that a CLI session was renamed
 * on the web. The worker relays `session.renamed` to the owning CLI connection.
 *
 * Callers must treat failure as non-fatal — the DB rename is the source of truth.
 */
export async function notifyCliSessionRenamed({
  sessionId,
  title,
  userId,
}: NotifyCliSessionRenamedInput): Promise<{ delivered: boolean }> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateInternalServiceToken(userId);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/rename-notify`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    const error = new Error(
      `Session ingest rename-notify failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
    captureException(error, {
      tags: { source: 'session-events', endpoint: 'rename-notify' },
      extra: { sessionId, status: response.status },
    });
    throw error;
  }

  const body = RenameNotifyResponseSchema.parse(await response.json());
  return { delivered: body.delivered };
}
