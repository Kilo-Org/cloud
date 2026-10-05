import { and, eq, isNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { github_branch_pull_requests } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { parseRepoReference } from '@/lib/integrations/platforms/github/pr-link-identity';
import type { PullRequestReviewPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  markSessionsVerifyingPullRequest,
  type WebhookInstallationOwner,
} from './upsert-cli-session-pull-requests';

/**
 * Side-effect: when a pull_request_review webhook arrives and at least one
 * cli_sessions_v2 row verifiably links this PR (same repo, same PR number, plus
 * the session's own head evidence), flip `review_decision_pending = true` on the
 * existing `github_branch_pull_requests` cache row keyed by PR identity
 * `(git_url, PR number, tenant)`.
 *
 * UPDATE-only (no INSERT): avoids writing a half-formed PR row from a review
 * event. The `pull_request` event is canonical for the other PR fields.
 *
 * The review decision is NOT fetched here. The background batch in
 * `batch-review-decisions.ts` picks it up on the next user-facing read.
 *
 * Returns 0 when no row is updated (no verifying session or no cache row yet).
 */
export async function upsertCliSessionPullRequestReviewFromWebhook(
  payload: PullRequestReviewPayload,
  owner: WebhookInstallationOwner
): Promise<number> {
  const { pull_request, repository } = payload;

  const branch = pull_request.head.ref;
  if (!branch) return 0;

  const headRepo = pull_request.head.repo;
  if (!headRepo?.clone_url) {
    // Cross-fork PR — skip.
    return 0;
  }

  // Only a PR whose base and head repositories are the same repository can be
  // a session's own PR.
  const baseRepoRef = parseRepoReference(repository.full_name);
  const headRepoRef = parseRepoReference(headRepo.clone_url);
  if (!baseRepoRef || !headRepoRef || baseRepoRef.key !== headRepoRef.key) {
    return 0;
  }

  const gitUrl = baseRepoRef.url;

  try {
    const gateResult = await markSessionsVerifyingPullRequest(
      {
        gitUrl,
        prNumber: pull_request.number,
        headRef: branch,
        headSha: pull_request.head.sha ?? null,
      },
      owner
    );

    if (gateResult.kind === 'no_session') {
      logExceptInTest('pull_request_review upsert: no verifying session, skipping', {
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch,
        owner_kind: owner.kind,
      });
      return 0;
    }

    const tenantPredicate =
      owner.kind === 'organization'
        ? and(
            eq(github_branch_pull_requests.owned_by_organization_id, owner.organizationId),
            isNull(github_branch_pull_requests.owned_by_user_id)
          )
        : and(
            isNull(github_branch_pull_requests.owned_by_organization_id),
            eq(github_branch_pull_requests.owned_by_user_id, owner.userId)
          );

    const result = await db
      .update(github_branch_pull_requests)
      .set({
        review_decision_pending: true,
        pr_last_synced_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(github_branch_pull_requests.git_url, gitUrl),
          eq(github_branch_pull_requests.pr_number, pull_request.number),
          tenantPredicate
        )
      )
      .returning({ git_url: github_branch_pull_requests.git_url });

    const rowsAffected = result.length;

    logExceptInTest('pull_request_review upsert: cache row flagged pending', {
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch,
      owner_kind: owner.kind,
      rowsAffected,
    });

    return rowsAffected;
  } catch (error) {
    logExceptInTest('pull_request_review upsert: failed', {
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error, {
      tags: { source: 'pull_request_review_webhook_upsert_cli_sessions' },
      extra: {
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch,
      },
    });
    return 0;
  }
}
