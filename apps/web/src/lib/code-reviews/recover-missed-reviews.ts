/**
 * Recovery for a code review that never started.
 *
 * A review starts from a pull request webhook. When GitHub does not deliver that
 * event, the pull request keeps no review and no check run, and nothing else
 * revisits it. This sweep reads the most recently updated open pull requests of
 * a bounded slice of installed repositories and hands each pull request without
 * a review for its head to the handler the webhook uses, so every eligibility
 * rule (draft, bot author, repository selection, agent config, council, existing
 * review) applies unchanged.
 *
 * The slice rotates over all installed repositories with the clock, so every
 * repository is reached across successive runs without keeping a cursor.
 */

import pLimit from 'p-limit';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations, type PlatformIntegration } from '@kilocode/db/schema';
import {
  fetchOpenPullRequests,
  type OpenPullRequest,
} from '@/lib/integrations/platforms/github/adapter';
import { platformIntegrationHealthSql } from '@/lib/integrations/core/health';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import {
  findActiveReviewsForPR,
  findExistingReview,
  type ReviewScope,
} from '@/lib/code-reviews/db/code-reviews';
import {
  PullRequestPayloadSchema,
  type PullRequestPayload,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import { handlePullRequestCodeReview } from '@/lib/integrations/platforms/github/webhook-handlers/pull-request-handler';
import type { Owner } from '@/lib/code-reviews/core';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** Repositories one run may inspect. Each costs one list request. */
export const RECOVER_MISSED_REVIEWS_REPO_LIMIT = 40;

/** Pull requests read per repository, most recently updated first. */
export const RECOVER_MISSED_REVIEWS_PR_LIMIT = 20;

/** A pull request whose last update is older than this is outside the sweep. */
export const RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS = 24;

/** Reviews one run may start, so a backlog drains over several runs. */
export const RECOVER_MISSED_REVIEWS_START_LIMIT = 10;

/** Minutes between runs of the cron that calls this sweep. */
const RECOVER_MISSED_REVIEWS_INTERVAL_MINUTES = 15;

const RECOVER_CONCURRENCY = 4;

export type RecoverMissedReviewsSummary = {
  repositoriesConsidered: number;
  integrationsUnavailable: number;
  pullRequestsConsidered: number;
  reviewsStarted: number;
  skippedExisting: number;
  skippedActiveReview: number;
  skippedWithoutRepositoryId: number;
  skippedStale: number;
  skippedDraft: number;
  skippedWithoutOwner: number;
  skippedStartLimit: number;
  refusedByHandler: number;
  providerFailures: number;
};

/** One installed repository with the integration that owns its installation. */
type RecoverableRepository = {
  integration: PlatformIntegration;
  fullName: string;
  ownerLogin: string;
  repoName: string;
};

type RecoveryRun = {
  cutoffMs: number;
  summary: RecoverMissedReviewsSummary;
};

function summaryWith(counts: Partial<RecoverMissedReviewsSummary>): RecoverMissedReviewsSummary {
  return {
    repositoriesConsidered: 0,
    integrationsUnavailable: 0,
    pullRequestsConsidered: 0,
    reviewsStarted: 0,
    skippedExisting: 0,
    skippedActiveReview: 0,
    skippedWithoutRepositoryId: 0,
    skippedStale: 0,
    skippedDraft: 0,
    skippedWithoutOwner: 0,
    skippedStartLimit: 0,
    refusedByHandler: 0,
    providerFailures: 0,
    ...counts,
  };
}

/** Every installed repository of one integration, in a stable order. */
function repositoriesOf(integration: PlatformIntegration): RecoverableRepository[] {
  return (integration.repositories ?? [])
    .map(repository => {
      const [ownerLogin, repoName] = repository.full_name.split('/');
      if (ownerLogin === undefined || repoName === undefined || repoName === '') return null;
      // The payload needs the platform's numeric repository id; a GitHub
      // installation stores it as a number.
      if (typeof repository.id !== 'number') return null;
      return { integration, fullName: repository.full_name, ownerLogin, repoName };
    })
    .filter((entry): entry is RecoverableRepository => entry !== null)
    .sort(
      (left, right) =>
        left.fullName.localeCompare(right.fullName) ||
        left.integration.id.localeCompare(right.integration.id)
    );
}

/**
 * Two association rows can reach one installation (a retained row for history
 * beside a healthy sibling). Deduplication keeps one sweep per repository, so
 * a repository is never handed to the handler twice in one run.
 */
function dedupeRepositories(repositories: RecoverableRepository[]): RecoverableRepository[] {
  const seen = new Map<string, RecoverableRepository>();
  for (const entry of repositories) {
    seen.set(`${entry.integration.id}:${entry.fullName}`, entry);
  }
  return [...seen.values()];
}

/**
 * The repositories this run inspects: the first `RECOVER_MISSED_REVIEWS_REPO_LIMIT`
 * entries of a list rotated by the run interval, so one run keeps a fixed cost
 * and successive runs move the window across every installed repository.
 */
function selectRepositoryWindow(
  repositories: RecoverableRepository[],
  now: Date
): RecoverableRepository[] {
  if (repositories.length <= RECOVER_MISSED_REVIEWS_REPO_LIMIT) return repositories;
  const intervalMs = RECOVER_MISSED_REVIEWS_INTERVAL_MINUTES * 60 * 1000;
  const windows = Math.ceil(repositories.length / RECOVER_MISSED_REVIEWS_REPO_LIMIT);
  const start =
    (Math.floor(now.getTime() / intervalMs) % windows) * RECOVER_MISSED_REVIEWS_REPO_LIMIT;
  return repositories.slice(start, start + RECOVER_MISSED_REVIEWS_REPO_LIMIT);
}

/**
 * A repository renamed on GitHub keeps the integration row's old full name, and
 * the sweep's stored segments then read as a false mismatch that would bill a
 * request whose PR list returns nothing. Re-read the name once from the PR
 * response and skip the entry when it does not resolve to the same repository.
 */
function isKnownRepositoryName(pulls: OpenPullRequest[], entry: RecoverableRepository): boolean {
  const reported = pulls.find(pull => pull.baseRepoFullName !== null);
  if (reported === undefined) return true; // No pull request to verify against.
  const [ownerLogin, repoName] = reported.baseRepoFullName.split('/');
  if (ownerLogin === undefined || repoName === undefined) return false;
  return ownerLogin === entry.ownerLogin && repoName === entry.repoName;
}

async function resolveReviewOwner(integration: PlatformIntegration): Promise<Owner | null> {
  if (integration.owned_by_organization_id) {
    const botUserId = await getBotUserId(integration.owned_by_organization_id, 'code-review');
    if (botUserId === null) return null;
    return { type: 'org', id: integration.owned_by_organization_id, userId: botUserId };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id, userId: integration.owned_by_user_id };
  }
  return null;
}

/**
 * The webhook payload shape for a pull request read from the API, so recovery
 * runs through the webhook handler unchanged.
 */
function toPullRequestPayload(
  pull: OpenPullRequest,
  entry: RecoverableRepository,
  installationId: number
): PullRequestPayload {
  return PullRequestPayloadSchema.parse({
    action: 'opened',
    pull_request: {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      draft: pull.draft,
      html_url: pull.htmlUrl,
      created_at: pull.createdAt,
      user: {
        id: pull.authorId,
        login: pull.authorLogin,
        avatar_url: pull.authorAvatarUrl,
        type: pull.authorType,
      },
      labels: pull.labels.map(name => ({ name })),
      head: {
        sha: pull.headSha,
        ref: pull.headRef,
        repo:
          pull.headRepoFullName === null
            ? null
            : {
                full_name: pull.headRepoFullName,
                ...(pull.headRepoCloneUrl === null ? {} : { clone_url: pull.headRepoCloneUrl }),
                ...(pull.headRepoHtmlUrl === null ? {} : { html_url: pull.headRepoHtmlUrl }),
              },
      },
      base: { sha: pull.baseSha, ref: pull.baseRef },
    },
    repository: {
      id: pull.baseRepoId,
      name: pull.baseRepoName || entry.repoName,
      full_name: pull.baseRepoFullName || entry.fullName,
      owner: { login: entry.ownerLogin },
    },
    installation: { id: installationId },
  });
}

async function recoverPullRequest(params: {
  pull: OpenPullRequest;
  entry: RecoverableRepository;
  owner: Owner;
  installationId: number;
  run: RecoveryRun;
}): Promise<void> {
  const { pull, entry, owner, installationId, run } = params;
  const { summary } = run;
  summary.pullRequestsConsidered += 1;

  if (pull.draft) {
    summary.skippedDraft += 1;
    return;
  }
  if (Date.parse(pull.updatedAt) < run.cutoffMs) {
    summary.skippedStale += 1;
    return;
  }

  const scope: ReviewScope = {
    owner,
    platform: 'github',
    repoFullName: entry.fullName,
    prNumber: pull.number,
    platformIntegrationId: entry.integration.id,
  };

  if ((await findExistingReview(scope, pull.headSha)) !== null) {
    summary.skippedExisting += 1;
    return;
  }
  // A review still in flight at an earlier head must not be superseded by a
  // synthetic opened event; the webhook path reaches this handler only through
  // the merge-commit and supersession logic that guards that case.
  const activeReviews = await findActiveReviewsForPR(scope, pull.headSha);
  if (activeReviews.length > 0) {
    summary.skippedActiveReview += 1;
    return;
  }
  if (summary.reviewsStarted >= RECOVER_MISSED_REVIEWS_START_LIMIT) {
    summary.skippedStartLimit += 1;
    return;
  }

  const response = await handlePullRequestCodeReview(
    toPullRequestPayload(pull, entry, installationId),
    entry.integration
  );

  // The handler answers either way: a started review carries its review id in
  // the message body, and one of its skip rules answers without one.
  const body = (await response.json()) as { reviewId?: unknown };
  if (typeof body.reviewId === 'string') {
    summary.reviewsStarted += 1;
    return;
  }
  summary.refusedByHandler += 1;
}

async function recoverRepository(
  entry: RecoverableRepository,
  owner: Owner,
  installationId: number,
  run: RecoveryRun
): Promise<void> {
  const { integration } = entry;

  // The selected association owns the delivery: installation-wide authorization
  // must never carry a different association's identity, as on the webhook path.
  try {
    await assertGitHubInstallationRuntimeAuthorized(
      String(installationId),
      integration.github_app_type ?? 'standard',
      integration.id
    );
  } catch (error) {
    if (error instanceof GitHubRuntimeAuthorizationError) {
      run.summary.integrationsUnavailable += 1;
      return;
    }
    throw error;
  }

  const pulls = await fetchOpenPullRequests({
    installationId: String(installationId),
    owner: entry.ownerLogin,
    repo: entry.repoName,
    limit: RECOVER_MISSED_REVIEWS_PR_LIMIT,
    appType: integration.github_app_type ?? 'standard',
  });

  if (!isKnownRepositoryName(pulls, entry)) {
    warnExceptInTest('[recoverMissedReviews] Installed repository renamed on GitHub', {
      integrationId: integration.id,
      repository: entry.fullName,
    });
    return;
  }

  for (const pull of pulls) {
    try {
      await recoverPullRequest({ pull, entry, owner, installationId, run });
    } catch (error) {
      run.summary.providerFailures += 1;
      captureException(error, {
        tags: { operation: 'recoverMissedReviews' },
        extra: {
          integrationId: integration.id,
          repository: entry.fullName,
          pullRequest: pull.number,
        },
      });
      logExceptInTest('[recoverMissedReviews] Pull request sweep failed:', {
        integrationId: integration.id,
        repository: entry.fullName,
        pullRequest: pull.number,
      });
    }
  }
}

/**
 * Recover reviews whose pull request event never reached the webhook.
 *
 * An unhealthy integration, a missing review owner, or a runtime that has not
 * authorized the installation is skipped, exactly as a webhook delivery is. A
 * failure reading one repository, or on one pull request, is reported to Sentry
 * and does not stop the rest of the sweep.
 */
export async function recoverMissedReviews(
  options: { now?: Date } = {}
): Promise<RecoverMissedReviewsSummary> {
  const summary = summaryWith({});
  const now = options.now ?? new Date();
  const run: RecoveryRun = {
    cutoffMs: now.getTime() - RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS * 60 * 60 * 1000,
    summary,
  };

  const rows = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        sql`(${platformIntegrationHealthSql()})`,
        isNotNull(platform_integrations.platform_installation_id),
        isNotNull(platform_integrations.repositories)
      )
    )
    .orderBy(asc(platform_integrations.id));

  const repositories = selectRepositoryWindow(
    dedupeRepositories(rows.flatMap(integration => repositoriesOf(integration))),
    now
  );
  summary.repositoriesConsidered = repositories.length;

  const limit = pLimit(RECOVER_CONCURRENCY);
  await Promise.all(
    repositories.map(entry =>
      limit(async () => {
        try {
          const owner = await resolveReviewOwner(entry.integration);
          if (owner === null) {
            summary.skippedWithoutOwner += 1;
            return;
          }
          const installationId = Number(entry.integration.platform_installation_id);
          if (!Number.isInteger(installationId) || installationId <= 0) {
            summary.integrationsUnavailable += 1;
            warnExceptInTest('[recoverMissedReviews] Unusable installation', {
              integrationId: entry.integration.id,
            });
            return;
          }
          await recoverRepository(entry, owner, installationId, run);
        } catch (error) {
          summary.providerFailures += 1;
          captureException(error, {
            tags: { operation: 'recoverMissedReviews' },
            extra: { integrationId: entry.integration.id, repository: entry.fullName },
          });
          logExceptInTest('[recoverMissedReviews] Repository sweep failed:', {
            integrationId: entry.integration.id,
            repository: entry.fullName,
          });
        }
      })
    )
  );

  return summary;
}
