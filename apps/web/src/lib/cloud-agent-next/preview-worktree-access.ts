import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import type { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

async function verifyWorktreeAccess(
  fromDb: typeof db,
  worktreeId: string,
  userId: string,
  organizationId: string | null
): Promise<boolean> {
  const [root] = await fromDb
    .select({ worktreeId: cli_sessions_v2.cloud_agent_worktree_id })
    .from(cli_sessions_v2)
    .leftJoin(
      cloud_agent_worktrees,
      eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id)
    )
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, worktreeId),
        eq(cli_sessions_v2.kilo_user_id, userId),
        organizationId === null
          ? isNull(cli_sessions_v2.organization_id)
          : eq(cli_sessions_v2.organization_id, organizationId),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.cloud_agent_session_id),
        or(
          isNull(cloud_agent_worktrees.worktree_id),
          and(
            eq(cloud_agent_worktrees.kilo_user_id, userId),
            organizationId === null
              ? isNull(cloud_agent_worktrees.organization_id)
              : eq(cloud_agent_worktrees.organization_id, organizationId),
            isNull(cloud_agent_worktrees.deletion_started_at),
            isNull(cloud_agent_worktrees.deletion_completed_at)
          )
        )
      )
    )
    .limit(1);

  return root !== undefined;
}

export function verifyUserOwnsPreviewWorktree(
  fromDb: typeof db,
  userId: string,
  worktreeId: string
): Promise<boolean> {
  return verifyWorktreeAccess(fromDb, worktreeId, userId, null);
}

export function verifyOrgOwnsPreviewWorktree(
  fromDb: typeof db,
  organizationId: string,
  userId: string,
  worktreeId: string
): Promise<boolean> {
  return verifyWorktreeAccess(fromDb, worktreeId, userId, organizationId);
}
