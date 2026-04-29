import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { cli_session_pull_requests, cli_sessions_v2 } from '@kilocode/db/schema';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { normalizeGitUrl } from '@/lib/integrations/platforms/github/normalize-git-url';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';

const UPSERT_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.CLOSED,
]);

type PrState = 'open' | 'closed' | 'merged';

function derivePrState(pr: PullRequestPayload['pull_request'], action: string): PrState {
  if (action === GITHUB_ACTION.CLOSED) {
    return pr.merged === true ? 'merged' : 'closed';
  }
  return pr.state === 'closed' ? 'closed' : 'open';
}

function deriveHeadRepoUrls(pr: PullRequestPayload['pull_request']): string[] {
  const urls: string[] = [];
  const repo = pr.head.repo;
  if (repo?.clone_url) urls.push(repo.clone_url);
  if (repo?.html_url) urls.push(`${repo.html_url}.git`);
  return urls;
}

/**
 * Find all cli_sessions_v2 rows whose (git_url, git_branch) match the PR's
 * head repo + head ref. Probes with both the clone_url/html_url variants
 * verbatim (fast path — hits the `(git_url, git_branch)` index directly) and
 * the normalized form (catches rows where the CLI stored the URL in some
 * other shape).
 */
async function findMatchingSessionIds(args: {
  rawUrls: string[];
  normalizedUrl: string;
  branch: string;
}): Promise<string[]> {
  const candidates = new Set<string>([...args.rawUrls, args.normalizedUrl]);
  if (candidates.size === 0) return [];

  // Fast path: exact match on git_url — will hit the composite index on
  // (git_url, git_branch). This catches the common case where the CLI
  // stored the clone_url or html_url verbatim.
  const exactRows = await db
    .select({ session_id: cli_sessions_v2.session_id, git_url: cli_sessions_v2.git_url })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.git_branch, args.branch),
        inArray(cli_sessions_v2.git_url, [...candidates])
      )
    );

  const matched = new Set<string>(exactRows.map(r => r.session_id));

  // Slow path: normalize in JS for rows that didn't hit the fast path.
  // Scoped to rows with the same branch so we don't scan the whole table.
  const slowRows = await db
    .select({ session_id: cli_sessions_v2.session_id, git_url: cli_sessions_v2.git_url })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.git_branch, args.branch), isNotNull(cli_sessions_v2.git_url)));

  for (const row of slowRows) {
    if (!row.git_url) continue;
    if (matched.has(row.session_id)) continue;
    if (normalizeGitUrl(row.git_url) === args.normalizedUrl) {
      matched.add(row.session_id);
    }
  }

  return [...matched];
}

/**
 * Side-effect: when a pull_request webhook arrives for one of the tracked
 * actions, upsert the PR summary onto every cli_sessions_v2 row whose
 * (git_url, git_branch) matches the PR's head repo + head ref.
 *
 * Errors are caught and logged — this must not block the existing
 * code-review side-effect on the same webhook.
 */
export async function upsertCliSessionPullRequestsFromWebhook(
  payload: PullRequestPayload
): Promise<number> {
  const { action, pull_request, repository } = payload;

  if (!UPSERT_ACTIONS.has(action)) return 0;

  const branch = pull_request.head.ref;
  if (!branch) return 0;

  const rawUrls = deriveHeadRepoUrls(pull_request);
  if (rawUrls.length === 0) {
    // Cross-fork PR with a null head.repo — skip per v1 out-of-scope note.
    return 0;
  }
  const normalizedUrl = normalizeGitUrl(rawUrls[0]);

  const prUrl = pull_request.html_url;
  if (!prUrl) return 0;

  try {
    const sessionIds = await findMatchingSessionIds({ rawUrls, normalizedUrl, branch });

    if (sessionIds.length === 0) {
      logExceptInTest('pull_request upsert: no matching sessions', {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch,
        sessions_updated: 0,
      });
      return 0;
    }

    const state = derivePrState(pull_request, action);
    const now = sql`now()`;

    const values = sessionIds.map(session_id => ({
      session_id,
      pr_url: prUrl,
      pr_number: pull_request.number,
      pr_state: state,
      pr_title: pull_request.title,
      pr_head_sha: pull_request.head.sha,
    }));

    // Defense-in-depth against out-of-order webhook deliveries: once a PR has
    // reached a terminal state (`closed`/`merged`) we never demote it back to
    // `open` via a stale `opened`/`synchronize`/`edited` redelivery. Webhook
    // deduplication (by x-github-delivery) already blocks exact replays, but
    // GitHub can redeliver older events after a later terminal event; this
    // guarantees `pr_state` is monotonic for those actions.
    //
    // `reopened` is explicitly exempt: a closed, unmerged PR can legitimately
    // be reopened, and the guard must allow `closed` -> `open` in that case.
    // (Merged PRs cannot be reopened on GitHub, so `merged` -> `open` stays
    // impossible regardless.)
    const prStateSet =
      action === GITHUB_ACTION.REOPENED
        ? sql`excluded.pr_state`
        : sql`CASE
            WHEN ${cli_session_pull_requests.pr_state} IN ('closed', 'merged')
              AND excluded.pr_state = 'open'
            THEN ${cli_session_pull_requests.pr_state}
            ELSE excluded.pr_state
          END`;

    await db
      .insert(cli_session_pull_requests)
      .values(values)
      .onConflictDoUpdate({
        target: cli_session_pull_requests.session_id,
        set: {
          pr_url: sql`excluded.pr_url`,
          pr_number: sql`excluded.pr_number`,
          pr_state: prStateSet,
          pr_title: sql`excluded.pr_title`,
          pr_head_sha: sql`excluded.pr_head_sha`,
          pr_last_synced_at: now,
          updated_at: now,
        },
      });

    logExceptInTest('pull_request upsert: sessions updated', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch,
      sessions_updated: sessionIds.length,
    });

    return sessionIds.length;
  } catch (error) {
    logExceptInTest('pull_request upsert: failed', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { source: 'pull_request_webhook_upsert_cli_sessions' },
      extra: {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch,
      },
    });
    return 0;
  }
}
