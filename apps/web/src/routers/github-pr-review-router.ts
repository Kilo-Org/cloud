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

const ListFilesInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    cursor: z.number().int().min(1).max(FILES_MAX_PAGES).optional(),
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
      threadId,
      first: 50,
      after: cursor,
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
    owner,
    name: repo,
    number,
    first: REVIEW_THREADS_PAGE_SIZE,
    after: cursor ?? null,
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
            owner: input.owner,
            name: input.repo,
            number: input.number,
          })) as { data: { data: OverviewGraphQl | null; errors?: unknown } };
          throwTrpcFromGraphQlErrors(gqlResp.data.errors as never);
          graphQl = gqlResp.data.data ?? null;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // GraphQL failure should not block the rest of the overview.
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
});

// Re-export the disconnected helper used by callers that want to surface a
// friendly reconnect message without invoking a full procedure.
export { getGitHubUserAccessToken };
