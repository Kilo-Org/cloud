import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import {
  isGitHubOwnerName,
  isGitHubRepositoryName,
} from '@/lib/integrations/platforms/github/repository-coordinates';
import { pullRequestUrlMatchesRepo } from '@/lib/integrations/platforms/github/pr-link-identity';
import {
  getPrObservationSummary,
  prObservationSummarySchema,
} from '@/lib/integrations/platforms/github/pr-observations';

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

/**
 * Shared wire schema and formatters for a session's associated PR, used by
 * both the session router and the active-sessions list.
 */

export const associatedPrSchema = z.object({
  url: z.string(),
  number: z.number(),
  state: z.string(),
  title: z.string().nullable(),
  headSha: z.string().nullable(),
  observations: prObservationSummarySchema.nullable(),
  lastSyncedAt: z.string(),
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  // True when the server has flagged this PR for an async review-decision
  // fetch (see batch-review-decisions.ts) and the result has not landed yet.
  // Clients can poll the list endpoint while any row reports pending=true to
  // surface review-decision badges shortly after they become available.
  reviewDecisionPending: z.boolean(),
  // Host platform of the linked PR (e.g. 'github'). Always present when an
  // associatedPr is returned.
  platform: z.string(),
  baseRef: z.string().nullable(),
  stackNumber: z.number().nullable(),
  stackPosition: z.number().nullable(),
  stackSize: z.number().nullable(),
});

export type AssociatedPrRow = {
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_title: string | null;
  pr_head_sha: string | null;
  pr_observations?: unknown;
  pr_last_synced_at: string | null;
  pr_review_decision: string | null;
  review_decision_pending: boolean | null;
  pr_base_ref?: string | null;
  stack_number?: number | null;
  stack_position?: number | null;
  stack_size?: number | null;
  /**
   * True when the row is the PR of the session's Cloud Agent workspace (a PR
   * on the workspace's repository and branch) rather than the session's own
   * reported link. See `sessionAssociatedPr`.
   */
  pr_from_workspace?: boolean | null;
};

/**
 * The session's stored PR link (cli_sessions_v2.platform / pr_url / pr_number)
 * plus its updated_at and verified-at, used for the pending-partial
 * lastSyncedAt and to gate the live cache fields.
 */
export type SessionPrFields = {
  platform: string | null;
  pr_url: string | null;
  pr_number: number | null;
  updated_at: string | null;
  /**
   * `cli_sessions_v2.git_url`. A pending link is only surfaced when it names
   * this repository; an unparseable or mismatched link is no evidence.
   */
  git_url: string | null;
  /**
   * `cli_sessions_v2.pr_link_verified_at`. Non-null lets the read path serve
   * the matching cache row's live fields; null means the link has not been
   * verified against GitHub and must not be shown.
   */
  pr_link_verified_at: string | null;
};

/**
 * Parse a GitHub pull-request URL into `{ owner, repo, number }`. Returns
 * `null` for non-GitHub hosts, URLs that do not resolve to
 * `owner/repo/pull/N`, and owner or repo values outside GitHub's name charset.
 * Accepts a trailing subpath (e.g. `/files`), query
 * string, and fragment, matching the mobile parser so a pasted PR URL is
 * never skipped during refresh. A PR URL has more than two path segments,
 * so `parseGitHubOwnerRepo` cannot parse it.
 */
export function parseGitHubPrUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
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

  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }

  const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 4 || segments[2] !== 'pull') {
    return null;
  }
  const [owner, repo, , numberStr] = segments;
  const number = Number(numberStr);
  if (!isGitHubOwnerName(owner) || !isGitHubRepositoryName(repo)) {
    return null;
  }
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  return { owner, repo, number };
}

/**
 * Format a cache row into the associatedPr shape. Returns null when the cache
 * row has no PR. `platform` is supplied by the caller.
 */
function formatCacheRow(
  cache: AssociatedPrRow,
  platform: string
): z.infer<typeof associatedPrSchema> | null {
  if (
    cache.pr_url === null ||
    cache.pr_number === null ||
    cache.pr_state === null ||
    cache.pr_last_synced_at === null
  ) {
    return null;
  }
  const rd = cache.pr_review_decision;
  const reviewDecision =
    rd === 'approved' || rd === 'changes_requested' || rd === 'review_required' ? rd : null;
  return {
    url: cache.pr_url,
    number: cache.pr_number,
    state: cache.pr_state,
    title: cache.pr_title,
    headSha: cache.pr_head_sha,
    observations: getPrObservationSummary(cache.pr_observations, cache.pr_head_sha),
    lastSyncedAt: cache.pr_last_synced_at,
    reviewDecision,
    reviewDecisionPending: cache.review_decision_pending === true,
    platform,
    baseRef: cache.pr_base_ref ?? null,
    stackNumber: cache.stack_number ?? null,
    stackPosition: cache.stack_position ?? null,
    stackSize: cache.stack_size ?? null,
  };
}

/**
 * Build the pending partial for a session whose own stored link is verified but
 * whose per-PR cache row is missing or names a different PR. Carries only the
 * session's own link fields; never another PR's cache fields.
 *
 * `formatAssociatedPr` only calls this for a verified link, but the guard below
 * keeps an unverified link from ever rendering even if called directly: an
 * unverified link must name the session's repository and be a GitHub link.
 */
function pendingPartialFromSession(
  session: SessionPrFields,
  reviewDecisionPending: boolean
): z.infer<typeof associatedPrSchema> | null {
  if (session.pr_url === null) {
    return null;
  }
  if (session.pr_link_verified_at === null) {
    // An unverified link must name the session's repository; a stored link to
    // another repo is no evidence and is never surfaced. A verified link has
    // already passed that check against GitHub, so it needs no re-check here.
    if (!pullRequestUrlMatchesRepo(session.pr_url, session.git_url)) {
      return null;
    }
    // Only a GitHub link has a verification path here. Another platform's
    // unverified link would stay pending forever, so it is not shown as a PR.
    if (session.platform != null && session.platform !== 'github') {
      return null;
    }
  }
  const url = session.pr_url;
  const parsed = parseGitHubPrUrl(url);
  return {
    url,
    number: session.pr_number ?? parsed?.number ?? 0,
    state: 'unknown',
    title: null,
    headSha: null,
    observations: null,
    lastSyncedAt: session.updated_at
      ? new Date(session.updated_at).toISOString()
      : new Date().toISOString(),
    reviewDecision: null,
    reviewDecisionPending,
    platform: session.platform ?? 'github',
    baseRef: null,
    stackNumber: null,
    stackPosition: null,
    stackSize: null,
  };
}

/**
 * Compare two PR URLs as the same pull request, ignoring trailing subpath,
 * query, fragment, and trailing slash. A stored link like
 * `.../pull/7/files` names the same PR as the canonical cache URL
 * `.../pull/7`. Returns `false` when either URL is not a parseable GitHub PR
 * URL.
 */
export function samePullRequest(sessionUrl: string, cacheUrl: string): boolean {
  if (sessionUrl === cacheUrl) return true;
  const s = parseGitHubPrUrl(sessionUrl);
  const c = parseGitHubPrUrl(cacheUrl);
  return (
    s !== null &&
    c !== null &&
    s.owner.toLowerCase() === c.owner.toLowerCase() &&
    s.repo.toLowerCase() === c.repo.toLowerCase() &&
    s.number === c.number
  );
}

/**
 * Format the associated PR for a session. The link must be the session's own
 * stored link and it must have passed GitHub verification; otherwise no PR is
 * shown.
 *
 *   1. Verified session link matches the cache PR → live cache fields.
 *   2. Verified session link, cache missing or for a different PR → pending
 *      partial (the session's own URL/number, state `unknown`, never the other
 *      PR's cache fields).
 *   3. No stored link, or a stored link GitHub has not verified
 *      (`pr_link_verified_at` NULL) → `null`. An unverified link is a guess, so
 *      it is never surfaced as a badge or an Open-on-GitHub link; a wrong link
 *      is worse than no link.
 *
 * The one exception is a Cloud Agent workspace's PR (`pr_from_workspace`): a
 * PR on the branch the workspace has checked out belongs to every chat in it,
 * so it is shown without a link of the chat's own. Outside workspaces there is
 * no branch-name fallback: a session with no stored link shows no PR, however
 * fresh the cache row for its branch happens to be.
 */
export function formatAssociatedPr(
  session: SessionPrFields,
  cache: AssociatedPrRow,
  opts?: { partialReviewDecisionPending?: boolean }
): z.infer<typeof associatedPrSchema> | null {
  if (cache.pr_from_workspace === true) {
    return formatCacheRow(cache, 'github');
  }
  if (session.pr_url === null || session.pr_link_verified_at === null) {
    return null;
  }
  if (cache.pr_url !== null && samePullRequest(session.pr_url, cache.pr_url)) {
    return formatCacheRow(cache, session.platform ?? 'github');
  }
  return pendingPartialFromSession(session, opts?.partialReviewDecisionPending ?? true);
}
