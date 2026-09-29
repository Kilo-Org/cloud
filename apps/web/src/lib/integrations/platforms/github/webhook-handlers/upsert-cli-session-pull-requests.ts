import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { cli_sessions_v2, github_branch_pull_requests } from '@kilocode/db/schema';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { parseRepoReference } from '@/lib/integrations/platforms/github/pr-link-identity';
import type { PullRequestPayload } from '@/lib/integrations/platforms/github/webhook-schemas';

/**
 * Identity of the GitHub installation that delivered a webhook. The cache
 * row is written under this owner so a webhook from one tenant can never
 * populate PR metadata read by another tenant.
 */
export type WebhookInstallationOwner =
  | { kind: 'organization'; organizationId: string }
  | { kind: 'user'; userId: string };

/**
 * Result of the per-session verified gate check.
 * - `no_session`: no session verifiably links this PR — nothing is written.
 * - `session`: at least one session verifiably links this PR and was marked
 *   verified.
 */
export type SessionGateResult = { kind: 'no_session' } | { kind: 'session' };

/**
 * The evidence a pull request webhook carries about the PR it names. `gitUrl`
 * is the canonical `https://host/owner/repo` of the (same) base and head repo.
 */
export type PullRequestSessionEvidence = {
  gitUrl: string;
  prNumber: number;
  headRef: string | null;
  headSha: string | null;
};

const UPSERT_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.EDITED,
  GITHUB_ACTION.SYNCHRONIZE,
  GITHUB_ACTION.CLOSED,
  GITHUB_ACTION.READY_FOR_REVIEW,
  GITHUB_ACTION.CONVERTED_TO_DRAFT,
]);

// Actions that can change the review decision (push auto-dismisses reviews,
// reopen reactivates the PR). Closed/edited have no review-decision impact.
const REVIEW_DECISION_PENDING_ACTIONS: ReadonlySet<string> = new Set([
  GITHUB_ACTION.OPENED,
  GITHUB_ACTION.REOPENED,
  GITHUB_ACTION.SYNCHRONIZE,
]);

type PrState = 'open' | 'closed' | 'merged' | 'draft';

function derivePrState(pr: PullRequestPayload['pull_request'], action: string): PrState {
  if (action === GITHUB_ACTION.CLOSED) {
    return pr.merged === true ? 'merged' : 'closed';
  }
  if (pr.state === 'closed') return 'closed';
  return pr.draft === true ? 'draft' : 'open';
}

function tenantPredicateForOwner(owner: WebhookInstallationOwner) {
  return owner.kind === 'organization'
    ? eq(cli_sessions_v2.organization_id, owner.organizationId)
    : and(isNull(cli_sessions_v2.organization_id), eq(cli_sessions_v2.kilo_user_id, owner.userId));
}

/**
 * Per-session verified gate: mark every `cli_sessions_v2` row in the tenant
 * that verifiably links this pull request as verified, and report whether any
 * matched.
 *
 * A session verifiably links the PR only when it stored a link to the same PR
 * number on the same repository and the evidence the session itself reported
 * agrees with the payload:
 *
 *   - the stored `pr_head_sha` equals the payload head SHA, or
 *   - the session stored no head SHA (older CLI) and its `pr_head_ref` equals
 *     the payload head ref, or
 *   - the session stored neither head field (pre-headRef CLI) and its
 *     `git_branch` equals the payload head ref.
 *
 * A branch name (with repo and tenant) is never on its own enough: a PR opened
 * by someone else on a reused branch name does not carry this session's PR
 * number and does not match.
 *
 * Verification is platform-agnostic. Every surface that shows a session (web
 * session list/detail, mobile Agents list, extension side panel, the CLI) must
 * be able to have the session's own reported PR verified, so
 * `created_on_platform` is not part of the gate. A cloud-agent-only gate left
 * `cli`/`vscode`/`agent-manager` sessions unverifiable, and because the only
 * manual recovery (the hover-card refresh) requires an already-verified link,
 * those sessions could never display their own PR.
 */
export async function markSessionsVerifyingPullRequest(
  evidence: PullRequestSessionEvidence,
  owner: WebhookInstallationOwner
): Promise<SessionGateResult> {
  const payloadHeadSha = evidence.headSha ? evidence.headSha.trim().toLowerCase() : null;
  const payloadHeadRef = evidence.headRef;

  // `(stored head SHA = payload head SHA) OR (stored head SHA absent AND
  // stored head ref = payload head ref) OR (both head fields absent AND the
  // session branch = payload head ref)`. The last disjunct is the fallback for
  // a legacy CLI that reported a link before the head fields existed: it still
  // requires the session's own PR number and repo to match above, and its
  // branch to be the ref the webhook names, so branch alone is never enough.
  const headEvidence = or(
    payloadHeadSha ? sql`lower(${cli_sessions_v2.pr_head_sha}) = ${payloadHeadSha}` : sql`false`,
    payloadHeadRef !== null
      ? and(isNull(cli_sessions_v2.pr_head_sha), eq(cli_sessions_v2.pr_head_ref, payloadHeadRef))
      : sql`false`,
    payloadHeadRef !== null
      ? and(
          isNull(cli_sessions_v2.pr_head_sha),
          isNull(cli_sessions_v2.pr_head_ref),
          eq(cli_sessions_v2.git_branch, payloadHeadRef)
        )
      : sql`false`
  );

  const marked = await db
    .update(cli_sessions_v2)
    .set({ pr_link_verified_at: sql`now()` })
    .where(
      and(
        eq(cli_sessions_v2.git_url, evidence.gitUrl),
        eq(cli_sessions_v2.pr_number, evidence.prNumber),
        isNotNull(cli_sessions_v2.pr_url),
        tenantPredicateForOwner(owner),
        headEvidence
      )
    )
    .returning({ session_id: cli_sessions_v2.session_id });

  return marked.length > 0 ? { kind: 'session' } : { kind: 'no_session' };
}

/**
 * Side-effect: when a pull_request webhook arrives for one of the tracked
 * actions, a session that verifiably links the PR is marked verified and the
 * `github_branch_pull_requests` state/review cache row is upserted keyed on PR
 * identity `(normalized git_url, PR number, tenant)`.
 *
 * The cache is never the source of the link: it only carries the state and
 * review decision for a PR a session already verifiably links. A branch name
 * is not identity — a reused branch name opened by someone else must never
 * populate or overwrite the row.
 *
 * The review decision is NOT fetched here. Instead `review_decision_pending` is
 * flipped to `true` for actions that can affect it (opened, reopened,
 * synchronize). The background batch in `batch-review-decisions.ts` picks it up
 * on the next user-facing read.
 *
 * Returns 1 when a row was written and 0 otherwise (no session verifiably
 * links the PR, unrelated action, missing fields, fork/other-repo PR, or db
 * error).
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
    // Cross-fork PR with a null head.repo — skip.
    return 0;
  }

  // Only a PR whose base and head repositories are the same repository can be
  // a session's own PR. A fork or another repo that happens to share the
  // branch name is never a match.
  const baseRepoRef = parseRepoReference(repository.full_name);
  const headRepoRef = parseRepoReference(headRepo.clone_url);
  if (!baseRepoRef || !headRepoRef || baseRepoRef.key !== headRepoRef.key) {
    logExceptInTest('pull_request upsert: base and head repos differ, skipping', {
      action,
      pr_number: pull_request.number,
      base_repo: repository.full_name,
      head_repo: headRepo.full_name,
      owner_kind: owner.kind,
    });
    return 0;
  }

  const prUrl = pull_request.html_url;
  if (!prUrl) return 0;

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
      logExceptInTest('pull_request upsert: no session verifiably links this PR, skipping', {
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
    //
    // `closed` must not be permanently sticky: if the `reopened` webhook that
    // should have flipped it back to open is missed or deduplicated, a later
    // `synchronize` delivery carrying a new head sha (i.e. new commits were
    // actually pushed, which can only happen on a PR that is really open) is
    // used to self-heal pr_state instead of trusting only the `reopened`
    // action name. A `synchronize` redelivery with the *same* head sha is
    // treated as a stale/duplicate event and does not heal the state.
    const closedStaysStickyUnlessNewCommit =
      action === GITHUB_ACTION.SYNCHRONIZE
        ? sql`AND ${github_branch_pull_requests.pr_head_sha} = excluded.pr_head_sha`
        : sql``;

    const prStateSet =
      action === GITHUB_ACTION.REOPENED
        ? sql`excluded.pr_state`
        : sql`CASE
            WHEN ${github_branch_pull_requests.pr_number} = excluded.pr_number
              AND ${github_branch_pull_requests.pr_state} = 'merged'
              AND excluded.pr_state IN ('open', 'closed', 'draft')
            THEN ${github_branch_pull_requests.pr_state}
            WHEN ${github_branch_pull_requests.pr_number} = excluded.pr_number
              AND ${github_branch_pull_requests.pr_state} = 'closed'
              AND excluded.pr_state IN ('open', 'draft')
              ${closedStaysStickyUnlessNewCommit}
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

    // Identity is the PR, never the branch: the partial unique indexes are
    // keyed on `(git_url, pr_number, owner)`.
    const conflictTarget =
      owner.kind === 'organization'
        ? [
            github_branch_pull_requests.git_url,
            github_branch_pull_requests.pr_number,
            github_branch_pull_requests.owned_by_organization_id,
          ]
        : [
            github_branch_pull_requests.git_url,
            github_branch_pull_requests.pr_number,
            github_branch_pull_requests.owned_by_user_id,
          ];

    const conflictTargetWhere = sql`${github_branch_pull_requests.pr_number} IS NOT NULL`;

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
          git_branch: sql`excluded.git_branch`,
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
