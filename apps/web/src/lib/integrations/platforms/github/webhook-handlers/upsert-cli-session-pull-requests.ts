import { and, eq, isNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests } from '@kilocode/db/schema';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { normalizeGitUrl } from '@/lib/integrations/platforms/github/normalize-git-url';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { REVIEW_DECISION_SUPPORTED_PLATFORMS } from './supported-platforms';

/**
 * Identity of the GitHub installation that delivered a webhook. The cache
 * row is written under this owner so a webhook from one tenant can never
 * populate PR metadata read by another tenant.
 */
export type WebhookInstallationOwner =
  | { kind: 'organization'; organizationId: string }
  | { kind: 'user'; userId: string };

/**
 * Result of the matching-session gate check.
 * - `no_session`: no session on a supported platform found — skip the upsert entirely.
 * - `session`: at least one session on a supported platform found.
 */
export type SessionGateResult = { kind: 'no_session' } | { kind: 'session' };

const UPSERT_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.CLOSED,
]);

// Actions that can change the review decision (push auto-dismisses reviews,
// reopen reactivates the PR). Closed/edited have no review-decision impact.
const REVIEW_DECISION_PENDING_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.SYNCHRONIZE,
]);

type PrState = 'open' | 'closed' | 'merged';

function derivePrState(pr: PullRequestPayload['pull_request'], action: string): PrState {
  if (action === GITHUB_ACTION.CLOSED) {
    return pr.merged === true ? 'merged' : 'closed';
  }
  return pr.state === 'closed' ? 'closed' : 'open';
}

/**
 * Checks whether at least one `cli_sessions_v2` row on a supported platform
 * exists in this tenant for `(git_url, git_branch)`.
 */
export async function checkMatchingSession(
  gitUrl: string,
  branch: string,
  owner: WebhookInstallationOwner
): Promise<SessionGateResult> {
  const tenantPredicate =
    owner.kind === 'organization'
      ? eq(cli_sessions_v2.organization_id, owner.organizationId)
      : and(
          isNull(cli_sessions_v2.organization_id),
          eq(cli_sessions_v2.kilo_user_id, owner.userId)
        );

  const platformInList = sql.join(
    [...REVIEW_DECISION_SUPPORTED_PLATFORMS].map(p => sql`${p}`),
    sql`, `
  );

  const result = await db.execute<{ has_session: boolean }>(
    sql`
      SELECT EXISTS (
        SELECT 1 FROM cli_sessions_v2
        WHERE git_url = ${gitUrl}
          AND git_branch = ${branch}
          AND ${tenantPredicate}
          AND created_on_platform IN (${platformInList})
      ) AS has_session
    `
  );

  const row = result.rows[0];
  if (!row?.has_session) return { kind: 'no_session' };
  return { kind: 'session' };
}

/**
 * Side-effect: when a pull_request webhook arrives for one of the tracked
 * actions and at least one cli_sessions_v2 row on a supported platform in this
 * tenant references the same `(git_url, git_branch)`, upsert a single row into
 * `github_branch_pull_requests` keyed on `(normalized git_url, git_branch,
 * tenant)`. One delivery = one row written, regardless of how many sessions
 * reference the same `(repo, branch)`.
 *
 * The review decision is NOT fetched here. Instead `review_decision_pending` is
 * flipped to `true` for actions that can affect it (opened, reopened,
 * synchronize). The background batch in `batch-review-decisions.ts` picks it up
 * on the next user-facing read.
 *
 * Returns 1 when a row was written and 0 otherwise (no matching session,
 * unrelated action, missing fields, or db error).
 */
export async function upsertCliSessionPullRequestsFromWebhook(
  payload: PullRequestPayload,
  owner: WebhookInstallationOwner
): Promise<number> {
  const { action, pull_request, repository } = payload;

  if (!UPSERT_ACTIONS.has(action)) return 0;

  const branch = pull_request.head.ref;
  if (!branch) return 0;

  const headRepo = pull_request.head.repo;
  if (!headRepo?.clone_url) {
    // Cross-fork PR with a null head.repo — skip per v1 out-of-scope note.
    return 0;
  }

  const prUrl = pull_request.html_url;
  if (!prUrl) return 0;

  const gitUrl = normalizeGitUrl(headRepo.clone_url);

  try {
    const gateResult = await checkMatchingSession(gitUrl, branch, owner);
    if (gateResult.kind === 'no_session') {
      logExceptInTest('pull_request upsert: no matching session, skipping', {
        action,
        pr_number: pull_request.number,
        repo: repository.full_name,
        branch,
        owner_kind: owner.kind,
      });
      return 0;
    }

    const state = derivePrState(pull_request, action);

    // Defense-in-depth against out-of-order webhook deliveries.
    const prStateSet =
      action === GITHUB_ACTION.REOPENED
        ? sql`excluded.pr_state`
        : sql`CASE
            WHEN ${github_branch_pull_requests.pr_state} = 'merged'
              AND excluded.pr_state IN ('open', 'closed')
            THEN ${github_branch_pull_requests.pr_state}
            WHEN ${github_branch_pull_requests.pr_state} = 'closed'
              AND excluded.pr_state = 'open'
            THEN ${github_branch_pull_requests.pr_state}
            ELSE excluded.pr_state
          END`;

    // Flip review_decision_pending only for actions that can affect the
    // review decision. For closed/edited, preserve the existing flag value.
    const reviewDecisionPendingSet = REVIEW_DECISION_PENDING_ACTIONS.has(action)
      ? sql`true`
      : github_branch_pull_requests.review_decision_pending;

    const ownerValues =
      owner.kind === 'organization'
        ? { owned_by_organization_id: owner.organizationId, owned_by_user_id: null }
        : { owned_by_organization_id: null, owned_by_user_id: owner.userId };

    const conflictTarget =
      owner.kind === 'organization'
        ? [
            github_branch_pull_requests.git_url,
            github_branch_pull_requests.git_branch,
            github_branch_pull_requests.owned_by_organization_id,
          ]
        : [
            github_branch_pull_requests.git_url,
            github_branch_pull_requests.git_branch,
            github_branch_pull_requests.owned_by_user_id,
          ];

    const conflictTargetWhere =
      owner.kind === 'organization'
        ? sql`${github_branch_pull_requests.owned_by_organization_id} IS NOT NULL`
        : sql`${github_branch_pull_requests.owned_by_user_id} IS NOT NULL`;

    await db
      .insert(github_branch_pull_requests)
      .values({
        git_url: gitUrl,
        git_branch: branch,
        ...ownerValues,
        pr_url: prUrl,
        pr_number: pull_request.number,
        pr_state: state,
        pr_title: pull_request.title,
        pr_head_sha: pull_request.head.sha,
        pr_review_decision: null,
        review_decision_pending: true,
        review_decision_fetching_at: null,
      })
      .onConflictDoUpdate({
        target: conflictTarget,
        targetWhere: conflictTargetWhere,
        set: {
          pr_url: sql`excluded.pr_url`,
          pr_number: sql`excluded.pr_number`,
          pr_state: prStateSet,
          pr_title: sql`excluded.pr_title`,
          pr_head_sha: sql`excluded.pr_head_sha`,
          review_decision_pending: reviewDecisionPendingSet,
          pr_last_synced_at: sql`now()`,
          updated_at: sql`now()`,
        },
      });

    logExceptInTest('pull_request upsert: cache row written', {
      action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      branch,
      owner_kind: owner.kind,
    });

    return 1;
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
