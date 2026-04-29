import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/lib/drizzle';
import { cli_session_pull_requests, cli_sessions_v2 } from '@kilocode/db/schema';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { normalizeGitUrl } from '@/lib/integrations/platforms/github/utils';
import { logExceptInTest } from '@/lib/utils.server';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';

type Db = typeof defaultDb;

const ACTIONS_TO_UPSERT: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.CLOSED,
]);

export function shouldUpsertCliSessionPullRequest(action: string): boolean {
  return ACTIONS_TO_UPSERT.has(action);
}

function derivePrState(payload: PullRequestPayload): 'open' | 'closed' | 'merged' {
  const { action, pull_request } = payload;
  if (action === GITHUB_ACTION.CLOSED) {
    return pull_request.merged === true ? 'merged' : 'closed';
  }
  return pull_request.state === 'closed' ? 'closed' : 'open';
}

function extractHeadRepoUrls(payload: PullRequestPayload): string[] {
  const headRepo = payload.pull_request.head.repo;
  if (!headRepo) return [];

  const urls: string[] = [];
  if (headRepo.clone_url) urls.push(headRepo.clone_url);
  if (headRepo.html_url) urls.push(`${headRepo.html_url}.git`);
  return urls;
}

/**
 * Mirror of the webhook payload info that the DB row needs. Extracted so
 * handlers can validate/shape the payload before handing it off.
 */
type UpsertPullRequestSnapshot = {
  prUrl: string;
  prNumber: number;
  prState: 'open' | 'closed' | 'merged';
  prTitle: string;
  prHeadSha: string;
};

function snapshotFromPayload(payload: PullRequestPayload): UpsertPullRequestSnapshot | null {
  const pr = payload.pull_request;
  if (!pr.html_url) return null;
  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
    prState: derivePrState(payload),
    prTitle: pr.title,
    prHeadSha: pr.head.sha,
  };
}

/**
 * Side-effect for `pull_request` webhooks: keep `cli_session_pull_requests`
 * in sync for any cloud-agent-next session whose `(git_url, git_branch)`
 * matches the PR's head. Errors are logged and swallowed — the primary
 * code-review flow must not fail just because we can't update the side table.
 */
export async function upsertCliSessionPullRequestFromWebhook(
  payload: PullRequestPayload,
  deps: { db?: Db } = {}
): Promise<{ sessions_updated: number; skipped?: true }> {
  const db = deps.db ?? defaultDb;
  const { action, pull_request, repository } = payload;

  if (!shouldUpsertCliSessionPullRequest(action)) {
    return { sessions_updated: 0, skipped: true };
  }

  const snapshot = snapshotFromPayload(payload);
  if (!snapshot) {
    return { sessions_updated: 0, skipped: true };
  }

  const headBranch = pull_request.head.ref;
  const rawHeadRepoUrls = extractHeadRepoUrls(payload);
  if (rawHeadRepoUrls.length === 0 || !headBranch) {
    return { sessions_updated: 0, skipped: true };
  }

  const candidateUrls = new Set<string>();
  for (const url of rawHeadRepoUrls) {
    candidateUrls.add(url);
    candidateUrls.add(normalizeGitUrl(url));
  }

  try {
    const matchingRows = await db
      .select({ session_id: cli_sessions_v2.session_id, git_url: cli_sessions_v2.git_url })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.git_branch, headBranch),
          inArray(cli_sessions_v2.git_url, [...candidateUrls])
        )
      );

    // Filter a second time in JS on the normalized URL to discard sessions
    // whose `git_url` happened to share a literal value with one of the raw
    // candidates but doesn't actually normalize to the same repo.
    const normalizedCandidates = new Set(rawHeadRepoUrls.map(normalizeGitUrl));
    const matchedSessions = matchingRows.filter(row => {
      if (!row.git_url) return false;
      return normalizedCandidates.has(normalizeGitUrl(row.git_url));
    });

    if (matchedSessions.length === 0) {
      logExceptInTest('pull_request webhook: no cli_sessions matched', {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch: headBranch,
        sessions_updated: 0,
      });
      return { sessions_updated: 0 };
    }

    const sessionIds = matchedSessions.map(s => s.session_id);

    await db
      .insert(cli_session_pull_requests)
      .values(
        sessionIds.map(sessionId => ({
          session_id: sessionId,
          pr_url: snapshot.prUrl,
          pr_number: snapshot.prNumber,
          pr_state: snapshot.prState,
          pr_title: snapshot.prTitle,
          pr_head_sha: snapshot.prHeadSha,
        }))
      )
      .onConflictDoUpdate({
        target: cli_session_pull_requests.session_id,
        set: {
          pr_url: snapshot.prUrl,
          pr_number: snapshot.prNumber,
          pr_state: snapshot.prState,
          pr_title: snapshot.prTitle,
          pr_head_sha: snapshot.prHeadSha,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      });

    logExceptInTest('pull_request webhook: upserted cli_session_pull_requests', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch: headBranch,
      sessions_updated: sessionIds.length,
    });

    return { sessions_updated: sessionIds.length };
  } catch (error) {
    logExceptInTest('pull_request webhook: failed to upsert cli_session_pull_requests', error);
    captureException(error, {
      tags: { source: 'pull_request_webhook_associated_pr' },
      extra: {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch: headBranch,
      },
    });
    return { sessions_updated: 0 };
  }
}
