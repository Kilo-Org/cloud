import 'server-only';
import { z } from 'zod';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { generateApiToken } from '@/lib/tokens';
import type { User } from '@/db/schema';

// Mirrors SharedSessionSnapshotSchema from cloudflare-session-ingest/src/util/share-output.ts.
// Kept in sync manually (same pattern as cloud-agent-client.ts).
const SessionExportResponseSchema = z.object({
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

type SessionExportMessage = z.infer<typeof SessionExportResponseSchema>['messages'][number];

export async function fetchSessionMessages(
  sessionId: string,
  user: User
): Promise<SessionExportMessage[] | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL is not configured');
  }

  const token = generateApiToken(user);
  const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(sessionId)}/export`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new Error(`Session ingest export failed: ${response.status} ${text}`);
  }

  const data = SessionExportResponseSchema.parse(await response.json());
  return data.messages;
}
