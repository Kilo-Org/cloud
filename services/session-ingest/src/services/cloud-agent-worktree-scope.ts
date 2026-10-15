import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { CloudAgentSessionScopeV2 } from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess } from '@kilocode/worker-utils';

export const CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH = 32;

type WorktreeScopeDb = Pick<WorkerDb, 'select' | 'execute'>;

export type AncestryNode = {
  sessionId: string;
  parentSessionId: string | null;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
};

export type ScopedSessionRow = AncestryNode & {
  organizationId: string | null;
  cloudAgentWorktreeId: string | null;
};

const SCOPED_SESSION_COLUMNS = {
  sessionId: cli_sessions_v2.session_id,
  parentSessionId: cli_sessions_v2.parent_session_id,
  organizationId: cli_sessions_v2.organization_id,
  cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
  cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
  cloudAgentWorktreeId: cli_sessions_v2.cloud_agent_worktree_id,
} as const;

export function worktreeScopeCondition(
  kiloUserId: string,
  scope: CloudAgentSessionScopeV2
): SQL | undefined {
  return and(
    eq(cli_sessions_v2.kilo_user_id, kiloUserId),
    scope.organizationId === null
      ? isNull(cli_sessions_v2.organization_id)
      : eq(cli_sessions_v2.organization_id, scope.organizationId),
    eq(cli_sessions_v2.cloud_agent_worktree_id, scope.worktreeId)
  );
}

export function scopedSessionCondition(
  kiloUserId: string,
  scope: CloudAgentSessionScopeV2,
  rootScopeId: string
): SQL | undefined {
  return and(
    worktreeScopeCondition(kiloUserId, scope),
    eq(cli_sessions_v2.cloud_agent_session_scope_id, rootScopeId)
  );
}

const ancestryRootSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.null(),
  cloudAgentSessionId: z.string().nullable(),
  cloudAgentSessionScopeId: z.string().nullable(),
});

async function resolveScopedAncestryRoot(
  db: WorktreeScopeDb,
  kiloUserId: string,
  scope: CloudAgentSessionScopeV2,
  firstParentSessionId: string
): Promise<AncestryNode | null> {
  // Keep every hop inside the asserted scope, including intermediate children.
  const result = await db.execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT session_id, parent_session_id, cloud_agent_session_id, cloud_agent_session_scope_id,
        1 AS depth, ARRAY[session_id] AS path
      FROM ${cli_sessions_v2}
      WHERE ${and(
        eq(cli_sessions_v2.session_id, firstParentSessionId),
        worktreeScopeCondition(kiloUserId, scope)
      )}
      UNION ALL
      SELECT parent.session_id, parent.parent_session_id,
        parent.cloud_agent_session_id, parent.cloud_agent_session_scope_id,
        ancestry.depth + 1, ancestry.path || parent.session_id
      FROM ${cli_sessions_v2} parent
      INNER JOIN ancestry ON parent.session_id = ancestry.parent_session_id
      WHERE parent.kilo_user_id = ${kiloUserId}
        AND ${scope.organizationId === null ? sql`parent.organization_id IS NULL` : sql`parent.organization_id = ${scope.organizationId}`}
        AND parent.cloud_agent_worktree_id = ${scope.worktreeId}
        AND ancestry.depth < ${CLOUD_AGENT_SCOPE_MAX_ANCESTRY_DEPTH}
        AND NOT (parent.session_id = ANY(ancestry.path))
    )
    SELECT session_id AS "sessionId", parent_session_id AS "parentSessionId",
      cloud_agent_session_id AS "cloudAgentSessionId",
      cloud_agent_session_scope_id AS "cloudAgentSessionScopeId"
    FROM ancestry WHERE parent_session_id IS NULL
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  const root = ancestryRootSchema.parse(row);
  return scope.memberRootKiloSessionIds.includes(root.sessionId) ? root : null;
}

export type ScopedChildSessionResolution = { kind: 'denied' } | { kind: 'ok'; rootScopeId: string };

export async function resolveScopedChildSession(
  db: WorktreeScopeDb,
  params: { kiloUserId: string; sessionId: string; scope: CloudAgentSessionScopeV2 }
): Promise<ScopedChildSessionResolution> {
  const { kiloUserId, sessionId, scope } = params;
  if (
    scope.organizationId !== null &&
    !(await hasOrganizationAccess(db, { kiloUserId, organizationId: scope.organizationId }))
  ) {
    return { kind: 'denied' };
  }

  const [row] = await db
    .select(SCOPED_SESSION_COLUMNS)
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), worktreeScopeCondition(kiloUserId, scope))
    )
    .limit(1);
  if (!row || row.parentSessionId === null || row.cloudAgentSessionScopeId === null) {
    return { kind: 'denied' };
  }

  const memberRoot = await resolveScopedAncestryRoot(db, kiloUserId, scope, row.parentSessionId);
  if (!memberRoot) return { kind: 'denied' };

  const rootScopeId = memberRoot.cloudAgentSessionScopeId ?? memberRoot.cloudAgentSessionId;
  if (rootScopeId === null || row.cloudAgentSessionScopeId !== rootScopeId) {
    return { kind: 'denied' };
  }
  return { kind: 'ok', rootScopeId };
}

export type ScopedCreateParentResolution =
  | { kind: 'denied' }
  | { kind: 'ok'; parent: ScopedSessionRow; memberRoot: AncestryNode; memberRootScopeId: string };

export async function resolveScopedCreateParent(
  db: WorktreeScopeDb,
  params: { kiloUserId: string; parentSessionId: string; scope: CloudAgentSessionScopeV2 }
): Promise<ScopedCreateParentResolution> {
  const { kiloUserId, parentSessionId, scope } = params;
  if (
    scope.organizationId !== null &&
    !(await hasOrganizationAccess(db, { kiloUserId, organizationId: scope.organizationId }))
  ) {
    return { kind: 'denied' };
  }

  const [parent] = await db
    .select(SCOPED_SESSION_COLUMNS)
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.session_id, parentSessionId),
        worktreeScopeCondition(kiloUserId, scope)
      )
    )
    .limit(1);
  if (!parent) return { kind: 'denied' };

  const memberRoots = new Set(scope.memberRootKiloSessionIds);
  let memberRoot: AncestryNode;
  if (parent.parentSessionId === null) {
    if (!memberRoots.has(parent.sessionId)) return { kind: 'denied' };
    memberRoot = parent;
  } else {
    const root = await resolveScopedAncestryRoot(db, kiloUserId, scope, parent.parentSessionId);
    if (!root) return { kind: 'denied' };
    memberRoot = root;
  }

  const memberRootScopeId = memberRoot.cloudAgentSessionScopeId ?? memberRoot.cloudAgentSessionId;
  if (memberRootScopeId === null) return { kind: 'denied' };
  if (
    parent.cloudAgentSessionScopeId !== null &&
    parent.cloudAgentSessionScopeId !== memberRootScopeId
  ) {
    return { kind: 'denied' };
  }
  return { kind: 'ok', parent, memberRoot, memberRootScopeId };
}
