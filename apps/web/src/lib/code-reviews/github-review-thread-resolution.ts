import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudAgentJsonSchemaFormat } from '@kilocode/worker-utils';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { logExceptInTest } from '@/lib/utils.server';
import type { GitHubReviewThreadResolutionCandidateState } from '@kilocode/db/schema-types';

const CANONICAL_KILO_INLINE_COMMENT_FOOTER =
  '---\nReply with `@kilocode-bot fix it` to have Kilo Code address this issue.';
const REVIEW_THREAD_LOOKUP_LIMIT = 100;
const REVIEW_THREAD_CANDIDATE_LIMIT = 20;
const REVIEW_THREAD_PROMPT_BODY_LIMIT = 2000;
const REVIEW_THREAD_ID_MAX_LENGTH = 512;

export const CloudCodeReviewStructuredOutputSchema = z
  .object({
    addressedReviewThreadIds: z
      .array(z.string().min(1).max(REVIEW_THREAD_ID_MAX_LENGTH))
      .max(REVIEW_THREAD_CANDIDATE_LIMIT)
      .refine(values => new Set(values).size === values.length),
  })
  .strict();

export type CloudCodeReviewStructuredOutput = z.infer<typeof CloudCodeReviewStructuredOutputSchema>;

export const CLOUD_CODE_REVIEW_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      addressedReviewThreadIds: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: REVIEW_THREAD_ID_MAX_LENGTH },
        uniqueItems: true,
        maxItems: REVIEW_THREAD_CANDIDATE_LIMIT,
      },
    },
    required: ['addressedReviewThreadIds'],
    additionalProperties: false,
  },
} satisfies CloudAgentJsonSchemaFormat;

export type GitHubReviewThreadResolutionCandidate = GitHubReviewThreadResolutionCandidateState & {
  path: string;
  line: number | null;
  isOutdated: boolean;
  body: string;
};

type GitHubReviewThreadResolutionBaseParams = {
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadSha: string;
};

type FetchGitHubReviewThreadResolutionCandidatesParams = GitHubReviewThreadResolutionBaseParams & {
  token: string;
};

type ResolveAddressedGitHubReviewThreadsParams = GitHubReviewThreadResolutionBaseParams & {
  installationId: string;
  persistedCandidates: GitHubReviewThreadResolutionCandidateState[];
  structuredOutput?: unknown;
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

type ReviewThreadsQueryResponse = z.infer<typeof ReviewThreadsQueryResponseSchema>;
type ReviewThreadNode = z.infer<typeof ReviewThreadNodeSchema>;

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
      rootBodySha256: hashReviewThreadRootBody(thread.body),
    });
  }

  return candidates;
}

export async function resolveAddressedGitHubReviewThreads(
  params: ResolveAddressedGitHubReviewThreadsParams
): Promise<number> {
  const parsedOutput = CloudCodeReviewStructuredOutputSchema.safeParse(params.structuredOutput);
  if (!parsedOutput.success) return 0;

  const requestedThreadIds = parsedOutput.data.addressedReviewThreadIds;
  if (requestedThreadIds.length === 0) return 0;

  const persistedCandidatesById = new Map(
    params.persistedCandidates.map(candidate => [candidate.threadId, candidate])
  );
  if (persistedCandidatesById.size !== params.persistedCandidates.length) return 0;

  for (const threadId of requestedThreadIds) {
    if (!persistedCandidatesById.has(threadId)) return 0;
  }

  const tokenData = await generateGitHubInstallationToken(params.installationId, 'standard');
  const octokit = new Octokit({ auth: tokenData.token });
  const state = await fetchReviewThreadState(octokit, params);
  const pullRequest = getOpenPullRequestAtExpectedHead(state, params.expectedHeadSha);
  if (!pullRequest) return 0;

  logIfLookupWasBounded(params, pullRequest.reviewThreads.pageInfo.hasNextPage);

  const eligibleThreadsById = new Map(
    getEligibleReviewThreads(pullRequest.reviewThreads.nodes).map(thread => [thread.id, thread])
  );
  const validatedThreadIds: string[] = [];

  for (const threadId of requestedThreadIds) {
    const thread = eligibleThreadsById.get(threadId);
    if (!thread) return 0;

    const persistedCandidate = persistedCandidatesById.get(threadId);
    if (!persistedCandidate) return 0;
    if (persistedCandidate.rootBodySha256 !== hashReviewThreadRootBody(thread.body)) return 0;

    validatedThreadIds.push(thread.id);
  }

  let resolvedCount = 0;
  for (const threadId of validatedThreadIds) {
    await resolveReviewThread(octokit, threadId);
    resolvedCount += 1;
  }

  return resolvedCount;
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

function hashReviewThreadRootBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
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
