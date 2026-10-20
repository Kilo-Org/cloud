import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships, organizations } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  activeOrganizationJoinCondition,
  organizationMembershipJoinCondition,
  parentOrganizationJoinCondition,
  parentOrganizationMembershipJoinCondition,
  parentOrganizationsTable,
  parentOrganizationMembershipsTable,
  personalOrInheritedOrganizationCondition,
} from './organization-membership';

export type AccessibleSession = {
  kiloSessionId: string;
  organizationId: string | null;
};

export type AccessibleKiloSession = AccessibleSession & {
  cloudAgentSessionScopeId: string | null;
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
  expectedCloudAgentSessionScopeId?: string;
};

type AccessibleSessionQuery = AccessibleCloudAgentSessionQuery | AccessibleKiloSessionQuery;

async function queryAccessibleSession(
  db: SessionAccessDb,
  query: AccessibleSessionQuery
): Promise<AccessibleKiloSession | null> {
  const membershipJoin = organizationMembershipJoinCondition(
    query.kiloUserId,
    cli_sessions_v2.organization_id
  );
  const organizationJoin = activeOrganizationJoinCondition(cli_sessions_v2.organization_id);
  const expectedOrganizationId =
    'expectedOrganizationId' in query ? query.expectedOrganizationId : undefined;
  const scopeCondition =
    expectedOrganizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : expectedOrganizationId !== undefined
        ? and(
            eq(cli_sessions_v2.organization_id, expectedOrganizationId),
            personalOrInheritedOrganizationCondition(cli_sessions_v2.organization_id)
          )
        : personalOrInheritedOrganizationCondition(cli_sessions_v2.organization_id);
  const sessionCondition =
    'cloudAgentSessionId' in query
      ? eq(cli_sessions_v2.cloud_agent_session_id, query.cloudAgentSessionId)
      : eq(cli_sessions_v2.session_id, query.kiloSessionId);

  const rows = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      organizationId: cli_sessions_v2.organization_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
    })
    .from(cli_sessions_v2)
    .leftJoin(organization_memberships, membershipJoin)
    .leftJoin(organizations, organizationJoin)
    .leftJoin(parentOrganizationsTable, parentOrganizationJoinCondition())
    .leftJoin(
      parentOrganizationMembershipsTable,
      parentOrganizationMembershipJoinCondition(query.kiloUserId)
    )
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, query.kiloUserId),
        sessionCondition,
        scopeCondition,
        'expectedCloudAgentSessionScopeId' in query &&
          query.expectedCloudAgentSessionScopeId !== undefined
          ? eq(cli_sessions_v2.cloud_agent_session_scope_id, query.expectedCloudAgentSessionScopeId)
          : undefined
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function queryAccessibleCloudAgentSession(
  db: SessionAccessDb,
  query: AccessibleCloudAgentSessionQuery
): Promise<AccessibleCloudAgentSession | null> {
  const session = await queryAccessibleSession(db, query);
  return session
    ? { kiloSessionId: session.kiloSessionId, organizationId: session.organizationId }
    : null;
}

export async function queryAccessibleKiloSession(
  db: SessionAccessDb,
  query: AccessibleKiloSessionQuery
): Promise<AccessibleSession | null> {
  const session = await queryAccessibleSession(db, query);
  return session
    ? { kiloSessionId: session.kiloSessionId, organizationId: session.organizationId }
    : null;
}

export async function queryAccessibleKiloSessionWithSessionScope(
  db: SessionAccessDb,
  query: AccessibleKiloSessionQuery
): Promise<AccessibleKiloSession | null> {
  return queryAccessibleSession(db, query);
}
