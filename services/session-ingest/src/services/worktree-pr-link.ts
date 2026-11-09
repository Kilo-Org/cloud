import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

type CliSessionsV2Row = typeof cli_sessions_v2.$inferSelect;

/**
 * A pull request belongs to the Cloud Agent worktree, so a new chat in a
 * worktree starts with the verified link its sibling chats already carry.
 * Later pull_request webhooks keep every chat in the worktree up to date.
 */
export async function inheritWorktreePullRequestLink(
  db: Pick<WorkerDb, 'select' | 'update'>,
  created: CliSessionsV2Row
): Promise<CliSessionsV2Row> {
  if (!created.cloud_agent_worktree_id || !created.git_url) return created;

  const [sibling] = await db
    .select({
      platform: cli_sessions_v2.platform,
      pr_url: cli_sessions_v2.pr_url,
      pr_number: cli_sessions_v2.pr_number,
      pr_head_ref: cli_sessions_v2.pr_head_ref,
      pr_head_sha: cli_sessions_v2.pr_head_sha,
      pr_link_verified_at: cli_sessions_v2.pr_link_verified_at,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, created.kilo_user_id),
        eq(cli_sessions_v2.cloud_agent_worktree_id, created.cloud_agent_worktree_id),
        ne(cli_sessions_v2.session_id, created.session_id),
        eq(cli_sessions_v2.git_url, created.git_url),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.pr_url),
        isNotNull(cli_sessions_v2.pr_link_verified_at)
      )
    )
    .orderBy(desc(cli_sessions_v2.pr_link_verified_at))
    .limit(1);
  if (!sibling) return created;

  const [updated] = await db
    .update(cli_sessions_v2)
    .set(sibling)
    .where(
      and(
        eq(cli_sessions_v2.session_id, created.session_id),
        eq(cli_sessions_v2.kilo_user_id, created.kilo_user_id),
        isNull(cli_sessions_v2.pr_url)
      )
    )
    .returning();
  return updated ?? created;
}
