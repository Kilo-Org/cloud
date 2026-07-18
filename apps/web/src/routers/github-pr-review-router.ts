import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import type { createGitHubPrReviewOctokit } from '@/lib/github-pr-review/client';
import {
  buildChecksResult,
  buildFilesPage,
  buildOverviewDto,
  buildReviewThreadsResult,
  sliceFileLines,
} from '@/lib/github-pr-review/mappers';
import {
  FILE_LINES_MAX,
  FILES_MAX_PAGES,
  FILES_PAGE_SIZE,
  REVIEW_THREADS_PAGE_SIZE,
} from '@/lib/github-pr-review/dtos';
import { throwTrpcFromGraphQlErrors, withGitHubUserTokenRetry } from '@/lib/github-pr-review/retry';
import { getGitHubUserAccessToken } from '@/lib/integrations/platforms/github/user-token-client';
import {
  AutoMergeMethodSchema,
  CommentPositionSchema,
  MergeMethodSchema,
  ReactionContentSchema,
  ReviewEventSchema,
  ReviewSideSchema,
  buildAddReactionVariables,
  buildCreateReviewCommentParams,
  buildDeleteRefParams,
  buildDisableAutoMergeVariables,
  buildEnableAutoMergeVariables,
  buildMergePullRequestParams,
  buildRemoveReactionVariables,
  buildReplyToCommentParams,
  buildResolveThreadVariables,
  buildSubmitReviewParams,
  buildUnresolveThreadVariables,
  buildUpdateBranchParams,
} from '@/lib/github-pr-review/mutations';

const ownerRepoRegex = /^[A-Za-z0-9_.-]+$/;

const ownerRepoSchema = z
  .object({
    owner: z.string().regex(ownerRepoRegex),
    repo: z.string().regex(ownerRepoRegex),
  })
  .strict();

const prNumberSchema = z.number().int().positive();

const GetPullRequestInput = ownerRepoSchema.extend({ number: prNumberSchema }).strict();

const ListChecksInput = ownerRepoSchema.extend({ ref: z.string().min(1).max(255) }).strict();

// tRPC's `useInfiniteQuery` integration injects a `direction` discriminator
// ('forward'|'backward') into the procedure input alongside `cursor`. The input
// stays `.strict()` (unknown fields still rejected), so it must accept it
// explicitly or every infinite-query page 400s.
const infiniteQueryDirection = z.enum(['forward', 'backward']).optional();

const ListFilesInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    cursor: z.number().int().min(1).max(FILES_MAX_PAGES).optional(),
    direction: infiniteQueryDirection,
  })
  .strict();

const GetFileLinesInput = ownerRepoSchema
  .extend({
    ref: z.string().min(1).max(255),
    path: z.string().min(1).max(1024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine(v => v.endLine >= v.startLine, {
    message: 'endLine must be >= startLine',
  });

const ListReviewThreadsInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    cursor: z.string().min(1).optional(),
    direction: infiniteQueryDirection,
  })
  .strict();

const CreateReviewCommentInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    body: z.string().min(1).max(65_535),
    path: z.string().min(1).max(1024),
    line: z.number().int().positive(),
    side: ReviewSideSchema,
    startLine: z.number().int().positive().optional(),
    startSide: ReviewSideSchema.optional(),
    commitSha: z.string().min(40).max(64),
  })
  .strict()
  .refine(v => v.startLine === undefined || v.startLine <= v.line, {
    message: 'startLine must be <= line',
    path: ['startLine'],
  })
  .refine(v => (v.startLine === undefined) === (v.startSide === undefined), {
    message: 'startLine and startSide must be provided together',
    path: ['startSide'],
  });

const ReplyToCommentInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    commentId: z.number().int().positive(),
    body: z.string().min(1).max(65_535),
  })
  .strict();

const SubmitReviewInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    event: ReviewEventSchema,
    body: z.string().min(1).max(65_535).optional(),
    commitSha: z.string().min(40).max(64),
    comments: z
      .array(CommentPositionSchema.extend({ body: z.string().min(1).max(65_535) }).strict())
      .max(100)
      .optional(),
  })
  .strict();

const ThreadIdInput = z.object({ threadId: z.string().min(1).max(256) }).strict();

const ReactionInput = z
  .object({
    commentNodeId: z.string().min(1).max(256),
    content: ReactionContentSchema,
  })
  .strict();

const MergePullRequestInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    method: MergeMethodSchema,
    commitTitle: z.string().min(1).max(255).optional(),
    commitMessage: z.string().min(1).max(65_535).optional(),
    deleteBranch: z.boolean(),
    expectedHeadSha: z.string().min(40).max(64),
    headRef: z.string().min(1).max(255),
    isCrossRepo: z.boolean(),
  })
  .strict();

const UpdateBranchInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    expectedHeadSha: z.string().min(40).max(64),
  })
  .strict();

const AutoMergeInput = z
  .object({
    owner: z.string().regex(ownerRepoRegex),
    repo: z.string().regex(ownerRepoRegex),
    number: prNumberSchema,
    prNodeId: z.string().min(1).max(256),
    method: AutoMergeMethodSchema.optional(),
    commitTitle: z.string().min(1).max(255).optional(),
    commitMessage: z.string().min(1).max(65_535).optional(),
  })
  .strict();

const PULL_REQUEST_FRAGMENT_QUERY = /* GraphQL */ `
  query PrReviewDecision($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
      }
    }
    viewer {
      login
    }
  }
`;

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query PrReviewThreads(
    $owner: String!
    $name: String!
    $number: Int!
    $first: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            subjectType
            path
            line
            startLine
            originalLine
            originalStartLine
            diffSide
            comments(first: 50) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                databaseId
                id
                body
                createdAt
                author {
                  login
                  avatarUrl
                }
                reactions(first: 20) {
                  nodes {
                    content
                    count: reactors(first: 0) {
                      totalCount
                    }
                    viewerHasReacted
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY = /* GraphQL */ `
  query PrReviewThreadComments($threadId: ID!, $first: Int!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            databaseId
            id
            body
            createdAt
            author {
              login
              avatarUrl
            }
            reactions(first: 20) {
              nodes {
                content
                count: reactors(first: 0) {
                  totalCount
                }
                viewerHasReacted
              }
            }
          }
        }
      }
    }
  }
`;

const ENABLE_AUTO_MERGE_MUTATION = /* GraphQL */ `
  mutation EnableAutoMerge($input: EnablePullRequestAutoMergeInput!) {
    enablePullRequestAutoMerge(input: $input) {
      pullRequest {
        id
      }
    }
  }
`;

const DISABLE_AUTO_MERGE_MUTATION = /* GraphQL */ `
  mutation DisableAutoMerge($input: DisablePullRequestAutoMergeInput!) {
    disablePullRequestAutoMerge(input: $input) {
      pullRequest {
        id
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = /* GraphQL */ `
  mutation ResolveThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const UNRESOLVE_THREAD_MUTATION = /* GraphQL */ `
  mutation UnresolveThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const ADD_REACTION_MUTATION = /* GraphQL */ `
  mutation AddReaction($input: AddReactionInput!) {
    addReaction(input: $input) {
      reaction {
        content
      }
    }
  }
`;

const REMOVE_REACTION_MUTATION = /* GraphQL */ `
  mutation RemoveReaction($input: RemoveReactionInput!) {
    removeReaction(input: $input) {
      reaction {
        content
      }
    }
  }
`;

type GraphQlReactionNode = {
  content: string;
  count?: { totalCount: number } | null;
  viewerHasReacted: boolean;
};

type GraphQlCommentNode = {
  databaseId: number;
  id: string;
  body: string;
  createdAt: string;
  author: { login: string; avatarUrl: string } | null;
  reactions: { nodes: GraphQlReactionNode[] };
};

type GraphQlCommentConnection = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GraphQlCommentNode[];
};

type GraphQlReviewThreadNode = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType: 'LINE' | 'FILE' | null;
  path: string | null;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  comments: GraphQlCommentConnection;
};

function normalizeReactions(nodes: GraphQlReactionNode[]) {
  return nodes.map(n => ({
    content: n.content,
    count: n.count?.totalCount ?? 0,
    viewerHasReacted: Boolean(n.viewerHasReacted),
  }));
}

function normalizeComment(node: GraphQlCommentNode) {
  return {
    databaseId: node.databaseId,
    id: node.id,
    body: node.body,
    createdAt: node.createdAt,
    author: node.author,
    reactions: normalizeReactions(node.reactions?.nodes ?? []),
  };
}

// Exported for unit testing the follow-up pagination loop.
export const REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST = REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY;

export async function fetchAllThreadComments(args: {
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>;
  threadId: string;
  initialConnection: GraphQlCommentConnection;
}): Promise<ReturnType<typeof normalizeComment>[]> {
  const { octokit, threadId, initialConnection } = args;
  const collected: ReturnType<typeof normalizeComment>[] =
    initialConnection.nodes.map(normalizeComment);
  let cursor: string | null = initialConnection.pageInfo.endCursor;
  let hasNext = initialConnection.pageInfo.hasNextPage;
  // Follow the comment cursor until GitHub reports no next page, so DTO
  // threads always carry the complete comment list (no silent truncation).
  while (hasNext && cursor) {
    const response = (await octokit.request('POST /graphql', {
      query: REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY,
      variables: { threadId, first: 50, after: cursor },
    })) as {
      data: {
        data: { node: { comments: GraphQlCommentConnection } | null } | null;
        errors?: unknown;
      };
    };
    throwTrpcFromGraphQlErrors(response.data.errors as never);
    const node = response.data.data?.node;
    if (!node) break;
    collected.push(...node.comments.nodes.map(normalizeComment));
    hasNext = node.comments.pageInfo.hasNextPage;
    cursor = node.comments.pageInfo.endCursor;
  }
  return collected;
}

async function fetchReviewThreadsPage(args: {
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>;
  owner: string;
  repo: string;
  number: number;
  cursor: string | null;
}) {
  const { octokit, owner, repo, number, cursor } = args;
  const response = (await octokit.request('POST /graphql', {
    query: REVIEW_THREADS_QUERY,
    variables: {
      owner,
      name: repo,
      number,
      first: REVIEW_THREADS_PAGE_SIZE,
      after: cursor ?? null,
    },
  })) as {
    data: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: GraphQlReviewThreadNode[];
            };
          } | null;
        } | null;
      } | null;
      errors?: unknown;
    };
  };
  throwTrpcFromGraphQlErrors(response.data.errors as never);
  return response.data.data?.repository?.pullRequest?.reviewThreads ?? null;
}

// Octokit's `request('POST /graphql', …)` resolves to `{ data: { data, errors } }`
// (the same envelope the read helpers unwrap). Reading `response.data.errors`
// and `response.data.data` — NOT an extra `.data` level.
type GraphQlMutationResponse<T> = {
  data: { data: T | null; errors?: unknown };
};

async function runGraphQlMutation<T>(args: {
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>;
  query: string;
  variables: Record<string, unknown>;
}): Promise<T> {
  const { octokit, query, variables } = args;
  const response = (await octokit.request('POST /graphql', {
    query,
    variables,
  })) as GraphQlMutationResponse<T>;
  throwTrpcFromGraphQlErrors(response.data.errors as never);
  const payload = response.data.data;
  if (payload === null || payload === undefined) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: 'GitHub returned an empty GraphQL response',
    });
  }
  return payload;
}

// A GraphQL mutation whose top-level operation field is null (with no errors[])
// means GitHub did not perform the action — surface a deliberate failure rather
// than reporting a synthesized success.
function requireGraphQlOperation<T>(value: T | null | undefined, operation: string): T {
  if (value === null || value === undefined) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `GitHub did not confirm the ${operation} operation`,
    });
  }
  return value;
}

export const githubPrReviewRouter = createTRPCRouter({
  getPullRequest: baseProcedure.input(GetPullRequestInput).query(async ({ ctx, input }) => {
    const overview = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        // Raw GitHub errors propagate to withGitHubUserTokenRetry, which
        // handles 401 rotation and classifies everything else.
        const pullsResp = await octokit.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
        });
        const pr = pullsResp.data;
        const repoResp = await octokit.repos.get({
          owner: input.owner,
          repo: input.repo,
        });
        const repo = repoResp.data;
        // GraphQL for reviewDecision + viewer.login
        type OverviewGraphQl = {
          repository: { pullRequest: { reviewDecision: string | null } | null } | null;
          viewer: { login: string } | null;
        };
        let graphQl: OverviewGraphQl | null = null;
        try {
          const gqlResp = (await octokit.request('POST /graphql', {
            query: PULL_REQUEST_FRAGMENT_QUERY,
            variables: { owner: input.owner, name: input.repo, number: input.number },
          })) as { data: { data: OverviewGraphQl | null; errors?: unknown } };
          throwTrpcFromGraphQlErrors(gqlResp.data.errors as never);
          graphQl = gqlResp.data.data ?? null;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // A raw 401 must reach withGitHubUserTokenRetry so it can rotate the
          // credential (and report a terminal rejection) — never silently
          // degrade an authorization failure.
          if (
            error !== null &&
            typeof error === 'object' &&
            (error as { status?: number }).status === 401
          ) {
            throw error;
          }
          // Other GraphQL failures (5xx, field errors) should not block the
          // rest of the overview — degrade the reviewDecision/viewer enrichment.
          graphQl = null;
        }
        return buildOverviewDto({
          pr: pr as never,
          repo: repo as never,
          graphQl,
          viewer: graphQl?.viewer ?? null,
        });
      },
    });
    return overview;
  }),

  listChecks: baseProcedure.input(ListChecksInput).query(async ({ ctx, input }) => {
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const checkRuns = await octokit.paginate(octokit.checks.listForRef, {
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
          per_page: 100,
        });
        const statuses = await octokit.paginate(octokit.repos.listCommitStatusesForRef, {
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
          per_page: 100,
        });
        return buildChecksResult({
          checkRuns: checkRuns as never,
          commitStatuses: statuses as never,
        });
      },
    });
  }),

  listFiles: baseProcedure.input(ListFilesInput).query(async ({ ctx, input }) => {
    const page = input.cursor ?? 1;
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const response = await octokit.pulls.listFiles({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
          page,
          per_page: FILES_PAGE_SIZE,
        });
        return buildFilesPage({
          page,
          perPage: FILES_PAGE_SIZE,
          rawFiles: response.data as never,
        });
      },
    });
  }),

  getFileLines: baseProcedure.input(GetFileLinesInput).query(async ({ ctx, input }) => {
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const response = await octokit.repos.getContent({
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.ref,
          mediaType: { format: 'raw' },
        });
        const data = response.data as unknown;
        if (typeof data !== 'string') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Requested path is not a file',
          });
        }
        const cappedEnd = Math.min(input.endLine, input.startLine + FILE_LINES_MAX - 1);
        return sliceFileLines({
          rawContent: data,
          startLine: input.startLine,
          endLine: cappedEnd,
        });
      },
    });
  }),

  listReviewThreads: baseProcedure.input(ListReviewThreadsInput).query(async ({ ctx, input }) => {
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const connection = await fetchReviewThreadsPage({
          octokit,
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          cursor: input.cursor ?? null,
        });
        if (!connection) {
          return { threads: [], nextCursor: null };
        }
        const threads = await Promise.all(
          connection.nodes.map(async node => {
            const comments = await fetchAllThreadComments({
              octokit,
              threadId: node.id,
              initialConnection: node.comments,
            });
            return {
              id: node.id,
              isResolved: node.isResolved,
              isOutdated: node.isOutdated,
              subjectType: node.subjectType,
              path: node.path,
              line: node.line,
              startLine: node.startLine,
              originalLine: node.originalLine,
              originalStartLine: node.originalStartLine,
              diffSide: node.diffSide,
              comments,
            };
          })
        );
        return buildReviewThreadsResult({
          threads: threads as never,
          page: 1,
          hasNextPage: connection.pageInfo.hasNextPage,
          endCursor: connection.pageInfo.endCursor,
        });
      },
    });
  }),

  // Post a single immediate review comment (no pending review required).
  createReviewComment: baseProcedure
    .input(CreateReviewCommentInput)
    .mutation(async ({ ctx, input }) => {
      const result = await withGitHubUserTokenRetry({
        kiloUserId: ctx.user.id,
        call: async octokit => {
          const params = buildCreateReviewCommentParams({
            owner: input.owner,
            repo: input.repo,
            number: input.number,
            body: input.body,
            commitSha: input.commitSha,
            path: input.path,
            line: input.line,
            side: input.side,
            startLine: input.startLine,
            startSide: input.startSide,
          });
          const response = await octokit.pulls.createReviewComment(params);
          return {
            commentId: response.data.id,
            nodeId: response.data.node_id,
          };
        },
      });
      return result;
    }),

  // Reply to an existing review comment (creates a child comment in the
  // same thread).
  replyToComment: baseProcedure.input(ReplyToCommentInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const params = buildReplyToCommentParams({
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          commentId: input.commentId,
          body: input.body,
        });
        const response = await octokit.pulls.createReplyForReviewComment(params);
        return {
          commentId: response.data.id,
          nodeId: response.data.node_id,
        };
      },
    });
    return result;
  }),

  // Submit a pending review with an optional batch of inline comments and
  // an overall event (APPROVE / REQUEST_CHANGES / COMMENT).
  submitReview: baseProcedure.input(SubmitReviewInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const params = buildSubmitReviewParams({
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          event: input.event,
          body: input.body,
          commitSha: input.commitSha,
          comments: input.comments,
        });
        const response = await octokit.pulls.createReview(params);
        return {
          reviewId: response.data.id,
          nodeId: response.data.node_id,
          state: response.data.state,
        };
      },
    });
    return result;
  }),

  // Resolve a review thread (GraphQL — there is no REST endpoint for this).
  resolveThread: baseProcedure.input(ThreadIdInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildResolveThreadVariables({ threadId: input.threadId });
        const payload = await runGraphQlMutation<{
          resolveReviewThread: { thread: { id: string; isResolved: boolean } } | null;
        }>({ octokit, query: RESOLVE_THREAD_MUTATION, variables });
        const thread = requireGraphQlOperation(
          payload.resolveReviewThread?.thread,
          'resolveReviewThread'
        );
        return { threadId: thread.id, isResolved: thread.isResolved };
      },
    });
    return result;
  }),

  unresolveThread: baseProcedure.input(ThreadIdInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildUnresolveThreadVariables({ threadId: input.threadId });
        const payload = await runGraphQlMutation<{
          unresolveReviewThread: { thread: { id: string; isResolved: boolean } } | null;
        }>({ octokit, query: UNRESOLVE_THREAD_MUTATION, variables });
        const thread = requireGraphQlOperation(
          payload.unresolveReviewThread?.thread,
          'unresolveReviewThread'
        );
        return { threadId: thread.id, isResolved: thread.isResolved };
      },
    });
    return result;
  }),

  addReaction: baseProcedure.input(ReactionInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildAddReactionVariables({
          commentNodeId: input.commentNodeId,
          content: input.content,
        });
        const payload = await runGraphQlMutation<{
          addReaction: { reaction: { content: string } } | null;
        }>({ octokit, query: ADD_REACTION_MUTATION, variables });
        const reaction = requireGraphQlOperation(payload.addReaction?.reaction, 'addReaction');
        return { content: reaction.content };
      },
    });
    return result;
  }),

  removeReaction: baseProcedure.input(ReactionInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildRemoveReactionVariables({
          commentNodeId: input.commentNodeId,
          content: input.content,
        });
        const payload = await runGraphQlMutation<{
          removeReaction: { reaction: { content: string } } | null;
        }>({ octokit, query: REMOVE_REACTION_MUTATION, variables });
        const reaction = requireGraphQlOperation(
          payload.removeReaction?.reaction,
          'removeReaction'
        );
        return { content: reaction.content };
      },
    });
    return result;
  }),

  // Merge a pull request. `expectedHeadSha` enforces the optimistic-concurrency
  // fence — if the head moved since the mobile overview was rendered, GitHub
  // returns 409 and the caller should re-fetch. The branch delete after a
  // successful merge is BEST-EFFORT: failures are reported in the result
  // (never thrown) so the mobile client can surface a banner.
  mergePullRequest: baseProcedure.input(MergePullRequestInput).mutation(async ({ ctx, input }) => {
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const params = buildMergePullRequestParams({
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          method: input.method,
          commitTitle: input.commitTitle,
          commitMessage: input.commitMessage,
          expectedHeadSha: input.expectedHeadSha,
        });
        const response = await octokit.pulls.merge(params);
        const merged = Boolean(response.data.merged);
        if (!merged || !input.deleteBranch || input.isCrossRepo) {
          return {
            merged,
            sha: response.data.sha,
            branchDeleted: false as const,
          };
        }
        // Best-effort: only call deleteRef when the head is same-repo.
        // Catch every error and surface it in the result instead of
        // failing the whole mutation.
        try {
          await octokit.git.deleteRef(
            buildDeleteRefParams({
              owner: input.owner,
              repo: input.repo,
              headRef: input.headRef,
            })
          );
          return {
            merged: true as const,
            sha: response.data.sha,
            branchDeleted: true as const,
          };
        } catch (error) {
          const message =
            error instanceof Error && error.message ? error.message : 'Branch delete failed';
          return {
            merged: true as const,
            sha: response.data.sha,
            branchDeleted: false as const,
            branchDeleteError: message,
          };
        }
      },
    });
  }),

  // Update a PR's head branch from its base (the "Update branch" button).
  // `expectedHeadSha` is the same stale-screen fence as merge; a mismatch
  // 422s and the classifier surfaces it as BAD_REQUEST / CONFLICT.
  updateBranch: baseProcedure.input(UpdateBranchInput).mutation(async ({ ctx, input }) => {
    return withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const params = buildUpdateBranchParams({
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          expectedHeadSha: input.expectedHeadSha,
        });
        const response = await octokit.pulls.updateBranch(params);
        return {
          message: response.data.message,
        };
      },
    });
  }),

  enableAutoMerge: baseProcedure.input(AutoMergeInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildEnableAutoMergeVariables({
          prNodeId: input.prNodeId,
          method: input.method ?? 'MERGE',
          commitTitle: input.commitTitle,
          commitMessage: input.commitMessage,
        });
        const payload = await runGraphQlMutation<{
          enablePullRequestAutoMerge: { pullRequest: { id: string } } | null;
        }>({ octokit, query: ENABLE_AUTO_MERGE_MUTATION, variables });
        const pullRequest = requireGraphQlOperation(
          payload.enablePullRequestAutoMerge?.pullRequest,
          'enablePullRequestAutoMerge'
        );
        return { enabled: true as const, prNodeId: pullRequest.id };
      },
    });
    return result;
  }),

  disableAutoMerge: baseProcedure.input(AutoMergeInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildDisableAutoMergeVariables({ prNodeId: input.prNodeId });
        const payload = await runGraphQlMutation<{
          disablePullRequestAutoMerge: { pullRequest: { id: string } } | null;
        }>({ octokit, query: DISABLE_AUTO_MERGE_MUTATION, variables });
        const pullRequest = requireGraphQlOperation(
          payload.disablePullRequestAutoMerge?.pullRequest,
          'disablePullRequestAutoMerge'
        );
        return { enabled: false as const, prNodeId: pullRequest.id };
      },
    });
    return result;
  }),
});

// Re-export the disconnected helper used by callers that want to surface a
// friendly reconnect message without invoking a full procedure.
export { getGitHubUserAccessToken };
