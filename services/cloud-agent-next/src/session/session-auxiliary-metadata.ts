import type { WorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  github_branch_pull_requests,
  type CliSessionV2,
} from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
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

// Keep the verified-link projection aligned with cli-sessions-v2-router.formatAssociatedPr.
function formatAssociatedPr(session: SessionPrFields, cache: AssociatedPrRow): AssociatedPr | null {
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
    if (cache.pr_number === null || cache.pr_state === null || cache.pr_last_synced_at === null) {
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
      platform: session.platform ?? 'github',
    };
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
      pr_url: github_branch_pull_requests.pr_url,
      pr_number: github_branch_pull_requests.pr_number,
      pr_state: github_branch_pull_requests.pr_state,
      pr_title: github_branch_pull_requests.pr_title,
      pr_head_sha: github_branch_pull_requests.pr_head_sha,
      pr_last_synced_at: github_branch_pull_requests.pr_last_synced_at,
      pr_review_decision: github_branch_pull_requests.pr_review_decision,
      review_decision_pending: github_branch_pull_requests.review_decision_pending,
    })
    .from(cli_sessions_v2)
    .leftJoin(
      github_branch_pull_requests,
      and(
        eq(github_branch_pull_requests.git_url, cli_sessions_v2.git_url),
        eq(github_branch_pull_requests.pr_number, cli_sessions_v2.pr_number),
        or(
          and(
            isNotNull(cli_sessions_v2.organization_id),
            eq(
              github_branch_pull_requests.owned_by_organization_id,
              cli_sessions_v2.organization_id
            )
          ),
          and(
            isNull(cli_sessions_v2.organization_id),
            eq(github_branch_pull_requests.owned_by_user_id, cli_sessions_v2.kilo_user_id)
          )
        ),
        isNotNull(cli_sessions_v2.pr_url),
        isNotNull(cli_sessions_v2.pr_link_verified_at)
      )
    )
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
