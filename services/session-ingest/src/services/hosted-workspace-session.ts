import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import {
  WORKSPACE_DELETING,
  WORKSPACE_IDENTITY_CONFLICT,
  WORKSPACE_REQUIRES_ROOT_SESSION,
  type CloudAgentWorktreeId,
  type DeleteHostedWorkspaceSessionParams,
} from '@kilocode/session-ingest-contracts';

type SessionTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

type SessionDeleteRow = {
  session_id: string;
  parent_session_id: string | null;
  organization_id: string | null;
  git_url: string | null;
  git_branch: string | null;
  created_on_platform: string;
};

export type WorkspaceRootRow = {
  session_id: string;
  cloud_agent_session_id: string | null;
  cloud_agent_worktree_id: string | null;
  parent_session_id: string | null;
};

export class HostedWorkspaceSessionDeleteError extends Error {
  readonly code:
    | typeof WORKSPACE_REQUIRES_ROOT_SESSION
    | typeof WORKSPACE_DELETING
    | typeof WORKSPACE_IDENTITY_CONFLICT;

  constructor(code: HostedWorkspaceSessionDeleteError['code']) {
    super(code);
    this.name = 'HostedWorkspaceSessionDeleteError';
    this.code = code;
  }
}

/**
 * Locks one workspace and its hosted roots, then rejects a destructive delete
 * that would leave an active workspace without a root session.
 *
 * Roots are locked in a deterministic order so two concurrent final-root
 * deletes serialize: the second transaction observes the first delete and is
 * rejected instead of leaving the workspace rootless. A root without a
 * workspace identity is not a workspace root and is not guarded.
 */
export async function lockAndAssertWorkspaceRootSurvives(
  tx: SessionTransaction,
  params: {
    kiloUserId: string;
    row: WorkspaceRootRow;
  }
): Promise<CloudAgentWorktreeId | null> {
  const workspaceId = (params.row.cloud_agent_worktree_id ?? null) as CloudAgentWorktreeId | null;
  if (workspaceId === null || params.row.parent_session_id !== null) return null;

  const [worktree] = await tx
    .select({ deletionStartedAt: cloud_agent_worktrees.deletion_started_at })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, workspaceId))
    .limit(1)
    .for('update');
  if (worktree?.deletionStartedAt != null) {
    throw new HostedWorkspaceSessionDeleteError(WORKSPACE_DELETING);
  }

  const roots = await tx
    .select({
      sessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      parentSessionId: cli_sessions_v2.parent_session_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
        eq(cli_sessions_v2.cloud_agent_worktree_id, workspaceId),
        isNull(cli_sessions_v2.parent_session_id)
      )
    )
    .orderBy(asc(cli_sessions_v2.session_id))
    .for('update');

  const target = roots.find(root => root.sessionId === params.row.session_id);
  if (
    target === undefined ||
    target.cloudAgentSessionId !== params.row.cloud_agent_session_id ||
    target.worktreeId !== workspaceId
  ) {
    throw new HostedWorkspaceSessionDeleteError(WORKSPACE_IDENTITY_CONFLICT);
  }
  if (roots.length < 2) {
    throw new HostedWorkspaceSessionDeleteError(WORKSPACE_REQUIRES_ROOT_SESSION);
  }
  return workspaceId;
}

/**
 * Checks whether a session delete would remove the final hosted root. The
 * caller owns authorization; this only answers the workspace invariant.
 */
export async function assertHostedWorkspaceSessionDeletable(
  db: WorkerDb,
  params: {
    kiloUserId: string;
    sessionId: string;
    cloudAgentSessionId: string;
  }
): Promise<{ workspaceId: CloudAgentWorktreeId | null }> {
  return db.transaction(async tx => {
    // Read the immutable workspace identity without taking a row lock. The
    // guard below locks worktree -> roots (including this target) in the same
    // order as HTTP deletes and whole-workspace deletion.
    const [row] = await tx
      .select({
        session_id: cli_sessions_v2.session_id,
        cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
        cloud_agent_worktree_id: cli_sessions_v2.cloud_agent_worktree_id,
        parent_session_id: cli_sessions_v2.parent_session_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          eq(cli_sessions_v2.session_id, params.sessionId)
        )
      )
      .limit(1);
    if (!row) return { workspaceId: null };
    if (row.cloud_agent_session_id !== params.cloudAgentSessionId) {
      throw new HostedWorkspaceSessionDeleteError(WORKSPACE_IDENTITY_CONFLICT);
    }
    return { workspaceId: await lockAndAssertWorkspaceRootSurvives(tx, { ...params, row }) };
  });
}

/**
 * Deletes one hosted root, its descendants, and the ownership rows in one
 * transaction. Refuses the final root of an active workspace. Returns the
 * deleted rows so the caller can clear ingest storage and publish deletion
 * events after the commit.
 */
export async function deleteHostedWorkspaceSessionRows(
  db: WorkerDb,
  params: DeleteHostedWorkspaceSessionParams
): Promise<{
  deleted: boolean;
  deletedSessionIds: string[];
  rows: SessionDeleteRow[];
}> {
  return db.transaction(async tx => {
    // Read the immutable workspace identity without taking a row lock. The
    // guard below locks worktree -> roots (including this target) in the same
    // order as every other workspace deletion path.
    const [row] = await tx
      .select({
        session_id: cli_sessions_v2.session_id,
        cloud_agent_session_id: cli_sessions_v2.cloud_agent_session_id,
        cloud_agent_worktree_id: cli_sessions_v2.cloud_agent_worktree_id,
        parent_session_id: cli_sessions_v2.parent_session_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          eq(cli_sessions_v2.session_id, params.sessionId)
        )
      )
      .limit(1);
    if (!row) return { deleted: false, deletedSessionIds: [], rows: [] };
    if (
      row.cloud_agent_session_id !== params.cloudAgentSessionId ||
      row.cloud_agent_worktree_id !== params.workspaceId ||
      row.parent_session_id !== null
    ) {
      throw new HostedWorkspaceSessionDeleteError(WORKSPACE_IDENTITY_CONFLICT);
    }
    await lockAndAssertWorkspaceRootSurvives(tx, { ...params, row });

    const tree = await tx.execute<{ session_id: string; depth: number }>(sql`
      WITH RECURSIVE tree AS (
        SELECT session_id, parent_session_id, 0 AS depth, ARRAY[session_id] AS path
        FROM ${cli_sessions_v2}
        WHERE session_id = ${params.sessionId} AND kilo_user_id = ${params.kiloUserId}
        UNION ALL
        SELECT child.session_id, child.parent_session_id, tree.depth + 1, tree.path || child.session_id
        FROM ${cli_sessions_v2} child
        INNER JOIN tree ON child.parent_session_id = tree.session_id
          AND child.kilo_user_id = ${params.kiloUserId}
        WHERE NOT (child.session_id = ANY(tree.path)) AND tree.depth < 10
      )
      SELECT session_id, depth FROM tree ORDER BY depth DESC
    `);
    const orderedSessionIds = tree.rows.map(entry => entry.session_id);
    if (!orderedSessionIds.includes(params.sessionId)) {
      throw new HostedWorkspaceSessionDeleteError(WORKSPACE_IDENTITY_CONFLICT);
    }

    const rows = await tx
      .select({
        session_id: cli_sessions_v2.session_id,
        parent_session_id: cli_sessions_v2.parent_session_id,
        organization_id: cli_sessions_v2.organization_id,
        git_url: cli_sessions_v2.git_url,
        git_branch: cli_sessions_v2.git_branch,
        created_on_platform: cli_sessions_v2.created_on_platform,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, params.kiloUserId),
          inArray(cli_sessions_v2.session_id, orderedSessionIds)
        )
      );

    for (const sessionId of orderedSessionIds) {
      await tx
        .delete(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, params.kiloUserId)
          )
        );
    }

    return { deleted: true, deletedSessionIds: orderedSessionIds, rows };
  });
}
