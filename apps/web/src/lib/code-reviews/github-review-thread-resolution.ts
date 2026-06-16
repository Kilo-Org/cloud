import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { deriveCallbackToken, verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import {
  generateGitHubInstallationToken,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import { logExceptInTest } from '@/lib/utils.server';

export const GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX = 'KILO_RESOLVED_GITHUB_REVIEW_THREADS=';

const CANONICAL_KILO_INLINE_COMMENT_FOOTER =
  '---\nReply with `@kilocode-bot fix it` to have Kilo Code address this issue.';
const REVIEW_THREAD_LOOKUP_LIMIT = 100;
const REVIEW_THREAD_CANDIDATE_LIMIT = 20;
const REVIEW_THREAD_PROMPT_BODY_LIMIT = 2000;
const REVIEW_THREAD_RESOLUTION_TOKEN_SCOPE = 'github-review-thread-resolution';
const CALLBACK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type GitHubReviewThreadResolutionCandidate = {
  threadId: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  body: string;
  token: string;
};

export type GitHubReviewThreadResolutionResult = {
  status: 'no-marker' | 'invalid-marker' | 'invalid-request' | 'stale-pull-request' | 'resolved';
  requestedCount: number;
  resolvedCount: number;
};

type GitHubReviewThreadResolutionBaseParams = {
  appType: GitHubAppType;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: string;
  expectedHeadSha: string;
  secret: string;
};

type FetchGitHubReviewThreadResolutionCandidatesParams = GitHubReviewThreadResolutionBaseParams & {
  token: string;
};

type ResolveAddressedGitHubReviewThreadsParams = GitHubReviewThreadResolutionBaseParams & {
  installationId: string;
  assistantMessageText?: string;
};

const ReviewThreadCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  viewerDidAuthor: z.boolean(),
});

const ReviewThreadNodeSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  comments: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(ReviewThreadCommentSchema.nullable()).nullable(),
  }),
});

const ReviewThreadsQueryResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
          headRefOid: z.string(),
          reviewThreads: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean() }),
            nodes: z.array(ReviewThreadNodeSchema.nullable()).nullable(),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const ResolveReviewThreadMutationResponseSchema = z.object({
  resolveReviewThread: z
    .object({
      thread: z
        .object({
          id: z.string(),
          isResolved: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
});

const RequestedResolutionSchema = z
  .object({
    id: z.string().min(1),
    token: z.string().regex(CALLBACK_TOKEN_PATTERN),
  })
  .strict();

const RequestedResolutionsSchema = z
  .array(RequestedResolutionSchema)
  .max(REVIEW_THREAD_CANDIDATE_LIMIT);

type ReviewThreadsQueryResponse = z.infer<typeof ReviewThreadsQueryResponseSchema>;
type ReviewThreadNode = z.infer<typeof ReviewThreadNodeSchema>;
type RequestedResolution = z.infer<typeof RequestedResolutionSchema>;

type EligibleReviewThread = {
  id: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  body: string;
};

const REVIEW_THREADS_QUERY = `query KiloReviewThreadResolutionCandidates(
  $owner: String!,
  $repo: String!,
  $number: Int!
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      headRefOid
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          isOutdated
          viewerCanResolve
          path
          line
          comments(first: 1) {
            totalCount
            nodes {
              id
              body
              path
              line
              viewerDidAuthor
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `mutation KiloResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

export async function fetchGitHubReviewThreadResolutionCandidates(
  params: FetchGitHubReviewThreadResolutionCandidatesParams
): Promise<GitHubReviewThreadResolutionCandidate[]> {
  if (params.appType !== 'standard') return [];

  const octokit = new Octokit({ auth: params.token });
  const state = await fetchReviewThreadState(octokit, params);
  const pullRequest = getOpenPullRequestAtExpectedHead(state, params.expectedHeadSha);
  if (!pullRequest) return [];

  logIfLookupWasBounded(params, pullRequest.reviewThreads.pageInfo.hasNextPage);

  const eligibleThreads = getEligibleReviewThreads(pullRequest.reviewThreads.nodes);
  const candidates: GitHubReviewThreadResolutionCandidate[] = [];

  for (const thread of eligibleThreads.slice(0, REVIEW_THREAD_CANDIDATE_LIMIT)) {
    candidates.push({
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      isOutdated: thread.isOutdated,
      body: thread.body.slice(0, REVIEW_THREAD_PROMPT_BODY_LIMIT),
      token: await deriveReviewThreadResolutionToken({
        secret: params.secret,
        reviewId: params.reviewId,
        expectedHeadSha: params.expectedHeadSha,
        threadId: thread.id,
        rootBody: thread.body,
      }),
    });
  }

  return candidates;
}

export async function resolveAddressedGitHubReviewThreads(
  params: ResolveAddressedGitHubReviewThreadsParams
): Promise<GitHubReviewThreadResolutionResult> {
  if (params.appType !== 'standard') {
    return { status: 'no-marker', requestedCount: 0, resolvedCount: 0 };
  }

  const parsedMarker = parseResolutionMarker(params.assistantMessageText);
  if (parsedMarker.status !== 'requests') {
    return { status: parsedMarker.status, requestedCount: 0, resolvedCount: 0 };
  }

  const requests = parsedMarker.requests;
  if (requests.length === 0) {
    return { status: 'resolved', requestedCount: 0, resolvedCount: 0 };
  }

  const tokenData = await generateGitHubInstallationToken(params.installationId, params.appType);
  const octokit = new Octokit({ auth: tokenData.token });
  const state = await fetchReviewThreadState(octokit, params);
  const pullRequest = getOpenPullRequestAtExpectedHead(state, params.expectedHeadSha);
  if (!pullRequest) {
    return {
      status: 'stale-pull-request',
      requestedCount: requests.length,
      resolvedCount: 0,
    };
  }

  logIfLookupWasBounded(params, pullRequest.reviewThreads.pageInfo.hasNextPage);

  const eligibleThreadsById = new Map(
    getEligibleReviewThreads(pullRequest.reviewThreads.nodes).map(thread => [thread.id, thread])
  );
  const validatedThreadIds: string[] = [];

  for (const request of requests) {
    const thread = eligibleThreadsById.get(request.id);
    if (!thread) {
      return {
        status: 'invalid-request',
        requestedCount: requests.length,
        resolvedCount: 0,
      };
    }

    const validToken = await verifyCallbackToken({
      token: request.token,
      secret: params.secret,
      scope: REVIEW_THREAD_RESOLUTION_TOKEN_SCOPE,
      resourceParts: buildResolutionTokenResourceParts({
        reviewId: params.reviewId,
        expectedHeadSha: params.expectedHeadSha,
        threadId: thread.id,
        rootBody: thread.body,
      }),
    });
    if (!validToken) {
      return {
        status: 'invalid-request',
        requestedCount: requests.length,
        resolvedCount: 0,
      };
    }

    validatedThreadIds.push(thread.id);
  }

  let resolvedCount = 0;
  for (const threadId of validatedThreadIds) {
    await resolveReviewThread(octokit, threadId);
    resolvedCount += 1;
  }

  return { status: 'resolved', requestedCount: requests.length, resolvedCount };
}

function parseResolutionMarker(
  assistantMessageText: string | undefined
):
  | { status: 'no-marker' | 'invalid-marker' }
  | { status: 'requests'; requests: RequestedResolution[] } {
  const finalLine = getFinalNonEmptyLine(assistantMessageText);
  if (!finalLine?.startsWith(GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX)) {
    return { status: 'no-marker' };
  }

  const serializedRequests = finalLine.slice(GITHUB_REVIEW_THREAD_RESOLUTION_MARKER_PREFIX.length);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(serializedRequests);
  } catch {
    return { status: 'invalid-marker' };
  }

  const requests = RequestedResolutionsSchema.safeParse(parsedJson);
  if (!requests.success) return { status: 'invalid-marker' };

  const requestedIds = new Set<string>();
  for (const request of requests.data) {
    if (requestedIds.has(request.id)) return { status: 'invalid-marker' };
    requestedIds.add(request.id);
  }

  return { status: 'requests', requests: requests.data };
}

function getFinalNonEmptyLine(value: string | undefined): string | null {
  if (!value) return null;

  const lines = value.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length > 0) return line;
  }

  return null;
}

async function fetchReviewThreadState(
  octokit: Octokit,
  params: Pick<GitHubReviewThreadResolutionBaseParams, 'owner' | 'repo' | 'prNumber'>
): Promise<ReviewThreadsQueryResponse> {
  const response: unknown = await octokit.graphql(REVIEW_THREADS_QUERY, {
    owner: params.owner,
    repo: params.repo,
    number: params.prNumber,
  });

  return ReviewThreadsQueryResponseSchema.parse(response);
}

function getOpenPullRequestAtExpectedHead(
  state: ReviewThreadsQueryResponse,
  expectedHeadSha: string
): NonNullable<NonNullable<ReviewThreadsQueryResponse['repository']>['pullRequest']> | null {
  const pullRequest = state.repository?.pullRequest;
  if (!pullRequest) return null;
  if (pullRequest.state !== 'OPEN') return null;
  if (pullRequest.headRefOid !== expectedHeadSha) return null;

  return pullRequest;
}

function getEligibleReviewThreads(
  threadNodes: Array<ReviewThreadNode | null> | null
): EligibleReviewThread[] {
  const eligibleThreads: EligibleReviewThread[] = [];

  for (const thread of threadNodes ?? []) {
    if (!thread) continue;

    const eligibleThread = getEligibleReviewThread(thread);
    if (eligibleThread) eligibleThreads.push(eligibleThread);
  }

  return eligibleThreads;
}

function getEligibleReviewThread(thread: ReviewThreadNode): EligibleReviewThread | null {
  if (thread.isResolved) return null;
  if (!thread.viewerCanResolve) return null;
  if (thread.comments.totalCount !== 1) return null;

  const rootComment = thread.comments.nodes?.[0] ?? null;
  if (!rootComment) return null;
  if (!rootComment.viewerDidAuthor) return null;
  if (!hasCanonicalInlineCommentFooter(rootComment.body)) return null;

  const path = thread.path ?? rootComment.path;
  if (!path) return null;

  return {
    id: thread.id,
    path,
    line: thread.line ?? rootComment.line,
    isOutdated: thread.isOutdated,
    body: rootComment.body,
  };
}

function hasCanonicalInlineCommentFooter(body: string): boolean {
  if (!body.endsWith(CANONICAL_KILO_INLINE_COMMENT_FOOTER)) return false;
  return (
    body.indexOf(CANONICAL_KILO_INLINE_COMMENT_FOOTER) ===
    body.lastIndexOf(CANONICAL_KILO_INLINE_COMMENT_FOOTER)
  );
}

async function deriveReviewThreadResolutionToken(params: {
  secret: string;
  reviewId: string;
  expectedHeadSha: string;
  threadId: string;
  rootBody: string;
}): Promise<string> {
  return deriveCallbackToken({
    secret: params.secret,
    scope: REVIEW_THREAD_RESOLUTION_TOKEN_SCOPE,
    resourceParts: buildResolutionTokenResourceParts(params),
  });
}

function buildResolutionTokenResourceParts(params: {
  reviewId: string;
  expectedHeadSha: string;
  threadId: string;
  rootBody: string;
}): readonly string[] {
  return [params.reviewId, params.expectedHeadSha, params.threadId, params.rootBody];
}

async function resolveReviewThread(octokit: Octokit, threadId: string): Promise<void> {
  const response: unknown = await octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  const mutation = ResolveReviewThreadMutationResponseSchema.parse(response);
  const resolvedThread = mutation.resolveReviewThread?.thread;

  if (!resolvedThread || resolvedThread.id !== threadId || !resolvedThread.isResolved) {
    throw new Error('GitHub resolveReviewThread mutation did not confirm thread resolution');
  }
}

function logIfLookupWasBounded(
  params: Pick<GitHubReviewThreadResolutionBaseParams, 'owner' | 'repo' | 'prNumber'>,
  hasNextPage: boolean
): void {
  if (!hasNextPage) return;

  logExceptInTest('[githubReviewThreadResolution] Review thread lookup used bounded first page', {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    firstPageLimit: REVIEW_THREAD_LOOKUP_LIMIT,
  });
}
