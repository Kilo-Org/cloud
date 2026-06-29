import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

export type AccessibleCloudAgentSession = {
  kiloSessionId: string;
  organizationId: string | null;
};

type SessionAccessDb = Pick<WorkerDb, 'select'>;

type AccessibleCloudAgentSessionQuery = {
  kiloUserId: string;
  cloudAgentSessionId: string;
  expectedOrganizationId?: string | null;
};

export async function queryAccessibleCloudAgentSession(
  db: SessionAccessDb,
  query: AccessibleCloudAgentSessionQuery
): Promise<AccessibleCloudAgentSession | null> {
  const membershipJoin = and(
    eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
    eq(organization_memberships.kilo_user_id, query.kiloUserId)
  );
  const scopeCondition =
    query.expectedOrganizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : query.expectedOrganizationId !== undefined
        ? and(
            eq(cli_sessions_v2.organization_id, query.expectedOrganizationId),
            isNotNull(organization_memberships.id)
          )
        : or(isNull(cli_sessions_v2.organization_id), isNotNull(organization_memberships.id));

  const rows = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      organizationId: cli_sessions_v2.organization_id,
    })
    .from(cli_sessions_v2)
    .leftJoin(organization_memberships, membershipJoin)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, query.kiloUserId),
        eq(cli_sessions_v2.cloud_agent_session_id, query.cloudAgentSessionId),
        scopeCondition
      )
    )
    .limit(1);

  return rows[0] ?? null;
}
