import type { KiloSessionId, ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { cloudAgentSessionIdSchema } from '@kilocode/cloud-agent-sdk/schemas';

type SessionIdentity = { cloud_agent_session_id: string | null };

/** Cached identities choose a transport, never authorize access to its data. */
export function createWebSessionResolver({
  readCachedCloudSessionId,
  readCachedActiveSessions,
  getSession,
  listActiveSessions,
}: {
  readCachedCloudSessionId: (id: KiloSessionId) => string | null | undefined;
  readCachedActiveSessions: () => readonly { id: string }[];
  getSession: (id: KiloSessionId) => Promise<SessionIdentity>;
  listActiveSessions: () => Promise<{ sessions: readonly { id: string }[] }>;
}): (id: KiloSessionId) => Promise<ResolvedSession> {
  return async kiloSessionId => {
    const cloudSession = (id: string | null | undefined): ResolvedSession | null => {
      const parsed = cloudAgentSessionIdSchema.safeParse(id);
      return parsed.success
        ? { type: 'cloud-agent', kiloSessionId, cloudAgentSessionId: parsed.data }
        : null;
    };
    const cached = cloudSession(readCachedCloudSessionId(kiloSessionId));
    if (cached) return cached;
    if (readCachedActiveSessions().some(session => session.id === kiloSessionId)) {
      return { type: 'remote', kiloSessionId };
    }

    // Cloud chats do not need a round trip through the unrelated CLI presence service.
    try {
      const session = await getSession(kiloSessionId);
      const resolved = cloudSession(session.cloud_agent_session_id);
      if (resolved) return resolved;
    } catch {
      // The authoritative metadata read still surfaces missing/denied sessions.
    }
    try {
      const active = await listActiveSessions();
      if (active.sessions.some(session => session.id === kiloSessionId)) {
        return { type: 'remote', kiloSessionId };
      }
    } catch {
      // A presence outage must not prevent opening stored history.
    }
    return { type: 'read-only', kiloSessionId };
  };
}
