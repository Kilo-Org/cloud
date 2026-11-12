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
 *
 * A head that already has a review stopped on a transient failure is restarted
 * through the same sequence the manual retry uses, under an attempt cap. The
 * restart reapplies the reviewer configuration and the repository, bot and
 * review-type rules the handler would apply to a new head, because it reaches
 * no handler itself.
 */

import * as z from 'zod';
import pLimit from 'p-limit';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  platform_integrations,
  type CloudAgentCodeReview,
  type PlatformIntegration,
} from '@kilocode/db/schema';
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
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { isCouncilEntitledForOwner } from '@/lib/code-reviews/core/council-entitlement';
import { getManualCodeReviewConfig } from '@/lib/code-reviews/manual-config';
import {
  findActiveReviewsForPR,
  findExistingReview,
  listCodeReviewAttempts,
  type ReviewScope,
} from '@/lib/code-reviews/db/code-reviews';
import {
  isAutomaticallyRetryableFailure,
  isAutomaticallyRetryableReview,
  retryFailedCodeReview,
  type ReviewerConfigRow,
} from './retry-review';
import {
  determineAutomatedReviewType,
  isCouncilActive,
  type AutomatedReviewPrFacts,
} from '@kilocode/worker-utils/code-review-council';
import { CodeReviewAgentConfigSchema } from '@kilocode/db/schema-types';
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
  /**
   * New reviews this run queued. A restart is reported in `reviewsRetried`
   * instead, so a reader of this counter still counts first reviews only.
   */
  reviewsStarted: number;
  /** Failed reviews reset and handed back to dispatch by this run. */
  reviewsRetried: number;
  /**
   * Failed reviews this run left alone because their unattended attempts are
   * spent. Each one needs a person to restart it, so the count is the sweep's
   * escalation signal rather than another skip.
   */
  retriesExhausted: number;
  skippedExisting: number;
  skippedActiveReview: number;
  /** Failed reviews the reviewer configuration does not let a restart run. */
  skippedRetryRefused: number;
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
    reviewsRetried: 0,
    retriesExhausted: 0,
    skippedExisting: 0,
    skippedActiveReview: 0,
    skippedRetryRefused: 0,
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

/** The optional part of a stored configuration the restart gate reads. */
const RestartConfigSchema = CodeReviewAgentConfigSchema.partial();

/** Why a restart does not run under the owner's current configuration. */
type RestartRefusalReason =
  /** No readable configuration, so no restart runs unattended. */
  | 'config_unreadable'
  /** The owner removed this repository from the selected set. */
  | 'repository_not_selected'
  /** The owner asks the sweep to skip bot-authored pull requests. */
  | 'bot_pull_request'
  /** The current configuration would run this pull request as a standard review. */
  | 'review_type_not_selected';

type RestartAdmission =
  /** The current configuration admits the restart; the row saves it a read. */
  | { admitted: true; agentConfig: ReviewerConfigRow }
  | { admitted: false; reason: RestartRefusalReason };

/**
 * Whether the current configuration still selects the review type this row
 * stored.
 *
 * The webhook handler decides council or standard from the current
 * configuration and the pull request facts, and the dispatch that runs a
 * restart only re-checks that a council configuration is still active. Council
 * is the expensive path, so a restart repeats the whole decision here: a stored
 * council review the current configuration would start as standard is left for
 * a person, rather than spending council on a pull request the owner no longer
 * selects it for.
 *
 * An inactive council configuration needs no decision of its own, because the
 * dispatch already runs that restart as a standard review. A stored standard
 * review is never widened to council by a restart, which would spend the
 * council budget without a trigger.
 */
async function isStoredReviewTypeStillSelected(params: {
  owner: Owner;
  review: CloudAgentCodeReview;
  pull: OpenPullRequest;
  config: z.infer<typeof RestartConfigSchema>;
}): Promise<boolean> {
  const { owner, review, pull, config } = params;
  if (review.review_type !== 'council') return true;

  const councilConfigActive = isCouncilActive(config.council);
  if (!councilConfigActive) return true;

  const councilEnabledForRepo =
    Array.isArray(config.council_enabled_repository_ids) &&
    config.council_enabled_repository_ids.includes(pull.baseRepoId);
  // The entitlement lookup is a database read, so it runs only behind the two
  // cheap checks the handler also uses first.
  const councilEntitled = councilEnabledForRepo ? await isCouncilEntitledForOwner(owner) : false;
  const prFacts: AutomatedReviewPrFacts = {
    isDraft: pull.draft,
    isBot: pull.authorType === 'Bot',
    isFork: pull.headRepoFullName !== pull.baseRepoFullName,
    author: pull.authorLogin,
    labels: pull.labels,
  };

  return (
    determineAutomatedReviewType(prFacts, {
      councilEntitled,
      councilConfigActive,
      councilEnabledForRepo,
      selection: { requiredLabels: config.council?.required_labels },
    }) === 'council'
  );
}

/**
 * Whether the owner's current Code Reviewer configuration admits this restart.
 *
 * The sweep hands a pull request without a review to the handler, which applies
 * every configuration rule. A restart reaches no handler, so it repeats the
 * rules a stored review can outlive: a repository the owner removed from the
 * selected set, a bot pull request the owner asks to skip, and a review type the
 * current configuration no longer selects. A manual review keeps the request a
 * person made and is not subject to any of them.
 */
async function admitRestart(params: {
  owner: Owner;
  review: CloudAgentCodeReview;
  pull: OpenPullRequest;
}): Promise<RestartAdmission> {
  if (getManualCodeReviewConfig(params.review) !== null) {
    return { admitted: true, agentConfig: null };
  }

  const agentConfig = await getAgentConfigForOwner(params.owner, 'code_review', PLATFORM.GITHUB);
  const parsedConfig = RestartConfigSchema.safeParse(agentConfig?.config);
  if (!parsedConfig.success) return { admitted: false, reason: 'config_unreadable' };
  const config = parsedConfig.data;

  if (
    config.repository_selection_mode === 'selected' &&
    Array.isArray(config.selected_repository_ids) &&
    !config.selected_repository_ids.includes(params.pull.baseRepoId)
  ) {
    return { admitted: false, reason: 'repository_not_selected' };
  }

  const skipBotPullRequests = config.skip_bot_pull_requests ?? true;
  if (skipBotPullRequests && params.pull.authorType === 'Bot') {
    return { admitted: false, reason: 'bot_pull_request' };
  }

  const reviewTypeSelected = await isStoredReviewTypeStillSelected({
    owner: params.owner,
    review: params.review,
    pull: params.pull,
    config,
  });
  if (!reviewTypeSelected) return { admitted: false, reason: 'review_type_not_selected' };

  return { admitted: true, agentConfig };
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

  const existingReview = await findExistingReview(scope, pull.headSha);
  if (existingReview !== null) {
    // A review row at this head used to end the sweep's interest in it. A row
    // that stopped on a transient failure is not an answer: left alone, it keeps
    // the pull request's gate failed and its head never gets a review, because
    // nothing retries it without a person. Restart it here, under an attempt cap
    // so a persistent fault settles instead of billing a run every sweep.
    if (!isAutomaticallyRetryableFailure(existingReview)) {
      summary.skippedExisting += 1;
      return;
    }
    // A new review and a restart each cost one agent run, so both draw on the
    // same per-run budget: the two counters are added, and neither alone is the
    // budget.
    if (summary.reviewsStarted + summary.reviewsRetried >= RECOVER_MISSED_REVIEWS_START_LIMIT) {
      summary.skippedStartLimit += 1;
      return;
    }
    // Reserve the slot synchronously, before any await, as the start path does:
    // several repositories sweep at once, and a retry starts a review, so it
    // spends the same per-run budget. The reservation is released below when
    // this row does not restart.
    summary.reviewsRetried += 1;
    let retried = false;
    try {
      // The attempt rows are read only for a review inside the start budget, so
      // a head that already has its review costs one query.
      const attempts = await listCodeReviewAttempts(existingReview.id);
      if (!isAutomaticallyRetryableReview(existingReview, attempts.length)) {
        // A cause this sweep can restart, with no attempts left: the next
        // restart is a person's, so report it once per review per run.
        summary.retriesExhausted += 1;
        warnExceptInTest('[recoverMissedReviews] Review needs a manual restart', {
          reviewId: existingReview.id,
          terminalReason: existingReview.terminal_reason,
          attempts: attempts.length,
        });
        return;
      }
      const admission = await admitRestart({ owner, review: existingReview, pull });
      if (!admission.admitted) {
        // No run was spent and nothing is left to count as a provider failure.
        summary.skippedRetryRefused += 1;
        logExceptInTest('[recoverMissedReviews] Restart refused by the current configuration', {
          reviewId: existingReview.id,
          reason: admission.reason,
        });
        return;
      }
      const retry = await retryFailedCodeReview({
        review: existingReview,
        owner,
        retryReason: 'automatic_recovery',
        agentConfig: admission.agentConfig,
      });
      if (retry.outcome === 'retried') {
        retried = true;
        return;
      }
      if (retry.outcome === 'already_in_flight') {
        // Another caller reset this review first, so nothing was dispatched.
        summary.skippedExisting += 1;
        return;
      }
      if (retry.outcome === 'refused') {
        // The reviewer configuration cannot run this review, so no run was
        // spent and nothing is left to count as a provider failure.
        summary.skippedRetryRefused += 1;
        return;
      }
      // Dispatch refused the retried attempt, so the row is failed again.
      summary.providerFailures += 1;
      warnExceptInTest('[recoverMissedReviews] Retried review failed again', {
        reviewId: existingReview.id,
      });
      return;
    } finally {
      if (!retried) summary.reviewsRetried -= 1;
    }
  }
  // A review still in flight at an earlier head must not be superseded by a
  // synthetic synchronize event; the webhook path reaches this handler only
  // through the merge-commit and supersession logic that guards that case.
  const activeReviews = await findActiveReviewsForPR(scope, pull.headSha);
  if (activeReviews.length > 0) {
    summary.skippedActiveReview += 1;
    return;
  }
  // A restart spends the same per-run budget as a new review, so the two
  // counters are added here: neither alone is the budget.
  if (summary.reviewsStarted + summary.reviewsRetried >= RECOVER_MISSED_REVIEWS_START_LIMIT) {
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
