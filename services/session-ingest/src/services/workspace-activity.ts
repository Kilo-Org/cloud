import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';

export async function persistWorkspaceActivity(
  db: Pick<WorkerDb, 'update'>,
  kiloUserId: string,
  sessionId: string,
  activity: string
): Promise<void> {
  await db
    .update(cloud_agent_worktrees)
    .set({ last_activity_at: activity })
    .where(
      and(
        eq(cloud_agent_worktrees.kilo_user_id, kiloUserId),
        isNull(cloud_agent_worktrees.deletion_started_at),
        isNull(cloud_agent_worktrees.deletion_completed_at),
        or(
          isNull(cloud_agent_worktrees.last_activity_at),
          sql`${cloud_agent_worktrees.last_activity_at} < ${activity}::timestamptz`
        ),
        sql`EXISTS (
      SELECT 1 FROM ${cli_sessions_v2}
      WHERE ${cli_sessions_v2.session_id} = ${sessionId}
        AND ${cli_sessions_v2.kilo_user_id} = ${kiloUserId}
        AND ${cli_sessions_v2.cloud_agent_worktree_id} = ${cloud_agent_worktrees.worktree_id}
        AND ${cli_sessions_v2.organization_id} IS NOT DISTINCT FROM ${cloud_agent_worktrees.organization_id}
        AND ${cli_sessions_v2.parent_session_id} IS NULL
    )`
      )
    );
}
