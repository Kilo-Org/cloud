import 'server-only';

import { Octokit } from '@octokit/rest';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { generateGitHubInstallationToken, type GitHubAppType } from './adapter';

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const checkStateSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const prStatusSchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed', 'merged', 'draft']),
  title: z.string(),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
  headRef: z.string(),
  baseRef: z.string(),
  baseRepoFullName: z.string().min(1),
  headRepoFullName: z.string().nullable(),
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().nullable(),
  checks: checkStateSchema.nullable(),
  unresolvedThreads: z.number().int().nonnegative().nullable(),
  threadsTruncated: z.boolean(),
  unavailable: z.array(z.enum(['checks', 'statuses', 'reviews'])),
  fetchedAt: z.iso.datetime({ offset: true }),
});

export type PrStatus = z.infer<typeof prStatusSchema>;

export type FetchPullRequestStatusInput = {
  installationId: string;
  integrationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  number: number;
};

type CheckRunLike = {
  status: string;
  conclusion: string | null;
};

type CommitStatusLike = {
  id: number;
  context: string;
  state: string;
  updated_at: string;
};

type CheckPage<T> = {
  items: T[];
  truncated: boolean;
};

type ReviewThreadPage = {
  reviewDecision: string | null;
  reviewThreads: {
    nodes: Array<{ isResolved: boolean }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

const reviewThreadPageSchema: z.ZodType<ReviewThreadPage> = z.object({
  reviewDecision: z.string().nullable(),
  reviewThreads: z.object({
    nodes: z.array(z.object({ isResolved: z.boolean() })),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});

const reviewDataSchema = z.object({
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
  query PrStatusReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
        reviewThreads(first: 100, after: $after) {
          nodes {
            isResolved
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

const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]);

function emptyCheckState(): NonNullable<PrStatus['checks']> {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    unknown: 0,
    truncated: false,
  };
}

function addCheckRun(state: NonNullable<PrStatus['checks']>, run: CheckRunLike): void {
  state.total += 1;
  if (run.status !== 'completed') {
    state.pending += 1;
    return;
  }
  if (run.conclusion === 'success') {
    state.passed += 1;
  } else if (run.conclusion === 'neutral' || run.conclusion === 'skipped') {
    state.skipped += 1;
  } else if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) {
    state.failed += 1;
  } else {
    state.unknown += 1;
  }
}

function addCommitStatus(state: NonNullable<PrStatus['checks']>, status: CommitStatusLike): void {
  state.total += 1;
  if (status.state === 'success') {
    state.passed += 1;
  } else if (status.state === 'failure' || status.state === 'error') {
    state.failed += 1;
  } else if (status.state === 'pending') {
    state.pending += 1;
  } else {
    state.unknown += 1;
  }
}

function isLaterStatus(candidate: CommitStatusLike, current: CommitStatusLike): boolean {
  if (candidate.id !== current.id) {
    return candidate.id > current.id;
  }
  return Date.parse(candidate.updated_at) > Date.parse(current.updated_at);
}

function latestStatusPerContext(statuses: CommitStatusLike[]): CommitStatusLike[] {
  const byContext = new Map<string, CommitStatusLike>();
  for (const status of statuses) {
    const current = byContext.get(status.context);
    if (!current || isLaterStatus(status, current)) {
      byContext.set(status.context, status);
    }
  }
  return [...byContext.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function linkHasNext(headers: unknown): boolean | null {
  if (!isRecord(headers)) {
    return null;
  }
  const link = headers.link;
  if (typeof link !== 'string') {
    return null;
  }
  return /rel="?next"?/i.test(link);
}

async function collectRestPages<T>(
  fetchPage: (page: number) => Promise<{ data: T[]; headers: unknown }>
): Promise<CheckPage<T>> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchPage(page);
    items.push(...response.data);
    const hasNext = linkHasNext(response.headers) ?? response.data.length >= PAGE_SIZE;
    if (!hasNext) {
      return { items, truncated: false };
    }
    if (page === MAX_PAGES) {
      return { items, truncated: true };
    }
  }
  return { items, truncated: true };
}

function normalizeReviewDecision(value: string | null): PrStatus['reviewDecision'] {
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'REVIEW_REQUIRED') return 'review_required';
  return null;
}

async function fetchReviewPage(
  octokit: Octokit,
  params: { owner: string; repo: string; number: number },
  after: string | null
): Promise<ReviewThreadPage> {
  const response = await octokit.request('POST /graphql', {
    query: REVIEW_THREADS_QUERY,
    variables: {
      owner: params.owner,
      name: params.repo,
      number: params.number,
      after,
    },
  });

  const body = graphQlResponseSchema.safeParse(response.data);
  if (!body.success) {
    throw new Error('GitHub returned an invalid GraphQL response for pull request reviews');
  }
  if (body.data.errors && body.data.errors.length > 0) {
    throw new Error('GitHub reported errors while reading pull request reviews');
  }

  const parsed = reviewDataSchema.safeParse(body.data.data);
  const pullRequest = parsed.success ? parsed.data.repository?.pullRequest : null;
  if (!pullRequest) {
    throw new Error('GitHub did not return pull request review data');
  }
  return pullRequest;
}

async function readReviews(
  octokit: Octokit,
  params: { owner: string; repo: string; number: number }
): Promise<{
  reviewDecision: PrStatus['reviewDecision'];
  unresolvedThreads: number;
  truncated: boolean;
}> {
  let page = await fetchReviewPage(octokit, params, null);
  const reviewDecision = normalizeReviewDecision(page.reviewDecision);
  let unresolvedThreads = 0;
  let after: string | null = null;

  for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
    if (pageIndex > 1) {
      page = await fetchReviewPage(octokit, params, after);
    }
    unresolvedThreads += page.reviewThreads.nodes.filter(node => !node.isResolved).length;
    if (!page.reviewThreads.pageInfo.hasNextPage) {
      return { reviewDecision, unresolvedThreads, truncated: false };
    }
    const endCursor = page.reviewThreads.pageInfo.endCursor;
    if (!endCursor) {
      throw new Error('GitHub did not return a review thread cursor');
    }
    if (pageIndex === MAX_PAGES) {
      return { reviewDecision, unresolvedThreads, truncated: true };
    }
    after = endCursor;
  }
  return { reviewDecision, unresolvedThreads, truncated: true };
}

function pullState(pull: { state: string; draft?: boolean; merged: boolean }): PrStatus['state'] {
  if (pull.merged) return 'merged';
  if (pull.state === 'closed') return 'closed';
  if (pull.draft) return 'draft';
  return 'open';
}

export async function fetchPullRequestStatus(
  input: FetchPullRequestStatusInput
): Promise<PrStatus> {
  const token = await generateGitHubInstallationToken(
    input.installationId,
    input.appType,
    input.integrationId,
    'agent'
  );
  const octokit = new Octokit({
    auth: token.token,
    request: { timeout: REQUEST_TIMEOUT_MS },
  });

  const { owner, repo, number } = input;
  let { data: pull } = await octokit.pulls.get({ owner, repo, pull_number: number });
  // GitHub computes mergeability asynchronously after a head or base change.
  for (
    let attempt = 0;
    attempt < 2 && pull.state === 'open' && pull.mergeable === null;
    attempt++
  ) {
    await delay(1_000);
    ({ data: pull } = await octokit.pulls.get({ owner, repo, pull_number: number }));
  }
  const headSha = pull.head.sha;

  const [checksResult, statusesResult, reviewsResult] = await Promise.allSettled([
    collectRestPages<CheckRunLike>(async page => {
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
    collectRestPages<CommitStatusLike>(async page => {
      const response = await octokit.repos.listCommitStatusesForRef({
        owner,
        repo,
        ref: headSha,
        per_page: PAGE_SIZE,
        page,
      });
      return { data: response.data, headers: response.headers };
    }),
    readReviews(octokit, { owner, repo, number }),
  ]);

  const checksPage = checksResult.status === 'fulfilled' ? checksResult.value : null;
  const statusesPage = statusesResult.status === 'fulfilled' ? statusesResult.value : null;
  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : null;
  const unavailable: PrStatus['unavailable'] = [];

  if (!checksPage) unavailable.push('checks');
  if (!statusesPage) unavailable.push('statuses');
  if (!reviews) unavailable.push('reviews');

  let checks: PrStatus['checks'] = null;
  if (checksPage || statusesPage) {
    const state = emptyCheckState();
    if (checksPage) {
      for (const run of checksPage.items) addCheckRun(state, run);
    }
    if (statusesPage) {
      for (const status of latestStatusPerContext(statusesPage.items))
        addCommitStatus(state, status);
    }
    state.truncated =
      (checksPage?.truncated ?? false) ||
      (statusesPage?.truncated ?? false) ||
      !checksPage ||
      !statusesPage;
    checks = state;
  }

  return prStatusSchema.parse({
    url: pull.html_url,
    number: pull.number,
    state: pullState(pull),
    title: pull.title,
    headSha,
    baseSha: pull.base.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    baseRepoFullName: pull.base.repo?.full_name ?? `${owner}/${repo}`,
    headRepoFullName: pull.head.repo?.full_name ?? null,
    reviewDecision: reviews?.reviewDecision ?? null,
    mergeable: pull.mergeable ?? null,
    mergeableState: pull.mergeable_state ?? null,
    checks,
    unresolvedThreads: reviews?.unresolvedThreads ?? null,
    threadsTruncated: reviews?.truncated ?? false,
    unavailable,
    fetchedAt: new Date().toISOString(),
  });
}
