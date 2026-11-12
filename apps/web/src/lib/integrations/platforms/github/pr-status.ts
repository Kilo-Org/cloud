import 'server-only';

import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { prMaintenanceFeedbackCommentSchema as maintenanceCommentSchema } from './pr-maintenance-feedback';
import {
  generateGitHubInstallationToken,
  toGitHubRateLimitError,
  type AssociatedPullRequest,
  type GitHubAppType,
  type GitHubRateLimitError,
} from './adapter';
import {
  createEmptyPrObservations,
  normalizePrObservationEvent,
  PR_OBSERVATION_LIMIT,
  prMergeabilitySchema,
  prObservationsSchema,
  reducePrObservation,
  type PrObservationEvent,
  type PrObservations,
} from './pr-observations';
import {
  claimPrMaintenanceCall,
  PrMaintenanceDeferredError,
  recordPrMaintenanceApiCall,
  type PrMaintenanceScope,
} from './pr-refresh-budget';

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
// Two pages hold the 200-observation state cap without reading history nobody
// can persist.
const MAX_PAGES = 2;
// GraphQL reports rate limiting in a HTTP 200 body; scan every entry because
// the limiting error is not guaranteed to be first.
const GRAPHQL_RATE_LIMIT_CODES = new Set([
  'RATE_LIMITED',
  'SECONDARY_RATE_LIMIT',
  'ABUSE_DETECTION',
]);

export type PullRequestObservationMetadata = AssociatedPullRequest & {
  baseSha?: string;
  baseRef?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

export type FetchPullRequestObservationsInput = {
  installationId: string;
  integrationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  number: number;
  pullRequest: PullRequestObservationMetadata;
  existing: unknown;
  /** Shared deadline for every GitHub request this refresh makes. */
  signal?: AbortSignal;
  maintenanceReason?: 'enable' | 'recheck';
};

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;

export type FetchPullRequestObservationsResult = {
  observations: PrObservations;
  reviewDecision: ReviewDecision;
  reviewDecisionFetched: boolean;
  maintenance?: PrMaintenanceSnapshot;
  maintenanceCheckDetails?: Array<{ id: string; detailsUrl: string | null; name: string }>;
  maintenanceCheckRuns?: CheckRunLike[];
};

export type PrMaintenanceFeedback = z.infer<typeof maintenanceCommentSchema> & {
  source: 'review_comment' | 'review' | 'conversation_comment';
  threadId: string | null;
  resolved: boolean;
  rootId?: string | null;
};
export type PrMaintenanceSnapshot = {
  feedback: PrMaintenanceFeedback[];
  files: string[];
  filesComplete: boolean;
  complete: boolean;
};

type CheckRunLike = {
  id?: number | string | null;
  app?: { id?: number | string | null } | null;
  name?: string | null;
  head_sha?: string | null;
  run_attempt?: number | null;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  details_url?: string | null;
  check_suite?: { id: number | string } | null;
};

type CommitStatusLike = {
  id?: number | string | null;
  context?: string | null;
  state?: string | null;
  updated_at?: string | null;
};

type CheckPage<T> = {
  items: T[];
  truncated: boolean;
};

type ReviewThreadRecord = {
  rootId: string | null;
  threadId: string;
  state: 'unresolved' | 'resolved';
};

const id = z
  .union([z.string().max(20).regex(/^\d+$/), z.number().int().nonnegative()])
  .transform(String);
const reviewThreadPageSchema = z.object({
  reviewDecision: z.string().nullable(),
  comments: z
    .object({
      nodes: z.array(maintenanceCommentSchema),
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    })
    .optional(),
  reviews: z
    .object({
      nodes: z.array(maintenanceCommentSchema),
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    })
    .optional(),
  files: z
    .object({
      nodes: z.array(z.object({ path: z.string(), changeType: z.string().optional() })),
      pageInfo: z.object({ hasNextPage: z.boolean() }),
    })
    .nullable()
    .optional(),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1).max(512),
        isResolved: z.boolean(),
        comments: z.object({
          nodes: z.array(z.object({ fullDatabaseId: id.nullable() }).passthrough()),
          pageInfo: z.object({ hasNextPage: z.boolean() }).optional(),
        }),
      })
    ),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});
type ReviewThreadPage = z.infer<typeof reviewThreadPageSchema>;

const reviewDataSchema = z.object({
  rateLimit: z
    .object({ cost: z.number(), limit: z.number(), remaining: z.number(), resetAt: z.string() })
    .optional(),
  repository: z
    .object({
      pullRequest: reviewThreadPageSchema.nullable(),
    })
    .nullable(),
});

const graphQlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
});

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query PrObservationReviewThreads(
    $owner: String!
    $name: String!
    $number: Int!
    $after: String
    $includePrFeedback: Boolean!
    $includeThreadFeedback: Boolean!
    $threadCommentLimit: Int!
  ) {
    rateLimit {
      cost
      limit
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
        comments(last: 100) @include(if: $includePrFeedback) {
          nodes {
            fullDatabaseId
            body
            authorAssociation
            author {
              login
              __typename
              ... on User {
                databaseId
              }
              ... on Bot {
                databaseId
              }
            }
            updatedAt
            url
          }
          pageInfo {
            hasPreviousPage
          }
        }
        reviews(last: 100) @include(if: $includePrFeedback) {
          nodes {
            fullDatabaseId
            body
            authorAssociation
            author {
              login
              __typename
              ... on User {
                databaseId
              }
              ... on Bot {
                databaseId
              }
            }
            updatedAt
            url
            state
            commit {
              oid
            }
          }
          pageInfo {
            hasPreviousPage
          }
        }
        files(first: 100) @include(if: $includePrFeedback) {
          nodes {
            path
            changeType
          }
          pageInfo {
            hasNextPage
          }
        }
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            comments(first: $threadCommentLimit) {
              nodes {
                fullDatabaseId
                ... @include(if: $includeThreadFeedback) {
                  body
                  authorAssociation
                  author {
                    login
                    __typename
                    ... on User {
                      databaseId
                    }
                    ... on Bot {
                      databaseId
                    }
                  }
                  updatedAt
                  url
                  commit {
                    oid
                  }
                }
              }
              pageInfo @include(if: $includeThreadFeedback) {
                hasNextPage
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function linkHasNext(headers: unknown): boolean | null {
  if (!isRecord(headers)) return null;
  const link = headers.link;
  if (typeof link !== 'string') return null;
  return /rel="?next"?/i.test(link);
}

type RateLimitState = {
  error: GitHubRateLimitError | null;
  scope?: PrMaintenanceScope;
  reason?: string;
};

async function beforeRequest(state: RateLimitState) {
  if (state.error) throw state.error;
  if (!state.scope) return;
  const budget = await claimPrMaintenanceCall(state.scope);
  if (!budget.allowed) throw new PrMaintenanceDeferredError(budget.reason, budget.retryAt);
}

/**
 * Record a rate limit for this invocation, keeping the latest deadline so the
 * caller waits for the longest signal any leg saw. Returns the normalized
 * error, or null when the failure is not a rate limit.
 */
function recordRateLimit(state: RateLimitState, error: unknown): GitHubRateLimitError | null {
  const rateError = toGitHubRateLimitError(error);
  if (!rateError) return null;
  if (!state.error || rateError.resetAt.getTime() > state.error.resetAt.getTime()) {
    state.error = rateError;
  }
  return rateError;
}

export function isRateLimitGraphQlError(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const codes: unknown[] = [entry.type];
  if (isRecord(entry.extensions)) codes.push(entry.extensions.code);
  return codes.some(
    code => typeof code === 'string' && GRAPHQL_RATE_LIMIT_CODES.has(code.toUpperCase())
  );
}

/**
 * GraphQL answers rate limits with HTTP 200, so there are no rate headers to
 * classify. Reuse the adapter's header parser against a synthetic 429 carrying
 * the response's actual headers to keep one deadline rule.
 */
function graphQlRateLimitError(headers: unknown): GitHubRateLimitError | null {
  return toGitHubRateLimitError({
    status: 429,
    message: 'GitHub GraphQL rate limit',
    response: { headers },
  });
}

async function collectRestPages<T>(
  state: RateLimitState,
  fetchPage: (page: number) => Promise<{ data: T[]; headers: unknown }>
): Promise<CheckPage<T>> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // A sibling leg saw a rate limit: stop before starting another request.
    await beforeRequest(state);
    let response: { data: T[]; headers: unknown };
    try {
      if (state.scope)
        await recordPrMaintenanceApiCall({
          ...state.scope,
          endpoint: 'pr_refresh',
          reason: state.reason ?? 'refresh',
        });
      response = await fetchPage(page);
    } catch (error) {
      const rateError = recordRateLimit(state, error);
      throw rateError ?? error;
    }
    items.push(...response.data);
    if (state.scope)
      await recordPrMaintenanceApiCall({
        ...state.scope,
        endpoint: 'pr_refresh',
        reason: state.reason ?? 'refresh',
        headers: response.headers,
        calls: 0,
      });
    const hasNext = linkHasNext(response.headers) ?? response.data.length >= PAGE_SIZE;
    if (!hasNext) return { items, truncated: false };
    if (page === MAX_PAGES) return { items, truncated: true };
  }
  return { items, truncated: true };
}

function normalizeReviewDecision(value: string | null): ReviewDecision {
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'REVIEW_REQUIRED') return 'review_required';
  return null;
}

type ReviewQueryParams = { owner: string; repo: string; number: number; maintenance: boolean };

async function fetchReviewPage(
  octokit: Octokit,
  params: ReviewQueryParams,
  after: string | null,
  state: RateLimitState
): Promise<ReviewThreadPage> {
  await beforeRequest(state);

  let response: { data: unknown; headers: unknown };
  try {
    if (state.scope)
      await recordPrMaintenanceApiCall({
        ...state.scope,
        endpoint: 'pr_refresh',
        reason: state.reason ?? 'refresh',
      });
    response = await octokit.request('POST /graphql', {
      query: REVIEW_THREADS_QUERY,
      variables: {
        owner: params.owner,
        name: params.repo,
        number: params.number,
        after,
        includePrFeedback: params.maintenance && after === null,
        includeThreadFeedback: params.maintenance,
        threadCommentLimit: params.maintenance ? 10 : 1,
      },
    });
  } catch (error) {
    const rateError = recordRateLimit(state, error);
    throw rateError ?? error;
  }

  const body = graphQlResponseSchema.safeParse(response.data);
  if (!body.success) {
    throw new Error('GitHub returned an invalid GraphQL response for pull request reviews');
  }
  if (body.data.errors && body.data.errors.length > 0) {
    if (body.data.errors.some(isRateLimitGraphQlError)) {
      const rateError = graphQlRateLimitError(response.headers);
      if (rateError) {
        recordRateLimit(state, rateError);
        throw rateError;
      }
    }
    throw new Error('GitHub reported errors while reading pull request reviews');
  }

  const parsed = reviewDataSchema.safeParse(body.data.data);
  if (state.scope)
    await recordPrMaintenanceApiCall({
      ...state.scope,
      endpoint: 'pr_refresh',
      reason: state.reason ?? 'refresh',
      headers: response.headers,
      calls: 0,
      graphqlCost: parsed.success ? parsed.data.rateLimit?.cost : undefined,
      graphqlBudget: parsed.success ? parsed.data.rateLimit : undefined,
    });
  const pullRequest = parsed.success ? parsed.data.repository?.pullRequest : null;
  if (!pullRequest) {
    throw new Error('GitHub did not return pull request review data');
  }
  return pullRequest;
}

async function readReviews(
  octokit: Octokit,
  params: ReviewQueryParams,
  state: RateLimitState
): Promise<{
  reviewDecision: ReviewDecision;
  threads: ReviewThreadRecord[];
  truncated: boolean;
  maintenance: PrMaintenanceSnapshot;
}> {
  let after: string | null = null;
  let reviewDecision: ReviewDecision = null;
  const threads: ReviewThreadRecord[] = [];
  const maintenance: PrMaintenanceSnapshot = {
    feedback: [],
    files: [],
    filesComplete: false,
    complete: true,
  };

  for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
    const page = await fetchReviewPage(octokit, params, after, state);
    if (pageIndex === 1) reviewDecision = normalizeReviewDecision(page.reviewDecision);
    if (pageIndex === 1) {
      maintenance.files = page.files?.nodes.map(file => file.path) ?? [];
      maintenance.filesComplete = Boolean(
        page.files &&
        !page.files.pageInfo.hasNextPage &&
        !page.files.nodes.some(file => file.changeType === 'RENAMED')
      );
      maintenance.complete = Boolean(
        page.comments &&
        page.reviews &&
        !page.comments.pageInfo.hasPreviousPage &&
        !page.reviews.pageInfo.hasPreviousPage
      );
      for (const comment of page.comments?.nodes ?? [])
        maintenance.feedback.push({
          ...comment,
          source: 'conversation_comment',
          threadId: null,
          resolved: false,
        });
      for (const review of page.reviews?.nodes ?? [])
        maintenance.feedback.push({ ...review, source: 'review', threadId: null, resolved: false });
    }
    for (const node of page.reviewThreads.nodes) {
      if (threads.length >= PR_OBSERVATION_LIMIT) {
        return {
          reviewDecision,
          threads,
          truncated: true,
          maintenance: { ...maintenance, complete: false },
        };
      }
      threads.push({
        rootId: node.comments.nodes[0]?.fullDatabaseId ?? null,
        threadId: node.id,
        state: node.isResolved ? 'resolved' : 'unresolved',
      });
      if (
        !node.comments.pageInfo ||
        node.comments.pageInfo.hasNextPage ||
        !node.comments.nodes.length
      ) {
        maintenance.complete = false;
        continue;
      }
      for (const comment of node.comments.nodes) {
        const parsed = maintenanceCommentSchema.safeParse(comment);
        if (parsed.success)
          maintenance.feedback.push({
            ...parsed.data,
            source: 'review_comment',
            threadId: node.id,
            resolved: node.isResolved,
            rootId: node.comments.nodes[0]?.fullDatabaseId ?? null,
          });
        else maintenance.complete = false;
      }
    }
    if (!page.reviewThreads.pageInfo.hasNextPage) {
      return { reviewDecision, threads, truncated: false, maintenance };
    }
    if (threads.length >= PR_OBSERVATION_LIMIT) {
      return {
        reviewDecision,
        threads,
        truncated: true,
        maintenance: { ...maintenance, complete: false },
      };
    }
    const endCursor = page.reviewThreads.pageInfo.endCursor;
    if (!endCursor) throw new Error('GitHub did not return a review thread cursor');
    if (pageIndex === MAX_PAGES)
      return {
        reviewDecision,
        threads,
        truncated: true,
        maintenance: { ...maintenance, complete: false },
      };
    after = endCursor;
  }
  return {
    reviewDecision,
    threads,
    truncated: true,
    maintenance: { ...maintenance, complete: false },
  };
}

type CheckEvent = Extract<PrObservationEvent, { kind: 'check' }>;

function checkRunEvent(
  input: FetchPullRequestObservationsInput,
  run: CheckRunLike
): CheckEvent | null {
  const event = normalizePrObservationEvent('check_run', {
    installation: { id: '0' },
    repository: { id: '0', full_name: `${input.owner}/${input.repo}` },
    check_run: {
      id: run.id,
      app: run.app,
      name: run.name,
      head_sha: run.head_sha,
      run_attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.started_at,
      completed_at: run.completed_at,
    },
  });
  return event?.kind === 'check' ? event : null;
}

function commitStatusEvent(
  input: FetchPullRequestObservationsInput,
  headSha: string,
  status: CommitStatusLike
): CheckEvent | null {
  const event = normalizePrObservationEvent('status', {
    installation: { id: '0' },
    repository: { id: '0', full_name: `${input.owner}/${input.repo}` },
    id: status.id,
    sha: headSha,
    context: status.context,
    state: status.state,
    updated_at: status.updated_at,
  });
  return event?.kind === 'check' ? event : null;
}

function threadEvent(
  input: FetchPullRequestObservationsInput,
  thread: ReviewThreadRecord
): PrObservationEvent {
  return {
    installationId: '0',
    repositoryId: '0',
    repository: `${input.owner}/${input.repo}`,
    kind: 'thread',
    prNumber: input.number,
    rootId: thread.rootId,
    threadId: thread.threadId,
    state: thread.state,
    fromComment: false,
  };
}

function seedMergeability(
  pullRequest: PullRequestObservationMetadata,
  headSha: string
): PrObservations['mergeability'] {
  if (!pullRequest.baseSha || !pullRequest.baseRef) return undefined;
  const parsed = prMergeabilitySchema.safeParse({
    headSha,
    baseSha: pullRequest.baseSha,
    baseRef: pullRequest.baseRef,
    mergeable: pullRequest.mergeable ?? null,
    state: pullRequest.mergeableState ?? null,
    observedAt: new Date().toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

export async function fetchPullRequestObservations(
  input: FetchPullRequestObservationsInput
): Promise<FetchPullRequestObservationsResult> {
  const rateLimitState: RateLimitState = {
    error: null,
    ...(input.maintenanceReason
      ? {
          scope: { appType: input.appType, installationId: input.installationId },
          reason: input.maintenanceReason,
        }
      : {}),
  };
  const signal = input.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let token: Awaited<ReturnType<typeof generateGitHubInstallationToken>>;
  try {
    token = await generateGitHubInstallationToken(
      input.installationId,
      input.appType,
      input.integrationId,
      'agent',
      signal
    );
  } catch (error) {
    const rateError = recordRateLimit(rateLimitState, error);
    throw rateError ?? error;
  }

  const octokit = new Octokit({
    auth: token.token,
    request: { signal },
  });

  const { owner, repo, number } = input;
  const headSha = input.pullRequest.headSha.toLowerCase();

  const parsedExisting = prObservationsSchema.safeParse(input.existing);
  const state: PrObservations = parsedExisting.success
    ? {
        ...parsedExisting.data,
        checks: [...parsedExisting.data.checks],
        threads: [...parsedExisting.data.threads],
      }
    : {
        ...createEmptyPrObservations(),
        threadsUnknown: input.existing != null,
        checksTruncated: input.existing != null,
        threadsTruncated: input.existing != null,
      };

  if (state.headSha !== headSha) {
    state.headSha = headSha;
    state.checks = [];
    state.checksTruncated = false;
    state.checksObserved = false;
    state.checksComplete = false;
    state.mergeability = undefined;
  }

  const [checkRunsResult, statusesResult, reviewsResult] = await Promise.allSettled([
    collectRestPages<CheckRunLike>(rateLimitState, async page => {
      const response = await octokit.checks.listForRef({
        owner,
        repo,
        ref: headSha,
        filter: 'latest',
        per_page: PAGE_SIZE,
        page,
      });
      return { data: response.data.check_runs, headers: response.headers };
    }),
    collectRestPages<CommitStatusLike>(rateLimitState, async page => {
      const response = await octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: headSha,
        per_page: PAGE_SIZE,
        page,
      });
      return { data: response.data.statuses, headers: response.headers };
    }),
    readReviews(
      octokit,
      { owner, repo, number, maintenance: Boolean(input.maintenanceReason) },
      rateLimitState
    ),
  ]);

  // A rate limit is an operational signal for the whole refresh, not partial
  // data. Propagate it before building or persisting any fresh observations.
  if (rateLimitState.error) throw rateLimitState.error;
  for (const result of [checkRunsResult, statusesResult, reviewsResult]) {
    if (result.status === 'rejected' && result.reason instanceof PrMaintenanceDeferredError)
      throw result.reason;
  }

  const checkRunsPage = checkRunsResult.status === 'fulfilled' ? checkRunsResult.value : null;
  const statusesPage = statusesResult.status === 'fulfilled' ? statusesResult.value : null;
  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;

  const unavailable: Array<'checks' | 'statuses' | 'reviews'> = [];
  if (!checkRunsPage) unavailable.push('checks');
  if (!statusesPage) unavailable.push('statuses');
  if (!reviews) unavailable.push('reviews');
  state.unavailable = unavailable;

  let working: PrObservations = {
    ...state,
    checks: state.checks.filter(
      check =>
        (!checkRunsPage && check.key.startsWith('check:')) ||
        (!statusesPage && check.key.startsWith('status:'))
    ),
    checksTruncated:
      !checkRunsPage || !statusesPage
        ? state.checksTruncated ||
          (checkRunsPage?.truncated ?? false) ||
          (statusesPage?.truncated ?? false)
        : (checkRunsPage?.truncated ?? false) || (statusesPage?.truncated ?? false),
  };

  let invalidSourceItems = false;
  if (checkRunsPage) {
    for (const run of checkRunsPage.items) {
      const event = checkRunEvent(input, run);
      if (!event || event.sha !== headSha) {
        invalidSourceItems = true;
        continue;
      }
      working = reducePrObservation(working, headSha, event) ?? working;
    }
  }
  if (statusesPage) {
    for (const status of statusesPage.items) {
      const event = commitStatusEvent(input, headSha, status);
      if (!event || event.sha !== headSha) {
        invalidSourceItems = true;
        continue;
      }
      working = reducePrObservation(working, headSha, event) ?? working;
    }
  }
  working.checksTruncated ||= invalidSourceItems;
  working.checksObserved = Boolean(checkRunsPage && statusesPage);
  working.checksComplete = working.checksObserved && !working.checksTruncated;

  if (reviews) {
    working.threads = [];
    working.threadsObserved = true;
    working.threadsUnknown = false;
    working.threadsTruncated = reviews.truncated;
    working.threadsComplete = false;
    for (const thread of reviews.threads) {
      working = reducePrObservation(working, headSha, threadEvent(input, thread)) ?? working;
    }
    working.threadsComplete = !working.threadsUnknown && !working.threadsTruncated;
  }

  const mergeability = seedMergeability(input.pullRequest, headSha);
  if (mergeability) working.mergeability = mergeability;

  return {
    observations: prObservationsSchema.parse(working),
    reviewDecision: reviews?.reviewDecision ?? null,
    reviewDecisionFetched: reviewsResult.status === 'fulfilled',
    maintenance: reviews?.maintenance,
    maintenanceCheckDetails: checkRunsPage?.items.flatMap(run =>
      run.id != null
        ? [{ id: String(run.id), detailsUrl: run.details_url ?? null, name: run.name ?? 'Check' }]
        : []
    ),
    maintenanceCheckRuns: checkRunsPage?.items,
  };
}
