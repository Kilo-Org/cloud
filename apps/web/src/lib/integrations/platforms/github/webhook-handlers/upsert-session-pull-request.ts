import { captureException } from '@sentry/nextjs';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  cli_session_pull_requests,
  cli_sessions_v2,
  type NewCliSessionPullRequest,
} from '@kilocode/db/schema';
import { logExceptInTest } from '@/lib/utils.server';
import type { PullRequestPayload } from '../webhook-schemas';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { normalizeGitUrl } from './normalize-git-url';

const UPSERT_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.CLOSED,
]);

/**
 * Build the set of git_url values to look up against `cli_sessions_v2`. The
 * CLI stores whatever URL the user originally passed, so we try every shape
 * GitHub gives us in the webhook (verbatim and `.git`-suffixed) plus the
 * canonical normalized form. All variants share the same `(git_url, git_branch)`
 * index lookup, so adding extra candidates is cheap.
 */
function buildGitUrlCandidates(headRepo: { clone_url?: string; html_url?: string }): string[] {
  const out = new Set<string>();
  const { clone_url, html_url } = headRepo;
  if (clone_url) {
    out.add(clone_url);
    out.add(normalizeGitUrl(clone_url));
  }
  if (html_url) {
    out.add(html_url);
    out.add(`${html_url}.git`);
    out.add(normalizeGitUrl(html_url));
  }
  return [...out];
}

/**
 * Upsert a row into `cli_session_pull_requests` for every cli_sessions_v2 row
 * whose (git_url, git_branch) matches this PR's head repo + head ref.
 *
 * Fires for `opened`, `reopened`, `edited`, `synchronize`, `closed` actions.
 * All other actions are ignored. Never throws — errors are captured so the
 * caller (webhook handler) cannot be blocked by this side-effect.
 */
export async function upsertSessionPullRequestsFromWebhook(
  payload: PullRequestPayload
): Promise<void> {
  const { action, pull_request, repository } = payload;
  if (!UPSERT_ACTIONS.has(action)) return;

  const headRepo = pull_request.head.repo;
  const headBranch = pull_request.head.ref;
  if (!headRepo || !headBranch) return;

  const prUrl = pull_request.html_url;
  if (!prUrl) return;

  const candidates = buildGitUrlCandidates(headRepo);
  if (candidates.length === 0) return;

  const prState =
    action === GITHUB_ACTION.CLOSED && pull_request.merged === true ? 'merged' : pull_request.state;

  try {
    const matchingSessions = await db
      .select({ session_id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.git_branch, headBranch),
          or(...candidates.map(url => eq(cli_sessions_v2.git_url, url)))
        )
      );

    const sessionIds = Array.from(new Set(matchingSessions.map(row => row.session_id)));

    if (sessionIds.length === 0) {
      logExceptInTest('PR webhook: no matching cli_sessions_v2', {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch: headBranch,
        sessions_updated: 0,
      });
      return;
    }

    const rows: NewCliSessionPullRequest[] = sessionIds.map(session_id => ({
      session_id,
      pr_url: prUrl,
      pr_number: pull_request.number,
      pr_state: prState,
      pr_title: pull_request.title,
      pr_head_sha: pull_request.head.sha,
    }));

    await db
      .insert(cli_session_pull_requests)
      .values(rows)
      .onConflictDoUpdate({
        target: cli_session_pull_requests.session_id,
        set: {
          pr_url: sql`excluded.pr_url`,
          pr_number: sql`excluded.pr_number`,
          pr_state: sql`excluded.pr_state`,
          pr_title: sql`excluded.pr_title`,
          pr_head_sha: sql`excluded.pr_head_sha`,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      });

    logExceptInTest('PR webhook: upserted cli_session_pull_requests', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch: headBranch,
      sessions_updated: sessionIds.length,
    });
  } catch (error) {
    logExceptInTest('PR webhook: failed to upsert cli_session_pull_requests', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch: headBranch,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { source: 'pull_request_webhook_session_upsert' },
      extra: {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch: headBranch,
      },
    });
  }
}
