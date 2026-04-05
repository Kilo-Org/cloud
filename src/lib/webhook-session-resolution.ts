import { inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';

/**
 * Resolve cloudAgentSessionIds to kiloSessionIds by looking up
 * first in cliSessions (v1), then falling back to cli_sessions_v2.
 */
export async function resolveCloudAgentSessionIds(
  cloudAgentSessionIds: string[]
): Promise<Map<string, string>> {
  if (cloudAgentSessionIds.length === 0) return new Map();

  const v1Sessions = await db
    .select({
      cloudAgentSessionId: cliSessions.cloud_agent_session_id,
      sessionId: cliSessions.session_id,
    })
    .from(cliSessions)
    .where(inArray(cliSessions.cloud_agent_session_id, cloudAgentSessionIds));

  const sessionIdMap = new Map(
    v1Sessions
      .filter(
        (s): s is { cloudAgentSessionId: string; sessionId: string } =>
          s.cloudAgentSessionId !== null
      )
      .map(s => [s.cloudAgentSessionId, s.sessionId])
  );

  const unresolvedIds = cloudAgentSessionIds.filter(id => !sessionIdMap.has(id));
  if (unresolvedIds.length > 0) {
    const v2Sessions = await db
      .select({
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        sessionId: cli_sessions_v2.session_id,
      })
      .from(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.cloud_agent_session_id, unresolvedIds));

    for (const s of v2Sessions) {
      if (s.cloudAgentSessionId !== null) {
        sessionIdMap.set(s.cloudAgentSessionId, s.sessionId);
      }
    }
  }

  return sessionIdMap;
}
