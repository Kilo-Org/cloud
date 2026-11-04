import * as z from 'zod';
import { clientKiloSessionIdSchema } from '@kilocode/session-ingest-contracts';
import type { LocalSession } from './local-session';

/**
 * Local sessions are kept per tab in `sessionStorage`, so a reload during a
 * create can send the same request again. Closing the tab drops them.
 */
export function localSessionsStorageKey(userId: string, organizationId: string | null): string {
  return `cloud-agent:local-sessions:${userId}:${organizationId ?? 'personal'}`;
}

const storedLocalSessionSchema = z.object({
  kiloSessionId: clientKiloSessionIdSchema,
  operationKey: z.uuid(),
  organizationId: z.string().nullable(),
  worktreeId: z.string().nullable(),
  // The server validates the request itself when it is sent again.
  request: z.looseObject({
    kind: z.enum(['worktree-chat', 'new-session', 'new-organization-session']),
  }),
  repository: z.string(),
  branch: z.string().nullable(),
  composer: z
    .object({ mode: z.string(), model: z.string(), variant: z.string().nullable() })
    .nullable(),
  firstMessage: z
    .object({ id: z.string(), prompt: z.string(), attachmentNames: z.array(z.string()) })
    .nullable(),
  createdAt: z.string(),
  sync: z.looseObject({ state: z.enum(['syncing', 'synced', 'failed']) }),
});

export function readStoredLocalSessions(key: string): LocalSession[] {
  try {
    const parsed = z
      .array(storedLocalSessionSchema)
      .safeParse(JSON.parse(window.sessionStorage.getItem(key) ?? '[]'));
    // The stored shape is this module's own output; the schema guards a stale version.
    return parsed.success ? (parsed.data as LocalSession[]) : [];
  } catch {
    return [];
  }
}

export function writeStoredLocalSessions(key: string, sessions: readonly LocalSession[]): void {
  try {
    const kept = sessions.filter(session => session.sync.state !== 'synced');
    if (kept.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // Storage can be full or blocked; the session still syncs in this page.
  }
}
