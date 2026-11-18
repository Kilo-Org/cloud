import { z } from 'zod';

/**
 * Per-route record of the runtime-proxy handle the wrapper was last told about.
 *
 * The canonical handle is shared by every member of a worktree scope, so a
 * rotation updates every member row at once; the row can no longer say what a
 * given route was actually sent. This marker is that memory: the digest carried
 * by the route's `session.prepare` frame, refreshed when a `session.credentials`
 * frame is sent to a route whose socket accepted it.
 *
 * It is one KV entry per route (not one map) so a fanout cannot clobber a
 * concurrent mark. A preparing route is deliberately not marked when a fanout
 * frame is sent: that frame may be dropped by an older wrapper, and
 * reconciliation happens on `session.ready`, which resends whenever the row and
 * marker differ.
 */
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const KEY_PREFIX = 'runtime_proxy_last_sent_handle:';

export function lastSentHandleKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

export type LastSentStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export async function readLastSentHandleDigest(
  storage: LastSentStorage,
  sessionId: string
): Promise<string | null> {
  const raw = await storage.get<unknown>(lastSentHandleKey(sessionId));
  const parsed = DIGEST.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function markLastSentHandle(
  storage: LastSentStorage,
  sessionId: string,
  digest: string
): Promise<void> {
  if (!DIGEST.safeParse(digest).success) return;
  await storage.put(lastSentHandleKey(sessionId), digest);
}
