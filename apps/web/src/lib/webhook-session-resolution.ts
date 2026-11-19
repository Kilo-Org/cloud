import { inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { cliSessions, cli_sessions_v2 } from '@kilocode/db/schema';

/**
 * Resolve cloudAgentSessionIds to kiloSessionIds.
 *
 * By default only cli_sessions_v2 ownership rows are consulted, because every
 * session the app can open has a v2 row; a v1-only match is a legacy id that
 * would render as a dead link.
 *
 * Pass `includeLegacyV1` for viewers that can still open legacy sessions (the
 * admin session viewer): v1 cliSessions is consulted first and cli_sessions_v2
 * resolves the remaining ids, so an id present in both tables keeps resolving
 * to the v1 session_id.
 */
export async function resolveCloudAgentSessionIds(
  cloudAgentSessionIds: string[],
  options: { includeLegacyV1?: boolean } = {}
): Promise<Map<string, string>> {
  if (cloudAgentSessionIds.length === 0) return new Map();

  if (!options.includeLegacyV1) {
    const v2Sessions = await db
      .select({
        cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
        sessionId: cli_sessions_v2.session_id,
      })
      .from(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionIds));

    return new Map(
      v2Sessions
        .filter(
          (s): s is { cloudAgentSessionId: string; sessionId: string } =>
            s.cloudAgentSessionId !== null
        )
        .map(s => [s.cloudAgentSessionId, s.sessionId])
    );
  }

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
