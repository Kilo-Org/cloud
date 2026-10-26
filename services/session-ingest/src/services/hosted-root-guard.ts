import { and, eq, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import type { WorkerDb } from '@kilocode/db/client';
import { WORKSPACE_REQUIRES_ROOT_SESSION } from '@kilocode/session-ingest-contracts';

export { WORKSPACE_REQUIRES_ROOT_SESSION };

export type HostedRootIdentity = {
  cloudAgentSessionId: string;
  worktreeId: string | null;
  scopeId: string | null;
};

export function hostedRootIdentity(row: {
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id: string | null;
  cloud_agent_session_scope_id: string | null;
}): HostedRootIdentity | null {
  if (row.cloud_agent_session_id === null) return null;
  return {
    cloudAgentSessionId: row.cloud_agent_session_id,
    worktreeId: row.cloud_agent_worktree_id,
    scopeId: row.cloud_agent_session_scope_id,
  };
}

function siblingCondition(identity: HostedRootIdentity): SQL | undefined {
  const scopeId = identity.scopeId ?? identity.cloudAgentSessionId;
  const sameWorkspace: SQL[] = [eq(cli_sessions_v2.cloud_agent_session_id, scopeId)];
  if (identity.worktreeId !== null) {
    sameWorkspace.push(eq(cli_sessions_v2.cloud_agent_worktree_id, identity.worktreeId));
  }
  return and(
    isNull(cli_sessions_v2.parent_session_id),
    isNotNull(cli_sessions_v2.cloud_agent_session_id),
    ne(cli_sessions_v2.cloud_agent_session_id, scopeId),
    or(...sameWorkspace)
  );
}

export async function hasSurvivingHostedRoot(
  db: Pick<WorkerDb, 'select'>,
  kiloUserId: string,
  identity: HostedRootIdentity
): Promise<boolean> {
  const condition = siblingCondition(identity);
  if (!condition) return false;
  const [sibling] = await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.kilo_user_id, kiloUserId), condition))
    .limit(1);
  return sibling !== undefined;
}
