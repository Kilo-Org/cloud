import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { and, desc, eq, exists, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  WORKSPACE_HISTORY_PRELOAD_LIMIT,
  workspaceHistorySessionsSchema,
  type WorkspaceHistorySession,
} from '../../shared/control-plane-protocol.js';
import type { RouteRecord } from './routes.js';

/** The ownership ledger, not a caller-supplied workspace id, authorizes these reads. */
export function workspaceHistorySessionsQuery(
  db: WorkerDb,
  route: RouteRecord,
  target?: WorkspaceHistorySession
) {
  const source = route.credentialSource;
  const worktree = cloudAgentWorktreeIdSchema.safeParse(route.spec.kilo?.scopeId);
  if (!source || !worktree.success || route.spec.runtimeIsolation || route.state === 'failed')
    return null;
  const anchor = alias(cli_sessions_v2, 'anchor');
  const organization = source.orgId;
  const anchorQuery = db
    .select({ id: anchor.session_id })
    .from(anchor)
    .where(
      and(
        eq(anchor.kilo_user_id, source.userId),
        eq(anchor.cloud_agent_session_id, route.sessionId),
        eq(anchor.session_id, route.spec.kiloSessionId),
        eq(anchor.cloud_agent_worktree_id, worktree.data),
        organization ? eq(anchor.organization_id, organization) : isNull(anchor.organization_id),
        isNull(anchor.parent_session_id)
      )
    );
  return db
    .select({
      sessionId: cli_sessions_v2.cloud_agent_session_id,
      kiloSessionId: cli_sessions_v2.session_id,
    })
    .from(cli_sessions_v2)
    .innerJoin(
      cloud_agent_worktrees,
      and(
        eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
        eq(cloud_agent_worktrees.kilo_user_id, source.userId),
        organization
          ? eq(cloud_agent_worktrees.organization_id, organization)
          : isNull(cloud_agent_worktrees.organization_id),
        isNull(cloud_agent_worktrees.deletion_started_at)
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, source.userId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, worktree.data),
        organization
          ? eq(cli_sessions_v2.organization_id, organization)
          : isNull(cli_sessions_v2.organization_id),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.cloud_agent_session_id),
        exists(anchorQuery),
        target ? eq(cli_sessions_v2.cloud_agent_session_id, target.sessionId) : undefined,
        target ? eq(cli_sessions_v2.session_id, target.kiloSessionId) : undefined
      )
    )
    .orderBy(desc(cli_sessions_v2.updated_at), desc(cli_sessions_v2.session_id))
    .limit(target ? 1 : WORKSPACE_HISTORY_PRELOAD_LIMIT);
}

export async function readWorkspaceHistorySessions(
  db: WorkerDb,
  route: RouteRecord,
  target?: WorkspaceHistorySession
): Promise<WorkspaceHistorySession[]> {
  const query = workspaceHistorySessionsQuery(db, route, target);
  return query === null ? [] : workspaceHistorySessionsSchema.parse(await query);
}
