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
 * repository is reached across successive runs without keeping a cursor. The
 * database selects the slice, so one run transfers a bounded number of rows
 * however large the installation fleet is.
 *
 * The synthesized event replays `synchronize` rather than `opened`, because the
 * sweep cannot know which delivery it missed and `synchronize` is the stricter
 * of the two: it also runs the handler's merge-head guard, so a head that
 * merges base content a review already covers is gated from that review instead
 * of being reviewed a second time.
 */

import * as z from 'zod';
import pLimit from 'p-limit';
import { inArray, sql, type SQL } from 'drizzle-orm';
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
import { PLATFORM, GITHUB_ACTION } from '@/lib/integrations/core/constants';
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

/** Repository sweeps one run runs at once. */
export const RECOVER_CONCURRENCY = 4;

export type RecoverMissedReviewsSummary = {
  repositoriesConsidered: number;
  integrationsUnavailable: number;
  pullRequestsConsidered: number;
  reviewsStarted: number;
  skippedExisting: number;
  skippedActiveReview: number;
  /**
   * Installed repository entries the sweep cannot address, because the payload
   * needs a numeric platform id. Counted across the installation fleet, so it
   * reports a standing gap rather than one run's work.
   */
  unaddressableRepositories: number;
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
    unaddressableRepositories: 0,
    skippedStale: 0,
    skippedDraft: 0,
    skippedWithoutOwner: 0,
    skippedStartLimit: 0,
    refusedByHandler: 0,
    providerFailures: 0,
    ...counts,
  };
}

/**
 * Every installed repository of a healthy GitHub integration, expanded in the
 * database. The sweep never loads the fleet into memory: only the selected
 * slice crosses the wire.
 */
function installedRepositoriesSql(): SQL {
  return sql`
    FROM ${platform_integrations}
    CROSS JOIN LATERAL jsonb_array_elements(${platform_integrations.repositories}) AS entry(repository)
    WHERE ${platform_integrations.platform} = ${PLATFORM.GITHUB}
      AND (${platformIntegrationHealthSql()})
      AND ${platform_integrations.platform_installation_id} IS NOT NULL
      AND jsonb_typeof(${platform_integrations.repositories}) = 'array'
  `;
}

/**
 * A stored repository entry the payload can name: the review payload carries the
 * platform's numeric repository id, and the owner and name split on one slash.
 * A GitHub installation stores a number; anything else cannot be reviewed.
 *
 * An entry without a string name makes a comparison answer NULL rather than
 * false, so every count wraps the predicate in COALESCE and the entry lands in
 * the unaddressable bucket.
 */
function addressableRepositorySql(): SQL {
  return sql`
    jsonb_typeof(repository->'id') = 'number'
    AND split_part(repository->>'full_name', '/', 1) <> ''
    AND split_part(repository->>'full_name', '/', 2) <> ''
  `;
}

const installedRepositoriesCountSchema = z.object({
  addressable: z.number(),
  unaddressable: z.number(),
});

const repositorySliceRowSchema = z.object({
  integration_id: z.string(),
  full_name: z.string(),
});

/**
 * The slice this run inspects, as an offset into the ordered installed
 * repositories. Successive runs step by one slice, so every repository is swept
 * within `ceil(total / slice)` runs.
 */
export function recoverMissedReviewsSliceOffset(installedRepositories: number, now: Date): number {
  if (installedRepositories <= RECOVER_MISSED_REVIEWS_REPO_LIMIT) return 0;
  const intervalMs = RECOVER_MISSED_REVIEWS_INTERVAL_MINUTES * 60 * 1000;
  const slices = Math.ceil(installedRepositories / RECOVER_MISSED_REVIEWS_REPO_LIMIT);
  return (Math.floor(now.getTime() / intervalMs) % slices) * RECOVER_MISSED_REVIEWS_REPO_LIMIT;
}

/** The installed repositories of the slice that starts at `offset`. */
async function readRepositorySlice(
  offset: number
): Promise<Array<{ integrationId: string; fullName: string }>> {
  const result = await db.execute(sql`
    SELECT
      ${platform_integrations.id} AS integration_id,
      repository->>'full_name' AS full_name
    ${installedRepositoriesSql()}
      AND ${addressableRepositorySql()}
    ORDER BY full_name, integration_id
    LIMIT ${RECOVER_MISSED_REVIEWS_REPO_LIMIT}
    OFFSET ${offset}
  `);
  const rows = z.array(repositorySliceRowSchema).parse(result.rows);
  return rows.map(row => ({ integrationId: row.integration_id, fullName: row.full_name }));
}

/** How many installed repositories there are, and how many cannot be addressed. */
async function countInstalledRepositories(): Promise<
  z.infer<typeof installedRepositoriesCountSchema>
> {
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE COALESCE(${addressableRepositorySql()}, false))::int AS addressable,
      count(*) FILTER (WHERE NOT COALESCE(${addressableRepositorySql()}, false))::int
        AS unaddressable
    ${installedRepositoriesSql()}
  `);
  return installedRepositoriesCountSchema.parse(result.rows[0]);
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

/** Joins the selected slice to the integration rows the handler needs. */
function repositoriesFromSlice(
  slice: Array<{ integrationId: string; fullName: string }>,
  integrations: PlatformIntegration[]
): RecoverableRepository[] {
  const byId = new Map(integrations.map(integration => [integration.id, integration]));
  const repositories: RecoverableRepository[] = [];
  for (const row of slice) {
    const integration = byId.get(row.integrationId);
    // The integration row can change between the two reads; a removed one is
    // swept by a later run.
    if (integration === undefined) continue;
    const [ownerLogin, repoName] = row.fullName.split('/');
    if (ownerLogin === undefined || ownerLogin === '') continue;
    if (repoName === undefined || repoName === '') continue;
    repositories.push({ integration, fullName: row.fullName, ownerLogin, repoName });
  }
  return dedupeRepositories(repositories);
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
    // The webhook handler runs the review for the requester when the org has no
    // bot user yet; recovery must name the same owner or the integration's
    // already-missed reviews stay missed.
    const userId = botUserId ?? integration.kilo_requester_user_id ?? null;
    if (userId === null || userId === '') return null;
    return { type: 'org', id: integration.owned_by_organization_id, userId };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id, userId: integration.owned_by_user_id };
  }
  return null;
}

/**
 * The per-integration prerequisites of a sweep: the review owner, a usable
 * installation id, and an authorized association. An integration with many
 * repositories in one slice repeats none of these lookups.
 */
type IntegrationReadiness =
  | { status: 'ready'; owner: Owner; installationId: number }
  | { status: 'without_owner' }
  | { status: 'unusable_installation' }
  | { status: 'unauthorized' }
  | { status: 'failed'; error: unknown };

async function readIntegrationReadiness(
  integration: PlatformIntegration
): Promise<IntegrationReadiness> {
  try {
    const owner = await resolveReviewOwner(integration);
    if (owner === null) return { status: 'without_owner' };

    const installationId = Number(integration.platform_installation_id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      warnExceptInTest('[recoverMissedReviews] Unusable installation', {
        integrationId: integration.id,
      });
      return { status: 'unusable_installation' };
    }

    // The selected association owns the delivery: installation-wide
    // authorization must never carry a different association's identity, as on
    // the webhook path.
    await assertGitHubInstallationRuntimeAuthorized(
      String(installationId),
      integration.github_app_type ?? 'standard',
      integration.id
    );
    return { status: 'ready', owner, installationId };
  } catch (error) {
    if (error instanceof GitHubRuntimeAuthorizationError) return { status: 'unauthorized' };
    return { status: 'failed', error };
  }
}

type PlannedRepository = { entry: RecoverableRepository; readiness: IntegrationReadiness };

/** Resolves the shared prerequisites once per integration of the slice. */
async function planRepositories(
  repositories: RecoverableRepository[]
): Promise<PlannedRepository[]> {
  const integrations = new Map<string, PlatformIntegration>();
  for (const entry of repositories) {
    integrations.set(entry.integration.id, entry.integration);
  }
  const limit = pLimit(RECOVER_CONCURRENCY);
  const readiness = new Map(
    await Promise.all(
      [...integrations].map(([integrationId, integration]) =>
        limit(async () => [integrationId, await readIntegrationReadiness(integration)] as const)
      )
    )
  );

  const planned: PlannedRepository[] = [];
  for (const entry of repositories) {
    const resolved = readiness.get(entry.integration.id);
    if (resolved === undefined) continue;
    planned.push({ entry, readiness: resolved });
  }
  return planned;
}

function reportRepositoryFailure(
  entry: RecoverableRepository,
  error: unknown,
  summary: RecoverMissedReviewsSummary
): void {
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

/**
 * The webhook payload shape for a pull request read from the API, so recovery
 * runs through the webhook handler unchanged.
 *
 * The sweep cannot know which delivery it missed, so it replays the stricter
 * one. `synchronize` is the only action that runs the handler's merge-head
 * guard, and a recovered head that is a merge of base content a review already
 * covers must not start a second, billable review of that content.
 */
function toPullRequestPayload(
  pull: OpenPullRequest,
  entry: RecoverableRepository,
  installationId: number
): PullRequestPayload {
  return PullRequestPayloadSchema.parse({
    action: GITHUB_ACTION.SYNCHRONIZE,
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
  // synthetic synchronize event; the webhook path reaches this handler only
  // through the merge-commit and supersession logic that guards that case.
  const activeReviews = await findActiveReviewsForPR(scope, pull.headSha);
  if (activeReviews.length > 0) {
    summary.skippedActiveReview += 1;
    return;
  }
  if (summary.reviewsStarted >= RECOVER_MISSED_REVIEWS_START_LIMIT) {
    summary.skippedStartLimit += 1;
    return;
  }

  // Reserve the slot synchronously: several repositories sweep at once, and an
  // awaited handler call must not let a sibling start past the run's limit.
  summary.reviewsStarted += 1;
  let started = false;
  try {
    const response = await handlePullRequestCodeReview(
      toPullRequestPayload(pull, entry, installationId),
      entry.integration
    );
    // The handler answers 202 when it queued a review, 200 when one of its
    // skip rules declines, and 500 when it failed. A merge head whose content a
    // finished review already covers is one of the declines: the handler gates
    // that head from the covering review instead of reviewing it again.
    if (response.status === 202) {
      started = true;
      return;
    }
    if (response.status >= 500) {
      summary.providerFailures += 1;
      return;
    }
    summary.refusedByHandler += 1;
  } finally {
    if (!started) summary.reviewsStarted -= 1;
  }
}

async function recoverRepository(
  entry: RecoverableRepository,
  owner: Owner,
  installationId: number,
  run: RecoveryRun
): Promise<void> {
  const { integration } = entry;

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

  const counts = await countInstalledRepositories();
  summary.unaddressableRepositories = counts.unaddressable;

  // An empty fleet answers an empty slice, so the run always reads exactly
  // once at its bound.
  const slice = await readRepositorySlice(recoverMissedReviewsSliceOffset(counts.addressable, now));
  const integrations =
    slice.length === 0
      ? []
      : await db
          .select()
          .from(platform_integrations)
          .where(
            inArray(
              platform_integrations.id,
              slice.map(row => row.integrationId)
            )
          );
  const repositories = repositoriesFromSlice(slice, integrations);
  summary.repositoriesConsidered = repositories.length;

  const planned = await planRepositories(repositories);
  const limit = pLimit(RECOVER_CONCURRENCY);
  await Promise.all(
    planned.map(({ entry, readiness }) =>
      limit(async () => {
        if (readiness.status === 'without_owner') {
          summary.skippedWithoutOwner += 1;
          return;
        }
        if (readiness.status === 'unauthorized' || readiness.status === 'unusable_installation') {
          summary.integrationsUnavailable += 1;
          return;
        }
        if (readiness.status === 'failed') {
          reportRepositoryFailure(entry, readiness.error, summary);
          return;
        }
        try {
          await recoverRepository(entry, readiness.owner, readiness.installationId, run);
        } catch (error) {
          reportRepositoryFailure(entry, error, summary);
        }
      })
    )
  );

  return summary;
}
