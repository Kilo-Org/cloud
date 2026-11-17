import type { KiloSessionId, ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { cloudAgentSessionIdSchema } from '@kilocode/cloud-agent-sdk/schemas';
import { cloudSessionMetadataSchema } from '@kilocode/cloud-agent-sdk/cloud-conversation-schemas';

type SessionIdentity = { cloud_agent_session_id: string | null };

/** Cached identities choose a transport, never authorize access to its data. */
export function createWebSessionResolver({
  readCachedCloudSessionId,
  readCachedActiveSessions,
  getSession,
  listActiveSessions,
  getCloudSession,
  organizationId,
}: {
  readCachedCloudSessionId: (id: KiloSessionId) => string | null | undefined;
  readCachedActiveSessions: () => readonly { id: string }[];
  getSession: (id: KiloSessionId) => Promise<SessionIdentity>;
  listActiveSessions: () => Promise<{ sessions: readonly { id: string }[] }>;
  getCloudSession?: (id: string) => Promise<unknown>;
  organizationId?: string;
}): (id: KiloSessionId) => Promise<ResolvedSession> {
  return async kiloSessionId => {
    const cloudSession = async (id: string | null | undefined): Promise<ResolvedSession | null> => {
      const parsed = cloudAgentSessionIdSchema.safeParse(id);
      if (!parsed.success) return null;
      if (getCloudSession) {
        const metadata = cloudSessionMetadataSchema.parse(await getCloudSession(parsed.data));
        if (metadata.sessionId !== parsed.data || metadata.orgId !== organizationId)
          throw new Error('Cloud Agent session scope mismatch');
        if (metadata.chat?.transport === 'relay') {
          if (metadata.kiloSessionId !== kiloSessionId)
            throw new Error('Cloud Agent native session mismatch');
          return {
            type: 'hosted-native',
            kiloSessionId,
            cloudAgentSessionId: parsed.data,
            ...(organizationId ? { organizationId } : {}),
          };
        }
      }
      return { type: 'cloud-agent', kiloSessionId, cloudAgentSessionId: parsed.data };
    };
    const cached = await cloudSession(readCachedCloudSessionId(kiloSessionId));
    if (cached) return cached;
    if (
      !getCloudSession &&
      readCachedActiveSessions().some(session => session.id === kiloSessionId)
    ) {
      return { type: 'remote', kiloSessionId };
    }

    // Cloud chats do not need a round trip through the unrelated CLI presence service.
    let identity: SessionIdentity | undefined;
    try {
      identity = await getSession(kiloSessionId);
    } catch {
      // The authoritative metadata read still surfaces missing/denied sessions.
    }
    if (identity) {
      const resolved = await cloudSession(identity.cloud_agent_session_id);
      if (resolved) return resolved;
    }
    if (readCachedActiveSessions().some(session => session.id === kiloSessionId))
      return { type: 'remote', kiloSessionId };
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
