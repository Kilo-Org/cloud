import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

export type AccessibleSession = {
  kiloSessionId: string;
  organizationId: string | null;
};

/** Established name used by Cloud Agent consumers. */
export type AccessibleCloudAgentSession = AccessibleSession;

type SessionAccessDb = Pick<WorkerDb, 'select'>;

type AccessibleCloudAgentSessionQuery = {
  kiloUserId: string;
  cloudAgentSessionId: string;
  expectedOrganizationId?: string | null;
};

type AccessibleKiloSessionQuery = {
  kiloUserId: string;
  kiloSessionId: string;
};

type AccessibleSessionQuery = AccessibleCloudAgentSessionQuery | AccessibleKiloSessionQuery;

async function queryAccessibleSession(
  db: SessionAccessDb,
  query: AccessibleSessionQuery
): Promise<AccessibleSession | null> {
  const membershipJoin = and(
    eq(organization_memberships.organization_id, cli_sessions_v2.organization_id),
    eq(organization_memberships.kilo_user_id, query.kiloUserId)
  );
  const organizationJoin = and(
    eq(organizations.id, cli_sessions_v2.organization_id),
    isNull(organizations.deleted_at)
  );
  const expectedOrganizationId =
    'expectedOrganizationId' in query ? query.expectedOrganizationId : undefined;
  const scopeCondition =
    expectedOrganizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : expectedOrganizationId !== undefined
        ? and(
            eq(cli_sessions_v2.organization_id, expectedOrganizationId),
            isNotNull(organization_memberships.id),
            isNotNull(organizations.id)
          )
        : or(
            isNull(cli_sessions_v2.organization_id),
            and(isNotNull(organization_memberships.id), isNotNull(organizations.id))
          );
  const sessionCondition =
    'cloudAgentSessionId' in query
      ? eq(cli_sessions_v2.cloud_agent_session_id, query.cloudAgentSessionId)
      : eq(cli_sessions_v2.session_id, query.kiloSessionId);

  const rows = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      organizationId: cli_sessions_v2.organization_id,
    })
    .from(cli_sessions_v2)
    .leftJoin(organization_memberships, membershipJoin)
    .leftJoin(organizations, organizationJoin)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, query.kiloUserId), sessionCondition, scopeCondition)
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function queryAccessibleCloudAgentSession(
  db: SessionAccessDb,
  query: AccessibleCloudAgentSessionQuery
): Promise<AccessibleCloudAgentSession | null> {
  return queryAccessibleSession(db, query);
}

export async function queryAccessibleKiloSession(
  db: SessionAccessDb,
  query: AccessibleKiloSessionQuery
): Promise<AccessibleSession | null> {
  return queryAccessibleSession(db, query);
}
