import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';

/**
 * The PR cache row of the session's Cloud Agent workspace: a PR on the
 * repository and branch the workspace has checked out. Every chat in a
 * workspace shares one checkout, so this PR belongs to all of them without any
 * chat reporting it.
 */
const isWorkspacePr = sql<boolean>`(${github_branch_pull_requests.git_url}, ${github_branch_pull_requests.git_branch}) = (
  SELECT ${cloud_agent_worktrees.git_url}, ${cloud_agent_worktrees.git_branch}
  FROM ${cloud_agent_worktrees}
  WHERE ${cloud_agent_worktrees.worktree_id} = ${cli_sessions_v2.cloud_agent_worktree_id}
    AND ${cloud_agent_worktrees.deletion_started_at} IS NULL
)`;

/**
 * The PR cache row of the session's own reported link, by PR identity. A
 * branch name outside a workspace is not identity, so this is keyed on
 * `(git_url, pr_number)` and requires a stored link GitHub verified.
 */
const isSessionLinkPr = and(
  isNotNull(cli_sessions_v2.pr_url),
  isNotNull(cli_sessions_v2.pr_link_verified_at),
  eq(github_branch_pull_requests.git_url, cli_sessions_v2.git_url),
  eq(github_branch_pull_requests.pr_number, cli_sessions_v2.pr_number)
);

/**
 * LEFT JOIN LATERAL subquery choosing the one PR cache row shown for a
 * session (join it with `sql\`true\``):
 *
 *   - the PR of the session's Cloud Agent workspace (`isWorkspacePr`), or
 *   - the PR of the session's own verified link (`isSessionLinkPr`).
 *
 * An open or draft PR wins over a closed or merged one, then the workspace PR
 * wins over the session link, then the newest PR number. The row is always in
 * the session's tenant.
 *
 * Per session row this is one primary-key lookup on `cloud_agent_worktrees` and
 * a bitmap OR over `IDX_github_branch_prs_url_branch` and
 * `IDX_github_branch_prs_url_pr_number`. Do not drop either index — without
 * them every list and search scans the whole cache table per row.
 */
export const sessionAssociatedPr = new QueryBuilder()
  .select({
    pr_url: github_branch_pull_requests.pr_url,
    pr_number: github_branch_pull_requests.pr_number,
    pr_state: github_branch_pull_requests.pr_state,
    pr_title: github_branch_pull_requests.pr_title,
    pr_head_sha: github_branch_pull_requests.pr_head_sha,
    pr_observations: github_branch_pull_requests.pr_observations,
    pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
    pr_review_decision: github_branch_pull_requests.pr_review_decision,
    review_decision_pending: github_branch_pull_requests.review_decision_pending,
    pr_base_ref: github_branch_pull_requests.pr_base_ref,
    stack_number: github_branch_pull_requests.stack_number,
    stack_position: github_branch_pull_requests.stack_position,
    stack_size: github_branch_pull_requests.stack_size,
    updated_at: github_branch_pull_requests.updated_at,
    git_url: github_branch_pull_requests.git_url,
    git_branch: github_branch_pull_requests.git_branch,
    pr_from_workspace: sql<boolean>`coalesce(${isWorkspacePr}, false)`.as('pr_from_workspace'),
  })
  .from(github_branch_pull_requests)
  .where(
    and(
      isNotNull(github_branch_pull_requests.pr_number),
      or(
        and(
          isNotNull(cli_sessions_v2.organization_id),
          eq(github_branch_pull_requests.owned_by_organization_id, cli_sessions_v2.organization_id)
        ),
        and(
          isNull(cli_sessions_v2.organization_id),
          eq(github_branch_pull_requests.owned_by_user_id, cli_sessions_v2.kilo_user_id)
        )
      ),
      or(isWorkspacePr, isSessionLinkPr)
    )
  )
  .orderBy(
    sql`${github_branch_pull_requests.pr_state} IN ('open', 'draft') DESC`,
    sql`"pr_from_workspace" DESC`,
    desc(github_branch_pull_requests.pr_number)
  )
  .limit(1)
  .as('session_pr');

/**
 * The PR of a session's Cloud Agent workspace, when the PR `sessionAssociatedPr`
 * chooses for the session is the workspace's. Null otherwise.
 */
export async function readWorkspacePullRequest(session: {
  session_id: string;
  kilo_user_id: string;
}): Promise<{ prUrl: string; prNumber: number; gitUrl: string; gitBranch: string } | null> {
  const [row] = await db
    .select({
      pr_url: sessionAssociatedPr.pr_url,
      pr_number: sessionAssociatedPr.pr_number,
      git_url: sessionAssociatedPr.git_url,
      git_branch: sessionAssociatedPr.git_branch,
      pr_from_workspace: sessionAssociatedPr.pr_from_workspace,
    })
    .from(cli_sessions_v2)
    .leftJoinLateral(sessionAssociatedPr, sql`true`)
    .where(
      and(
        eq(cli_sessions_v2.session_id, session.session_id),
        eq(cli_sessions_v2.kilo_user_id, session.kilo_user_id)
      )
    )
    .limit(1);
  if (
    row?.pr_from_workspace !== true ||
    !row.pr_url ||
    !row.pr_number ||
    !row.git_url ||
    !row.git_branch
  ) {
    return null;
  }
  return {
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    gitUrl: row.git_url,
    gitBranch: row.git_branch,
  };
}
