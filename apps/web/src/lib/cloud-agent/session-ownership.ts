import { cliSessions, organization_memberships } from '@kilocode/db/schema';
import type { db } from '@/lib/drizzle';
import { and, eq } from 'drizzle-orm';
import { queryAccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';

/**
 * Database type for dependency injection in functions.
 * Allows passing either the primary db or a read replica.
 */
type DrizzleDb = typeof db;

/**
 * Verifies that a user owns a specific CLI session by session_id.
 *
 * Used for personal context session ownership verification
 * before signing stream tickets.
 *
 * @param fromDb - Database instance to query
 * @param userId - The user's ID (kilo_user_id)
 * @param sessionId - The CLI session ID (session_id) to verify
 * @returns true if the user owns the session, false otherwise
 */
export async function verifyUserOwnsSession(
  fromDb: DrizzleDb,
  userId: string,
  sessionId: string
): Promise<boolean> {
  const [session] = await fromDb
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .where(and(eq(cliSessions.session_id, sessionId), eq(cliSessions.kilo_user_id, userId)))
    .limit(1);

  return session !== undefined;
}

/**
 * Verifies that a user owns a session by cloud_agent_session_id.
 *
 * Used for WebSocket ticket signing where we need to verify ownership
 * using the cloudAgentSessionId that will be used for the WebSocket URL.
 *
 * @param fromDb - Database instance to query
 * @param userId - The user's ID (kilo_user_id)
 * @param cloudAgentSessionId - The cloud-agent session ID to verify
 * @returns The kiloSessionId if user owns the session, null otherwise
 */
export async function verifyUserOwnsSessionByCloudAgentId(
  fromDb: DrizzleDb,
  userId: string,
  cloudAgentSessionId: string
): Promise<{ kiloSessionId: string } | null> {
  const [session] = await fromDb
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId),
        eq(cliSessions.kilo_user_id, userId)
      )
    )
    .limit(1);

  return session ? { kiloSessionId: session.session_id } : null;
}

// ============================================================================
// V2 helpers (cli_sessions_v2 table)
// ============================================================================

/**
 * Verifies that a user owns a V2 session by cloud_agent_session_id.
 *
 * @returns The kiloSessionId if user owns the session, null otherwise
 */
export async function verifyUserOwnsSessionV2ByCloudAgentId(
  fromDb: DrizzleDb,
  userId: string,
  cloudAgentSessionId: string
): Promise<{ kiloSessionId: string } | null> {
  const session = await queryAccessibleCloudAgentSession(fromDb, {
    kiloUserId: userId,
    cloudAgentSessionId,
    expectedOrganizationId: null,
  });

  return session ? { kiloSessionId: session.kiloSessionId } : null;
}

/**
 * Verifies that a user owns a V2 organization session by cloud_agent_session_id
 * and is currently a member of that exact organization.
 *
 * @returns The kiloSessionId if the user can access the organization session, null otherwise
 */
export async function verifyOrgOwnsSessionV2ByCloudAgentId(
  fromDb: DrizzleDb,
  organizationId: string,
  userId: string,
  cloudAgentSessionId: string
): Promise<{ kiloSessionId: string } | null> {
  const session = await queryAccessibleCloudAgentSession(fromDb, {
    kiloUserId: userId,
    cloudAgentSessionId,
    expectedOrganizationId: organizationId,
  });

  return session ? { kiloSessionId: session.kiloSessionId } : null;
}

/**
 * Verifies that an organization owns a session by cloud_agent_session_id.
 *
 * Used for WebSocket ticket signing in organization context.
 *
 * @param fromDb - Database instance to query
 * @param organizationId - The organization's ID
 * @param cloudAgentSessionId - The cloud-agent session ID to verify
 * @returns The kiloSessionId if organization owns the session, null otherwise
 */
export async function verifyOrgOwnsSessionByCloudAgentId(
  fromDb: DrizzleDb,
  organizationId: string,
  userId: string,
  cloudAgentSessionId: string
): Promise<{ kiloSessionId: string } | null> {
  const [session] = await fromDb
    .select({ session_id: cliSessions.session_id })
    .from(cliSessions)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, cliSessions.organization_id),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .where(
      and(
        eq(cliSessions.cloud_agent_session_id, cloudAgentSessionId),
        eq(cliSessions.organization_id, organizationId)
      )
    )
    .limit(1);

  return session ? { kiloSessionId: session.session_id } : null;
}
