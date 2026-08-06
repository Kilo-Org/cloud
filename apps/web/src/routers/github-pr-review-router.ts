import 'server-only';

import * as z from 'zod';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users, type OperationLedgerRow } from '@kilocode/db/schema';
import {
  admitOperation,
  markReconcilePending,
  recordOperationAcceptance,
  settleOperation,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';
import type { createGitHubPrReviewOctokit } from '@/lib/github-pr-review/client';
import {
  buildChecksResult,
  buildFilesPage,
  buildOverviewDto,
  buildReviewThreadsResult,
  sliceFileLines,
} from '@/lib/github-pr-review/mappers';
import {
  CONVERSATION_COMMENTS_MAX_PAGES,
  CONVERSATION_COMMENTS_PAGE_SIZE,
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

// Client-generated UUID, stable across retries of one user intent. When
// present, the procedure admits the operation into the shared ledger and
// becomes retry-safe (P1-A-08c); when absent, the legacy non-ledger path
// runs unchanged (older mobile clients keep working).
const operationKeySchema = z.string().min(1).max(128).optional();

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
    operationKey: operationKeySchema,
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
    operationKey: operationKeySchema,
  })
  .strict();

const SubmitReviewInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    event: ReviewEventSchema,
    body: z.string().min(1).max(65_535).optional(),
    commitSha: z.string().min(40).max(64),
    comments: z
      .array(
        CommentPositionSchema.extend({
          body: z.string().min(1).max(65_535),
        }).strict()
      )
      .max(100)
      .optional(),
    operationKey: operationKeySchema,
  })
  .strict();

const ThreadIdInput = z.object({ threadId: z.string().min(1).max(256) }).strict();

const ReactionInput = z
  .object({
    commentNodeId: z.string().min(1).max(256),
    content: ReactionContentSchema,
  })
  .strict();

// `headRef` and `isCrossRepo` were required in an earlier wire version. Older
// shipped mobile clients still send them; newer clients omit them entirely.
// The schema stays `.strict()` (so genuinely unknown fields are still
// rejected) and tolerates these two legacy fields — they are accepted and
// IGNORED. The server derives the authoritative head ref / same-repo
// identity from `octokit.pulls.get` so a caller cannot spoof which ref gets
// deleted. Aligns with the tolerate-not-reject pattern near `direction`
// above.
const MergePullRequestInput = ownerRepoSchema
  .extend({
    number: prNumberSchema,
    method: MergeMethodSchema,
    commitTitle: z.string().min(1).max(255).optional(),
    commitMessage: z.string().min(1).max(65_535).optional(),
    deleteBranch: z.boolean(),
    expectedHeadSha: z.string().min(40).max(64),
    operationKey: operationKeySchema,
    // Legacy fields — accepted for backward compat, ignored by the server.
    headRef: z.string().min(1).max(255).optional(),
    isCrossRepo: z.boolean().optional(),
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
                diffHunk
                createdAt
                author {
                  login
                  avatarUrl
                }
                reactionGroups {
                  content
                  viewerHasReacted
                  reactors(first: 0) {
                    totalCount
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
            reactionGroups {
              content
              viewerHasReacted
              reactors(first: 0) {
                totalCount
              }
            }
          }
        }
      }
    }
  }
`;

// PR conversation (issue) comments — separate from reviewThreads so this
// connection can be paginated to completion on the first listReviewThreads
// page only. Node selection matches the live review-comment selection so
// normalizeComment / normalizeReactions apply unchanged.
const CONVERSATION_COMMENTS_QUERY = /* GraphQL */ `
  query PrReviewConversationComments(
    $owner: String!
    $name: String!
    $number: Int!
    $first: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
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
            reactionGroups {
              content
              viewerHasReacted
              reactors(first: 0) {
                totalCount
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

// Mirrors GitHub's ReactionGroup (not Reaction): reactionGroups is an
// unpaginated list of all group types; only groups with totalCount > 0 are kept.
type GraphQlReactionGroup = {
  content: string;
  viewerHasReacted: boolean;
  reactors?: { totalCount: number } | null;
};

type GraphQlCommentNode = {
  databaseId: number;
  id: string;
  body: string;
  diffHunk?: string | null;
  createdAt: string;
  author: { login: string; avatarUrl: string } | null;
  reactionGroups: GraphQlReactionGroup[];
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

function normalizeReactions(groups: GraphQlReactionGroup[]) {
  return groups
    .map(g => ({
      content: g.content,
      count: g.reactors?.totalCount ?? 0,
      viewerHasReacted: Boolean(g.viewerHasReacted),
    }))
    .filter(r => r.count > 0);
}

function normalizeComment(node: GraphQlCommentNode) {
  return {
    databaseId: node.databaseId,
    id: node.id,
    body: node.body,
    createdAt: node.createdAt,
    author: node.author,
    reactions: normalizeReactions(node.reactionGroups ?? []),
  };
}

// Exported for unit testing the follow-up pagination loop.
export const REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY_FOR_TEST = REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY;
export const CONVERSATION_COMMENTS_QUERY_FOR_TEST = CONVERSATION_COMMENTS_QUERY;

// All raw PR-Review GraphQL documents defined in this router, collected as a
// single exported record so the schema-validity test enumerates docs from
// module exports (newly added docs are auto-covered). Keys are the
// operation name / mutation tag; values are the unchanged document strings.
export const PR_REVIEW_GRAPHQL_DOCUMENTS = {
  PULL_REQUEST_FRAGMENT_QUERY,
  REVIEW_THREADS_QUERY,
  REVIEW_THREAD_COMMENTS_FOLLOWUP_QUERY,
  CONVERSATION_COMMENTS_QUERY,
  ENABLE_AUTO_MERGE_MUTATION,
  DISABLE_AUTO_MERGE_MUTATION,
  RESOLVE_THREAD_MUTATION,
  UNRESOLVE_THREAD_MUTATION,
  ADD_REACTION_MUTATION,
  REMOVE_REACTION_MUTATION,
} as const;

// Exported for unit testing the reaction DTO invariant pinned against
// GitHub's actual `reactionGroups` shape. The downstream DTO contract —
// `Array<{ content: string; count: number; viewerHasReacted: boolean }>` —
// is consumed by `mappers.ts` and the mobile reactions row and must NOT
// change shape; see `normalize-reactions.test.ts`.
export const normalizeReactions_FOR_TEST = normalizeReactions;
export const normalizeComment_FOR_TEST = normalizeComment;

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

async function fetchConversationCommentsPage(args: {
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>;
  owner: string;
  repo: string;
  number: number;
  cursor: string | null;
}): Promise<GraphQlCommentConnection | null> {
  const { octokit, owner, repo, number, cursor } = args;
  const response = (await octokit.request('POST /graphql', {
    query: CONVERSATION_COMMENTS_QUERY,
    variables: {
      owner,
      name: repo,
      number,
      first: CONVERSATION_COMMENTS_PAGE_SIZE,
      after: cursor ?? null,
    },
  })) as {
    data: {
      data: {
        repository: {
          pullRequest: {
            comments: GraphQlCommentConnection;
          } | null;
        } | null;
      } | null;
      errors?: unknown;
    };
  };
  throwTrpcFromGraphQlErrors(response.data.errors as never);
  return response.data.data?.repository?.pullRequest?.comments ?? null;
}

// First-page-only conversation comments. Loops against pageInfo up to
// CONVERSATION_COMMENTS_MAX_PAGES × CONVERSATION_COMMENTS_PAGE_SIZE (5 × 100).
// Past the cap, remaining pages are dropped and whatever was collected is
// returned (silent truncation) — same ceiling spirit as bot review-comment
// pagination (bot/platforms/github.ts).
export async function fetchAllConversationComments(args: {
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>;
  owner: string;
  repo: string;
  number: number;
}): Promise<ReturnType<typeof normalizeComment>[]> {
  const { octokit, owner, repo, number } = args;
  const collected: ReturnType<typeof normalizeComment>[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= CONVERSATION_COMMENTS_MAX_PAGES; page += 1) {
    const connection = await fetchConversationCommentsPage({
      octokit,
      owner,
      repo,
      number,
      cursor,
    });
    if (!connection) break;
    collected.push(...connection.nodes.map(normalizeComment));
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
      return collected;
    }
    cursor = connection.pageInfo.endCursor;
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

// ----- PR operation ledger (P1-A-08c) -----------------------------------------

// Shared per-intent ledger for the four PR write procedures. When the caller
// supplies an `operationKey`, the procedure admits a `pr`-domain row and only
// then runs the GitHub effect; every later same-key call dedupes, replays the
// canonical result, or reconciles before deciding. Deterministic GitHub
// rejections settle the row `failed`; ambiguous network/timeout/5xx outcomes
// become `reconcile_pending` and never re-execute the write under the same
// key. The ledger helpers (`@kilocode/db/operation-ledger`) own admission,
// lease serialization, and the atomic `pr_operation_settled` outbox write.
const PR_LEDGER_DOMAIN = 'pr' as const;
// The in-flight window: while an `admitted` row holds a live lease, same-key
// retries receive CONFLICT `operation_in_progress` instead of re-executing.
const PR_LEDGER_LEASE_SECONDS = 120;

const PR_LEDGER_INTENTS = [
  'merge',
  'submit_review',
  'create_review_comment',
  'reply_comment',
] as const;
type PrLedgerIntent = (typeof PR_LEDGER_INTENTS)[number];

// Client-facing CONFLICT markers. `operation_in_progress` keeps the existing
// pending/retry UI on mobile; the ambiguous copy tells the user to verify the
// PR before retrying (a retry under the same key never re-executes the write).
// `operation_key_reuse_mismatch` is the cross-intent rejection: a caller that
// reuses an existing key for a DIFFERENT intent/resource/request is refused
// without any effect or replay.
const OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const PR_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the PR before retrying.";
const PR_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const PR_CONFLICT_MESSAGE = 'GitHub reported a conflict for this PR';
const PR_OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
// A provider-confirmed outcome whose ledger settle failed: the GitHub effect
// DID commit, but the row was not settled. The caller must NOT receive a
// success receipt (the row is still non-terminal, so success would falsely
// claim a retry-safe replay). Surface a retryable server error instead: a
// same-key retry reconciles the committed provider outcome and settles the
// row.
const PR_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
// An ambiguous outcome whose `reconcile_pending` persistence failed: the row
// was NOT marked reconcile-pending, so the ambiguous marker (which promises
// that same-key retries dedupe and reconcile instead of re-executing) must
// never be surfaced. Return a distinct non-retryable persistence error so the
// client cannot blind-retry the same key against an admitted row.
const PR_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

function operationInProgressError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: OPERATION_IN_PROGRESS_MESSAGE });
}

function ambiguousPrError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: PR_AMBIGUOUS_MESSAGE });
}

function conflictPrError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: PR_CONFLICT_MESSAGE });
}

function operationKeyReuseMismatchError(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: PR_OPERATION_KEY_REUSE_MISMATCH_MESSAGE });
}

/**
 * Deterministic fingerprint of the intent-defining inputs for one PR
 * mutation. The same user intent (retry) always produces the same fingerprint;
 * ANY change to an intent input (comment body, review contents, reply text,
 * merge method/message, resource, fence sha) produces a different one. Folded
 * into the ledger `resource_key` so the admission row comparison can reject
 * cross-intent operation-key reuse (finding: an existing key with a different
 * PR intent/resource/request must never replay the old canonical result).
 */
function prRequestFingerprint(intent: PrLedgerIntent, input: Record<string, unknown>): string {
  const resource = [input.owner, input.repo, input.number];
  const parts =
    intent === 'create_review_comment'
      ? {
          resource,
          body: input.body,
          path: input.path,
          line: input.line,
          side: input.side,
          startLine: input.startLine,
          startSide: input.startSide,
          commitSha: input.commitSha,
        }
      : intent === 'reply_comment'
        ? {
            resource,
            commentId: input.commentId,
            body: input.body,
          }
        : intent === 'submit_review'
          ? {
              resource,
              event: input.event,
              body: input.body,
              commitSha: input.commitSha,
              comments: input.comments,
            }
          : {
              resource,
              method: input.method,
              commitTitle: input.commitTitle,
              commitMessage: input.commitMessage,
              deleteBranch: input.deleteBranch,
              expectedHeadSha: input.expectedHeadSha,
            };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * The PR ledger resource identity: the domain resource (`owner/repo#number`)
 * plus the intent fingerprint. Stored verbatim in `resource_key` (never
 * analytics) and compared on every admission so an existing key with a
 * different intent/resource/request is rejected instead of replayed.
 * Exported so router tests can build the exact stored identity.
 */
export function prLedgerResourceKey(
  intent: PrLedgerIntent,
  input: Record<string, unknown>
): string {
  return `${String(input.owner)}/${String(input.repo)}#${String(input.number)}::${prRequestFingerprint(intent, input)}`;
}

/**
 * Best-effort ledger write, reserved for FAILED-status settles only: the
 * caller is already receiving a typed rejection (a deterministic GitHub
 * rejection or a confirmed-absent reconcile), so a ledger write that fails
 * here must never mask the provider outcome — the error is being surfaced
 * regardless and a later same-key retry re-records it. Completed settles and
 * reconcile-pending marks must NOT use this helper: they gate whether the
 * caller is told success or sees the ambiguous marker, so their failures use
 * the durable helpers below instead.
 */
async function bestEffortLedgerWrite(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `Failed to write PR operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** The PR provider reference for reconciliation, derived from the canonical result. */
function prProviderRefFromCanonical(canonical: Record<string, unknown>): string | null {
  if (typeof canonical.commentId === 'number') return String(canonical.commentId);
  if (typeof canonical.reviewId === 'number') return String(canonical.reviewId);
  return null;
}

/**
 * Durably settles a provider-confirmed outcome as `completed` (P1-A-08c). The
 * GitHub effect committed, so a settle that fails must never be swallowed:
 * the row would stay `admitted` while the caller receives a success receipt —
 * a false "retry-safe" claim. The caller is NOT told success; instead the
 * canonical provider evidence is preserved on the non-terminal row (atomic
 * `provider_ref` + `canonical_result`, best-effort — the error below is the
 * durable signal) so a same-key retry can reconcile by re-fetching the
 * recorded reference, and a retryable server error is thrown. A committed
 * write is never settled `failed` from this path: that would falsely tell a
 * same-key retry the action did not complete and lose the reconciliation
 * evidence.
 */
async function settleCompletedPrRow(args: {
  rowId: string;
  canonicalResult: Record<string, unknown>;
  outboxEvent: OutboxEventInput;
}): Promise<void> {
  try {
    await settleOperation(db, {
      rowId: args.rowId,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: args.canonicalResult,
      outboxEvent: args.outboxEvent,
    });
  } catch (error) {
    await bestEffortLedgerWrite(() =>
      recordOperationAcceptance(db, {
        rowId: args.rowId,
        providerRef: prProviderRefFromCanonical(args.canonicalResult),
        canonicalResult: args.canonicalResult,
      })
    );
    console.error(
      `Failed to settle completed PR operation ledger row: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_SETTLE_FAILED_MESSAGE,
      cause: error,
    });
  }
}

/**
 * Durably marks a PR ledger row `reconcile_pending` with the deterministic
 * ambiguous outbox event. The ambiguous CONFLICT is surfaced ONLY after this
 * succeeds: if the persistence fails, the row stays `admitted` and a same-key
 * retry could re-execute a possibly-committed write, so a distinct
 * non-retryable persistence error is thrown instead of the ambiguous marker.
 */
async function markPrRowReconcilePendingDurably(args: {
  rowId: string;
  outboxEvent: OutboxEventInput;
}): Promise<void> {
  try {
    const updated = await markReconcilePending(db, {
      rowId: args.rowId,
      outboxEvent: args.outboxEvent,
    });
    if (!updated || updated.status !== 'reconcile_pending') {
      // The row is missing or was not `admitted` (for example already
      // terminal): the reconcile-pending guarantee does not hold, so the
      // ambiguous marker must never be surfaced. Throw the distinct
      // non-retryable persistence error instead.
      throw new Error('markReconcilePending did not leave the row reconcile_pending');
    }
  } catch (error) {
    console.error(
      `Failed to mark PR operation ledger row reconcile-pending: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: PR_LEDGER_PERSISTENCE_FAILED_MESSAGE,
      cause: error,
    });
  }
}

/**
 * Marks a PR ledger row `reconcile_pending` with the deterministic ambiguous
 * outbox event. Every unresolved reconciliation path MUST call this before
 * surfacing the ambiguous CONFLICT: the transition makes the reconciliation
 * lease immediately claimable and records the ambiguous outcome exactly once
 * (the outbox `event_uuid` is a deterministic UUIDv5 per row+event, so a row
 * that is already `reconcile_pending` — the event was emitted when the write
 * went ambiguous — is a no-op and never double-emits). A persistence failure
 * propagates as the distinct non-retryable persistence error so the ambiguous
 * marker is never surfaced without the reconcile-pending guarantee.
 */
async function markPrRowReconcilePending(args: {
  row: OperationLedgerRow;
  intent: PrLedgerIntent;
  distinctId: string;
  startedAt: number;
}): Promise<void> {
  await markPrRowReconcilePendingDurably({
    rowId: args.row.id,
    outboxEvent: prSettledOutboxEvent({
      distinctId: args.distinctId,
      intent: args.intent,
      outcome: 'ambiguous',
      reconcileResult: 'unresolved',
      startedAt: args.startedAt,
    }),
  });
}

/** Resolves the analytics identity channel (user email); falls back to the user id. */
async function resolvePrDistinctId(userId: string): Promise<string> {
  try {
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1);
    return user?.email ?? userId;
  } catch (error) {
    console.error(
      `Failed to resolve user email for PR outbox event: ${error instanceof Error ? error.message : String(error)}`
    );
    return userId;
  }
}

/** `pr_operation_settled` outbox payload (DEC-05): no free text, no resource keys. */
function prSettledOutboxEvent(params: {
  distinctId: string;
  intent: PrLedgerIntent;
  outcome: 'completed' | 'failed' | 'ambiguous';
  reconcileResult?: 'confirmed_completed' | 'confirmed_absent' | 'unresolved';
  startedAt: number;
}): OutboxEventInput {
  return {
    eventName: 'pr_operation_settled',
    distinctId: params.distinctId,
    properties: {
      source: 'web',
      surface: 'pr',
      phase: 'terminal',
      intent: params.intent,
      outcome: params.outcome,
      ...(params.reconcileResult !== undefined ? { reconcile_result: params.reconcileResult } : {}),
      duration_ms: Math.max(0, Date.now() - params.startedAt),
    },
  };
}

type PrLedgerMutationArgs<T> = {
  userId: string;
  intent: PrLedgerIntent;
  operationKey: string;
  /** Domain resource identity (`owner/repo#number`). Never enters analytics. */
  resourceKey: string;
  /** Epoch ms when the user intent started, used for the outbox duration. */
  startedAt: number;
  /** Runs the GitHub effect under an already-admitted row. */
  execute: (row: OperationLedgerRow) => Promise<T>;
  /** Reconcilies a same-key retry before any effect. */
  reconcile: (row: OperationLedgerRow) => Promise<T | ReplayedResult<T>>;
};

/** The canonical result replayed under the same key carries `replayed: true`. */
type ReplayedResult<T> = T & { replayed: true };

/**
 * Ledger orchestration for a PR mutation (P1-A-08c):
 * - `admitted`: run the effect and settle completed / failed / reconcile-pending.
 * - `duplicate_settled`: replay the sanitized canonical result marked replayed.
 * - `duplicate_in_flight` / `duplicate_reconcile_in_progress`: CONFLICT
 *   `operation_in_progress` (never re-execute).
 * - `takeover` / `duplicate_reconcile_pending`: reconcile before any effect.
 *
 * Cross-intent key reuse (P1-A-08d): the ledger identity is
 * `(user, domain, operation_key)` and `admitOperation` returns the row for
 * that key regardless of intent. Before ANY outcome is honored — replay,
 * reconcile, in-flight CONFLICT, or a fresh execute — the returned row is
 * compared against the request's intent and resource identity (which embeds
 * the request fingerprint). A mismatch means the same key is being reused for
 * a DIFFERENT PR intent/resource/request: the call is rejected with CONFLICT
 * `operation_key_reuse_mismatch` with no effect and no replay of the old
 * canonical result. Exact retries (same key, intent, and request fingerprint)
 * always match the stored row and keep their existing dedupe/replay/reconcile
 * behavior.
 */
async function runPrLedgerMutation<T>(
  args: PrLedgerMutationArgs<T>
): Promise<T | ReplayedResult<T>> {
  const admission = await admitOperation(db, {
    userId: args.userId,
    domain: PR_LEDGER_DOMAIN,
    intent: args.intent,
    operationKey: args.operationKey,
    resourceKey: args.resourceKey,
    taxonomy: 'reconcile-first',
    leaseSeconds: PR_LEDGER_LEASE_SECONDS,
  });

  if (admission.row.intent !== args.intent || admission.row.resource_key !== args.resourceKey) {
    throw operationKeyReuseMismatchError();
  }

  switch (admission.admission) {
    case 'admitted':
      return args.execute(admission.row);
    case 'duplicate_settled':
      return replaySettledPrRow<T>(admission.row);
    case 'duplicate_in_flight':
    case 'duplicate_reconcile_in_progress':
      throw operationInProgressError();
    case 'takeover':
    case 'duplicate_reconcile_pending':
      return args.reconcile(admission.row);
  }
}

/** Replays a terminal row: only `completed`/`no_op` may replay a canonical result. */
function replaySettledPrRow<T>(row: OperationLedgerRow): ReplayedResult<T> {
  if (row.status === 'completed' || row.status === 'no_op') {
    return { ...(row.canonical_result ?? {}), replayed: true } as ReplayedResult<T>;
  }
  // A settled `failed` row cannot be recovered under the same key: surface a
  // non-retryable typed rejection so the client starts a fresh intent.
  throw new TRPCError({ code: 'BAD_REQUEST', message: PR_REPLAY_FAILED_MESSAGE });
}

/** What the GitHub write reported back, and whether it must settle the row. */
type PrWriteOutcome<T> =
  | { kind: 'settle'; canonical: Record<string, unknown>; response: T }
  | { kind: 'no_settle'; response: T };

/** Coarse ledger outcome code derived from the classified tRPC error. */
function outcomeCodeFromTrpcError(error: unknown): string {
  if (error instanceof TRPCError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return 'not_found';
      case 'PRECONDITION_FAILED':
        return 'precondition_failed';
      case 'TOO_MANY_REQUESTS':
        return 'too_many_requests';
      case 'FORBIDDEN':
        return 'forbidden';
      case 'CONFLICT':
        return 'conflict';
      default:
        return 'bad_request';
    }
  }
  return 'unclassified';
}

/**
 * Runs the GitHub write under `withGitHubUserTokenRetry` and settles the
 * admitted row. Success settles `completed` at the committed-effect boundary;
 * a settle that fails after the commit surfaces a retryable server error
 * (never a success receipt for an un-recorded row). A deterministic GitHub
 * rejection settles `failed` and rethrows the classified error. An ambiguous
 * network/timeout/5xx failure (classified to BAD_GATEWAY before the existing
 * conversion) becomes `reconcile_pending` and surfaces the ambiguous outcome —
 * the write may have committed, so the row must never settle terminal under
 * this key; if the reconcile-pending persistence fails, a distinct
 * non-retryable persistence error is surfaced instead of the ambiguous marker.
 * A merge NOT_FOUND (the merge begins with an authoritative PR read) is
 * read-unavailable and therefore ambiguous too: it is never treated as a
 * confirmed rejection.
 */
async function executePrWriteWithLedger<T>(args: {
  userId: string;
  row: OperationLedgerRow;
  intent: PrLedgerIntent;
  startedAt: number;
  runWrite: (octokit: ReturnType<typeof createGitHubPrReviewOctokit>) => Promise<PrWriteOutcome<T>>;
}): Promise<T> {
  const distinctId = await resolvePrDistinctId(args.userId);
  let outcome: PrWriteOutcome<T>;
  try {
    outcome = await withGitHubUserTokenRetry({
      kiloUserId: args.userId,
      call: args.runWrite,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_GATEWAY') {
      await markPrRowReconcilePending({
        row: args.row,
        intent: args.intent,
        distinctId,
        startedAt: args.startedAt,
      });
      throw ambiguousPrError();
    }
    // A merge begins with an authoritative PR read (`pulls.get`). A NOT_FOUND
    // there means the PR state is READ-unavailable, which is ambiguous — the
    // merge may or may not have committed — and must never settle the row
    // absent/terminal. Treat merge NOT_FOUND exactly like a failed read:
    // reconcile-pending + ambiguous, so a same-key retry keeps reconciling.
    // Comment/review writes keep NOT_FOUND as a deterministic rejection.
    if (args.intent === 'merge' && error instanceof TRPCError && error.code === 'NOT_FOUND') {
      await markPrRowReconcilePending({
        row: args.row,
        intent: args.intent,
        distinctId,
        startedAt: args.startedAt,
      });
      throw ambiguousPrError();
    }
    await bestEffortLedgerWrite(() =>
      settleOperation(db, {
        rowId: args.row.id,
        status: 'failed',
        outcomeCode: outcomeCodeFromTrpcError(error),
        outboxEvent: prSettledOutboxEvent({
          distinctId,
          intent: args.intent,
          outcome: 'failed',
          startedAt: args.startedAt,
        }),
      })
    );
    throw error;
  }
  if (outcome.kind === 'no_settle') {
    return outcome.response;
  }
  // The write committed: settle completed at the committed-effect boundary.
  // A settle failure must NEVER be caught by the write-failure path above
  // (which settles the row `failed` — a false "did not complete" for a
  // committed write). `settleCompletedPrRow` preserves the canonical evidence
  // and surfaces the retryable persistence error; a same-key retry reconciles
  // the committed outcome by the preserved reference.
  await settleCompletedPrRow({
    rowId: args.row.id,
    canonicalResult: outcome.canonical,
    outboxEvent: prSettledOutboxEvent({
      distinctId,
      intent: args.intent,
      outcome: 'completed',
      startedAt: args.startedAt,
    }),
  });
  return outcome.response;
}

/**
 * Reconcilies a comment/review row on a same-key retry. The write is never
 * re-executed under this key (a non-idempotent comment write could duplicate):
 * - a recorded provider reference is re-fetched; found → settle completed and
 *   replay; absent → settle failed and surface the ambiguous outcome;
 * - no provider reference was ever recorded (the write response was lost) →
 *   presence cannot be confirmed → stay reconcile-pending, no GitHub write.
 */
async function reconcileCommentPrRow<T>(args: {
  userId: string;
  row: OperationLedgerRow;
  intent: PrLedgerIntent;
  startedAt: number;
  providerRefOf: (canonical: Record<string, unknown>) => number | null;
  readRef: (
    octokit: ReturnType<typeof createGitHubPrReviewOctokit>,
    providerId: number
  ) => Promise<{ canonical: Record<string, unknown>; response: T }>;
}): Promise<ReplayedResult<T>> {
  const providerId = args.providerRefOf(args.row.canonical_result ?? {});
  const distinctId = await resolvePrDistinctId(args.userId);
  if (providerId === null) {
    // The write response was lost before a provider reference was recorded
    // (a takeover row or a reconcile-pending row without canonical data).
    // Presence cannot be confirmed and the write must NOT re-execute under
    // this key: mark reconcile-pending (emitting the deterministic ambiguous
    // outbox event) and surface the ambiguous outcome.
    await markPrRowReconcilePending({
      row: args.row,
      intent: args.intent,
      distinctId,
      startedAt: args.startedAt,
    });
    throw ambiguousPrError();
  }

  let read:
    | {
        confirmed: 'found';
        canonical: Record<string, unknown>;
        response: T;
      }
    | { confirmed: 'absent' }
    | { confirmed: 'unresolved' };
  try {
    const { canonical, response } = await withGitHubUserTokenRetry({
      kiloUserId: args.userId,
      call: octokit => args.readRef(octokit, providerId),
    });
    read = { confirmed: 'found', canonical, response };
  } catch (error) {
    read =
      error instanceof TRPCError && error.code === 'NOT_FOUND'
        ? { confirmed: 'absent' }
        : { confirmed: 'unresolved' };
  }

  if (read.confirmed === 'found') {
    await settleCompletedPrRow({
      rowId: args.row.id,
      canonicalResult: read.canonical,
      outboxEvent: prSettledOutboxEvent({
        distinctId,
        intent: args.intent,
        outcome: 'completed',
        reconcileResult: 'confirmed_completed',
        startedAt: args.startedAt,
      }),
    });
    return { ...read.response, replayed: true };
  }
  if (read.confirmed === 'absent') {
    await bestEffortLedgerWrite(() =>
      settleOperation(db, {
        rowId: args.row.id,
        status: 'failed',
        outcomeCode: 'effect_absent',
        outboxEvent: prSettledOutboxEvent({
          distinctId,
          intent: args.intent,
          outcome: 'failed',
          reconcileResult: 'confirmed_absent',
          startedAt: args.startedAt,
        }),
      })
    );
    throw ambiguousPrError();
  }
  // `unresolved`: the provider reference read failed (network/timeout/5xx/…
  // anything but a definitive NOT_FOUND). The effect's presence is unknown,
  // so the row stays reconcile-pending (emitting the deterministic ambiguous
  // outbox event) and the ambiguous outcome is surfaced — never a terminal
  // settle from a failed read.
  await markPrRowReconcilePending({
    row: args.row,
    intent: args.intent,
    distinctId,
    startedAt: args.startedAt,
  });
  throw ambiguousPrError();
}

/**
 * Reconcilies a merge row on a same-key retry using authoritative PR state and
 * the expected head lineage (P1-A-08c):
 * - PR merged → settle completed and replay;
 * - PR closed without a merge, or the head moved → the fenced merge never
 *   committed → settle failed (`confirmed_absent`) and surface a conflict;
 * - PR open with the expected head sha intact → the merge never committed →
 *   re-execute the merge under the same row (takeover);
 * - the authoritative read failed → stay reconcile-pending, surface ambiguous.
 */
async function reconcileMergePrRow<T>(args: {
  userId: string;
  row: OperationLedgerRow;
  startedAt: number;
  owner: string;
  repo: string;
  number: number;
  expectedHeadSha: string;
  execute: (row: OperationLedgerRow) => Promise<T>;
}): Promise<T | ReplayedResult<T>> {
  type MergeReconcileState =
    | { kind: 'merged'; sha: string | null }
    | { kind: 'closed_unmerged' }
    | { kind: 'lineage_intact' }
    | { kind: 'stale_head' }
    | { kind: 'unresolved' };

  let reconcile: MergeReconcileState = { kind: 'unresolved' };
  try {
    reconcile = await withGitHubUserTokenRetry({
      kiloUserId: args.userId,
      call: async octokit => {
        const prResp = await octokit.pulls.get({
          owner: args.owner,
          repo: args.repo,
          pull_number: args.number,
        });
        const pr = prResp.data;
        if (pr.state === 'closed' && pr.merged === true) {
          return {
            kind: 'merged',
            sha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
          } satisfies MergeReconcileState;
        }
        if (pr.state === 'closed') {
          return { kind: 'closed_unmerged' } satisfies MergeReconcileState;
        }
        const headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : null;
        return (
          headSha !== null && headSha === args.expectedHeadSha
            ? { kind: 'lineage_intact' }
            : { kind: 'stale_head' }
        ) satisfies MergeReconcileState;
      },
    });
  } catch {
    // A failed authoritative read — including a GitHub NOT_FOUND (PR missing,
    // access revoked, or a transient API failure) — leaves the state
    // `unresolved`. NOT_FOUND is a READ failure, never a confirmed
    // non-merge: only explicit provider state (`closed` without `merged:
    // true`) settles the row absent.
  }

  const distinctId = await resolvePrDistinctId(args.userId);
  switch (reconcile.kind) {
    case 'merged': {
      const canonical = {
        merged: true,
        sha: reconcile.sha ?? 'unknown',
        branchDeleted: false,
      };
      await settleCompletedPrRow({
        rowId: args.row.id,
        canonicalResult: canonical,
        outboxEvent: prSettledOutboxEvent({
          distinctId,
          intent: 'merge',
          outcome: 'completed',
          reconcileResult: 'confirmed_completed',
          startedAt: args.startedAt,
        }),
      });
      return { ...canonical, replayed: true } as unknown as ReplayedResult<T>;
    }
    case 'closed_unmerged':
    case 'stale_head':
      await bestEffortLedgerWrite(() =>
        settleOperation(db, {
          rowId: args.row.id,
          status: 'failed',
          outcomeCode: reconcile.kind === 'closed_unmerged' ? 'already_closed' : 'head_moved',
          outboxEvent: prSettledOutboxEvent({
            distinctId,
            intent: 'merge',
            outcome: 'failed',
            reconcileResult: 'confirmed_absent',
            startedAt: args.startedAt,
          }),
        })
      );
      throw conflictPrError();
    case 'lineage_intact':
      return args.execute(args.row);
    case 'unresolved':
      // The authoritative read failed: the merge may or may not have
      // committed. Mark reconcile-pending (emitting the deterministic
      // ambiguous outbox event) and surface the ambiguous outcome; the row
      // is NEVER settled absent from a failed read.
      await markPrRowReconcilePending({
        row: args.row,
        intent: 'merge',
        distinctId,
        startedAt: args.startedAt,
      });
      throw ambiguousPrError();
  }
}

/**
 * The merge effect body shared by the legacy and ledger paths: fetch the PR to
 * derive the authoritative head ref/sha/same-repo identity, merge fenced on
 * `expectedHeadSha`, then best-effort delete the same-repo head branch. The
 * branch-delete error text stays in the response only — it is free text and
 * must never enter the ledger `canonical_result`.
 */
type MergeWriteResult =
  | { merged: boolean; sha: string; branchDeleted: false }
  | { merged: true; sha: string; branchDeleted: true }
  | { merged: true; sha: string; branchDeleted: false; branchDeleteError: string };

async function runMergeWrite(
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>,
  input: z.infer<typeof MergePullRequestInput>
): Promise<MergeWriteResult> {
  const prResp = await octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
  });
  const pr = prResp.data;
  const headRepo = pr.head?.repo ?? null;
  const baseRepo = pr.base?.repo ?? null;
  const sameRepo =
    headRepo !== null &&
    baseRepo !== null &&
    typeof headRepo.id === 'number' &&
    typeof baseRepo.id === 'number' &&
    headRepo.id === baseRepo.id;
  const fetchedHeadSha = typeof pr.head?.sha === 'string' ? pr.head.sha : null;
  const headRefName = typeof pr.head?.ref === 'string' ? pr.head.ref : null;

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
  if (!merged) {
    return { merged: false as const, sha: response.data.sha, branchDeleted: false as const };
  }
  if (
    !input.deleteBranch ||
    !sameRepo ||
    headRefName === null ||
    fetchedHeadSha === null ||
    fetchedHeadSha !== input.expectedHeadSha
  ) {
    return { merged: true as const, sha: response.data.sha, branchDeleted: false as const };
  }
  try {
    await octokit.git.deleteRef(
      buildDeleteRefParams({
        owner: input.owner,
        repo: input.repo,
        headRef: headRefName,
      })
    );
    return { merged: true as const, sha: response.data.sha, branchDeleted: true as const };
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
}

/** Ledger view of the merge write: declined merges never settle the row. */
async function runMergeLedgerWrite(
  octokit: ReturnType<typeof createGitHubPrReviewOctokit>,
  input: z.infer<typeof MergePullRequestInput>
): Promise<PrWriteOutcome<MergeWriteResult>> {
  const result = await runMergeWrite(octokit, input);
  if (result.merged) {
    return {
      kind: 'settle',
      canonical: { merged: true, sha: result.sha, branchDeleted: result.branchDeleted },
      response: result,
    };
  }
  return { kind: 'no_settle', response: result };
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
          repository: {
            pullRequest: { reviewDecision: string | null } | null;
          } | null;
          viewer: { login: string } | null;
        };
        let graphQl: OverviewGraphQl | null = null;
        try {
          const gqlResp = (await octokit.request('POST /graphql', {
            query: PULL_REQUEST_FRAGMENT_QUERY,
            variables: {
              owner: input.owner,
              name: input.repo,
              number: input.number,
            },
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
        const isFirstPage = input.cursor == null;
        const [connection, conversation] = await Promise.all([
          fetchReviewThreadsPage({
            octokit,
            owner: input.owner,
            repo: input.repo,
            number: input.number,
            cursor: input.cursor ?? null,
          }),
          // Conversation comments only on the first page; cursored pages get [].
          isFirstPage
            ? fetchAllConversationComments({
                octokit,
                owner: input.owner,
                repo: input.repo,
                number: input.number,
              })
            : Promise.resolve([]),
        ]);
        if (!connection) {
          return buildReviewThreadsResult({
            threads: [],
            conversation,
            page: 1,
            hasNextPage: false,
            endCursor: null,
          });
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
              diffHunk: node.comments.nodes[0]?.diffHunk ?? null,
              comments,
            };
          })
        );
        return buildReviewThreadsResult({
          threads: threads as never,
          conversation,
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
      if (input.operationKey === undefined) {
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
      }

      const startedAt = Date.now();
      return runPrLedgerMutation({
        userId: ctx.user.id,
        intent: 'create_review_comment',
        operationKey: input.operationKey,
        resourceKey: prLedgerResourceKey('create_review_comment', input),
        startedAt,
        execute: row =>
          executePrWriteWithLedger({
            userId: ctx.user.id,
            row,
            intent: 'create_review_comment',
            startedAt,
            runWrite: async octokit => {
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
              const canonical = { commentId: response.data.id, nodeId: response.data.node_id };
              return { kind: 'settle', canonical, response: { ...canonical } };
            },
          }),
        reconcile: row =>
          reconcileCommentPrRow({
            userId: ctx.user.id,
            row,
            intent: 'create_review_comment',
            startedAt,
            providerRefOf: canonical =>
              typeof canonical.commentId === 'number' ? canonical.commentId : null,
            readRef: async (octokit, providerId) => {
              const response = await octokit.pulls.getReviewComment({
                owner: input.owner,
                repo: input.repo,
                comment_id: providerId,
              });
              const canonical = { commentId: response.data.id, nodeId: response.data.node_id };
              return { canonical, response: { ...canonical } };
            },
          }),
      });
    }),

  // Reply to an existing review comment (creates a child comment in the
  // same thread).
  replyToComment: baseProcedure.input(ReplyToCommentInput).mutation(async ({ ctx, input }) => {
    if (input.operationKey === undefined) {
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
    }

    const startedAt = Date.now();
    return runPrLedgerMutation({
      userId: ctx.user.id,
      intent: 'reply_comment',
      operationKey: input.operationKey,
      resourceKey: prLedgerResourceKey('reply_comment', input),
      startedAt,
      execute: row =>
        executePrWriteWithLedger({
          userId: ctx.user.id,
          row,
          intent: 'reply_comment',
          startedAt,
          runWrite: async octokit => {
            const params = buildReplyToCommentParams({
              owner: input.owner,
              repo: input.repo,
              number: input.number,
              commentId: input.commentId,
              body: input.body,
            });
            const response = await octokit.pulls.createReplyForReviewComment(params);
            const canonical = { commentId: response.data.id, nodeId: response.data.node_id };
            return { kind: 'settle', canonical, response: { ...canonical } };
          },
        }),
      reconcile: row =>
        reconcileCommentPrRow({
          userId: ctx.user.id,
          row,
          intent: 'reply_comment',
          startedAt,
          providerRefOf: canonical =>
            typeof canonical.commentId === 'number' ? canonical.commentId : null,
          readRef: async (octokit, providerId) => {
            const response = await octokit.pulls.getReviewComment({
              owner: input.owner,
              repo: input.repo,
              comment_id: providerId,
            });
            const canonical = { commentId: response.data.id, nodeId: response.data.node_id };
            return { canonical, response: { ...canonical } };
          },
        }),
    });
  }),

  // Submit a pending review with an optional batch of inline comments and
  // an overall event (APPROVE / REQUEST_CHANGES / COMMENT).
  submitReview: baseProcedure.input(SubmitReviewInput).mutation(async ({ ctx, input }) => {
    if (input.operationKey === undefined) {
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
    }

    const startedAt = Date.now();
    return runPrLedgerMutation({
      userId: ctx.user.id,
      intent: 'submit_review',
      operationKey: input.operationKey,
      resourceKey: prLedgerResourceKey('submit_review', input),
      startedAt,
      execute: row =>
        executePrWriteWithLedger({
          userId: ctx.user.id,
          row,
          intent: 'submit_review',
          startedAt,
          runWrite: async octokit => {
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
            // The confirmed `state` is part of the canonical result (a bounded
            // GitHub enum, not free text) so a replayed submitReview carries
            // the same shape the client requires on first execution.
            const canonical = {
              reviewId: response.data.id,
              nodeId: response.data.node_id,
              state: response.data.state,
            };
            return {
              kind: 'settle',
              canonical,
              response: { ...canonical },
            };
          },
        }),
      reconcile: row =>
        reconcileCommentPrRow({
          userId: ctx.user.id,
          row,
          intent: 'submit_review',
          startedAt,
          providerRefOf: canonical =>
            typeof canonical.reviewId === 'number' ? canonical.reviewId : null,
          readRef: async (octokit, providerId) => {
            const response = await octokit.pulls.getReview({
              owner: input.owner,
              repo: input.repo,
              pull_number: input.number,
              review_id: providerId,
            });
            const canonical = {
              reviewId: response.data.id,
              nodeId: response.data.node_id,
              state: response.data.state,
            };
            return { canonical, response: { ...canonical } };
          },
        }),
    });
  }),

  // Resolve a review thread (GraphQL — there is no REST endpoint for this).
  resolveThread: baseProcedure.input(ThreadIdInput).mutation(async ({ ctx, input }) => {
    const result = await withGitHubUserTokenRetry({
      kiloUserId: ctx.user.id,
      call: async octokit => {
        const variables = buildResolveThreadVariables({
          threadId: input.threadId,
        });
        const payload = await runGraphQlMutation<{
          resolveReviewThread: {
            thread: { id: string; isResolved: boolean };
          } | null;
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
        const variables = buildUnresolveThreadVariables({
          threadId: input.threadId,
        });
        const payload = await runGraphQlMutation<{
          unresolveReviewThread: {
            thread: { id: string; isResolved: boolean };
          } | null;
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
  //
  // P0-D-09: the head ref + same-repo identity are derived from
  // `octokit.pulls.get` rather than the client input. A caller must not be
  // able to merge PR #N with a valid `expectedHeadSha` and then delete an
  // arbitrary same-repo ref (e.g. `main`) by spoofing `headRef`. The delete
  // is fenced on the server-derived head sha matching `expectedHeadSha`,
  // same-repo identity, and the merge actually completing.
  //
  // P1-A-08c: with an `operationKey`, the merge admits a `pr` row and
  // reconciles same-key retries against authoritative PR state and the
  // expected head lineage before ever re-merging. A declined merge
  // (`merged: false`) deliberately leaves the row admitted so a later retry
  // can reconcile and re-execute instead of blindly re-merging.
  mergePullRequest: baseProcedure.input(MergePullRequestInput).mutation(async ({ ctx, input }) => {
    if (input.operationKey === undefined) {
      return withGitHubUserTokenRetry({
        kiloUserId: ctx.user.id,
        call: octokit => runMergeWrite(octokit, input),
      });
    }

    const startedAt = Date.now();
    const execute = (row: OperationLedgerRow) =>
      executePrWriteWithLedger({
        userId: ctx.user.id,
        row,
        intent: 'merge',
        startedAt,
        runWrite: octokit => runMergeLedgerWrite(octokit, input),
      });
    return runPrLedgerMutation({
      userId: ctx.user.id,
      intent: 'merge',
      operationKey: input.operationKey,
      resourceKey: prLedgerResourceKey('merge', input),
      startedAt,
      execute,
      reconcile: row =>
        reconcileMergePrRow({
          userId: ctx.user.id,
          row,
          startedAt,
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          expectedHeadSha: input.expectedHeadSha,
          execute,
        }),
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
        const variables = buildDisableAutoMergeVariables({
          prNodeId: input.prNodeId,
        });
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
