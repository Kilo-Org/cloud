import type { WorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
  type CliSessionV2,
} from '@kilocode/db/schema';
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { GetSessionResponse } from '../router/schemas.js';

type AssociatedPr = NonNullable<GetSessionResponse['associatedPr']>;
type SessionPrFields = Pick<
  CliSessionV2,
  'platform' | 'pr_url' | 'pr_number' | 'pr_link_verified_at' | 'updated_at'
>;
type AssociatedPrRow = {
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_last_synced_at: string | null;
  pr_review_decision: string | null;
  review_decision_pending: boolean | null;
  pr_from_workspace: boolean | null;
};

function parseGitHubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let path: string;
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    path = sshMatch[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/^\/+/, '');
  }
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 4 || segments[2] !== 'pull') return null;
  const [owner, repo, , numberStr] = segments;
  const number = Number(numberStr);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  return { owner, repo, number };
}

function formatCacheRow(cache: AssociatedPrRow, platform: string): AssociatedPr | null {
  if (
    cache.pr_url === null ||
    cache.pr_number === null ||
    cache.pr_state === null ||
    cache.pr_last_synced_at === null
  ) {
    return null;
  }
  const rd = cache.pr_review_decision;
  return {
    url: cache.pr_url,
    number: cache.pr_number,
    state: cache.pr_state,
    title: cache.pr_title,
    headSha: cache.pr_head_sha,
    lastSyncedAt: new Date(cache.pr_last_synced_at).toISOString(),
    reviewDecision:
      rd === 'approved' || rd === 'changes_requested' || rd === 'review_required' ? rd : null,
    reviewDecisionPending: cache.review_decision_pending === true,
    platform,
  };
}

// Keep the projection aligned with cli-sessions-v2-router.formatAssociatedPr.
function formatAssociatedPr(session: SessionPrFields, cache: AssociatedPrRow): AssociatedPr | null {
  if (cache.pr_from_workspace === true) return formatCacheRow(cache, 'github');
  if (session.pr_url === null || session.pr_link_verified_at === null) return null;

  const sessionPr = parseGitHubPrUrl(session.pr_url);
  const cachePr = cache.pr_url === null ? null : parseGitHubPrUrl(cache.pr_url);
  if (
    cache.pr_url !== null &&
    (session.pr_url === cache.pr_url ||
      (sessionPr !== null &&
        cachePr !== null &&
        sessionPr.owner.toLowerCase() === cachePr.owner.toLowerCase() &&
        sessionPr.repo.toLowerCase() === cachePr.repo.toLowerCase() &&
        sessionPr.number === cachePr.number))
  ) {
    return formatCacheRow(cache, session.platform ?? 'github');
  }

  return {
    url: session.pr_url,
    number: session.pr_number ?? sessionPr?.number ?? 0,
    state: 'unknown',
    title: null,
    headSha: null,
    lastSyncedAt: session.updated_at
      ? new Date(session.updated_at).toISOString()
      : new Date().toISOString(),
    reviewDecision: null,
    reviewDecisionPending: true,
    platform: session.platform ?? 'github',
  };
}

// Keep aligned with apps/web/src/lib/session-associated-pr.ts: the PR of the
// session's Cloud Agent workspace (a PR on the branch the workspace has checked
// out) or of the session's own verified link; open first, then workspace first.
const isWorkspacePr = sql<boolean>`(${github_branch_pull_requests.git_url}, ${github_branch_pull_requests.git_branch}) = (
    SELECT ${cloud_agent_worktrees.git_url}, ${cloud_agent_worktrees.git_branch}
    FROM ${cloud_agent_worktrees}
    WHERE ${cloud_agent_worktrees.worktree_id} = ${cli_sessions_v2.cloud_agent_worktree_id}
      AND ${cloud_agent_worktrees.deletion_started_at} IS NULL
)`;

const sessionAssociatedPr = new QueryBuilder()
  .select({
    pr_url: github_branch_pull_requests.pr_url,
    pr_number: github_branch_pull_requests.pr_number,
    pr_state: github_branch_pull_requests.pr_state,
    pr_title: github_branch_pull_requests.pr_title,
    pr_head_sha: github_branch_pull_requests.pr_head_sha,
    pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
    pr_review_decision: github_branch_pull_requests.pr_review_decision,
    review_decision_pending: github_branch_pull_requests.review_decision_pending,
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
      or(
        isWorkspacePr,
        and(
          isNotNull(cli_sessions_v2.pr_url),
          isNotNull(cli_sessions_v2.pr_link_verified_at),
          eq(github_branch_pull_requests.git_url, cli_sessions_v2.git_url),
          eq(github_branch_pull_requests.pr_number, cli_sessions_v2.pr_number)
        )
      )
    )
  )
  .orderBy(
    sql`${github_branch_pull_requests.pr_state} IN ('open', 'draft') DESC`,
    sql`"pr_from_workspace" DESC`,
    desc(github_branch_pull_requests.pr_number)
  )
  .limit(1)
  .as('session_pr');

export async function getSessionAuxiliaryMetadata(
  db: Pick<WorkerDb, 'select'>,
  input: {
    userId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    organizationId: string | null;
  }
): Promise<{
  createdOnPlatform: string;
  profileId: string | null;
  associatedPr: AssociatedPr | null;
} | null> {
  const [row] = await db
    .select({
      createdOnPlatform: cli_sessions_v2.created_on_platform,
      profileId: cli_sessions_v2.profile_id,
      session: {
        platform: cli_sessions_v2.platform,
        pr_url: cli_sessions_v2.pr_url,
        pr_number: cli_sessions_v2.pr_number,
        pr_link_verified_at: cli_sessions_v2.pr_link_verified_at,
        updated_at: cli_sessions_v2.updated_at,
      },
      pr_url: sessionAssociatedPr.pr_url,
      pr_number: sessionAssociatedPr.pr_number,
      pr_state: sessionAssociatedPr.pr_state,
      pr_title: sessionAssociatedPr.pr_title,
      pr_head_sha: sessionAssociatedPr.pr_head_sha,
      pr_last_synced_at: sessionAssociatedPr.pr_last_synced_at,
      pr_review_decision: sessionAssociatedPr.pr_review_decision,
      review_decision_pending: sessionAssociatedPr.review_decision_pending,
      pr_from_workspace: sessionAssociatedPr.pr_from_workspace,
    })
    .from(cli_sessions_v2)
    .leftJoinLateral(sessionAssociatedPr, sql`true`)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, input.userId),
        eq(cli_sessions_v2.session_id, input.kiloSessionId),
        eq(cli_sessions_v2.cloud_agent_session_id, input.cloudAgentSessionId),
        input.organizationId === null
          ? isNull(cli_sessions_v2.organization_id)
          : eq(cli_sessions_v2.organization_id, input.organizationId)
      )
    )
    .limit(1);

  return row
    ? {
        createdOnPlatform: row.createdOnPlatform,
        profileId: row.profileId,
        associatedPr: formatAssociatedPr(row.session, row),
      }
    : null;
}
