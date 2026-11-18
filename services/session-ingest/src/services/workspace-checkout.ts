import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cloud_agent_worktrees } from '@kilocode/db/schema';

/**
 * Records the repository and branch a chat in a Cloud Agent workspace reported
 * as checked out. Every chat in a workspace shares one checkout, so the latest
 * report is the workspace's branch, and a pull request on that branch is the
 * workspace's pull request.
 */
export async function recordWorkspaceCheckout(
  db: Pick<WorkerDb, 'update'>,
  kiloUserId: string,
  checkout: { worktreeId: string; gitUrl: string; gitBranch: string }
): Promise<void> {
  try {
    await db
      .update(cloud_agent_worktrees)
      .set({ git_url: checkout.gitUrl, git_branch: checkout.gitBranch })
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, checkout.worktreeId),
          eq(cloud_agent_worktrees.kilo_user_id, kiloUserId),
          isNull(cloud_agent_worktrees.deletion_started_at),
          // A checkout of the base branch (to pull, or to inspect a stack
          // parent) is a detour, not the workspace's own work: keep the branch.
          sql`${cloud_agent_worktrees.base_branch} IS DISTINCT FROM ${checkout.gitBranch}`,
          or(
            sql`${cloud_agent_worktrees.git_url} IS DISTINCT FROM ${checkout.gitUrl}`,
            sql`${cloud_agent_worktrees.git_branch} IS DISTINCT FROM ${checkout.gitBranch}`
          )
        )
      );
  } catch (error) {
    // The session write already committed; the next branch report retries this.
    console.error('Failed to record Cloud Agent workspace checkout', {
      kiloUserId,
      worktreeId: checkout.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
