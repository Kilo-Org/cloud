import 'server-only';

import * as z from 'zod';

// Single source of truth for the GitHub reaction enum so Zod validation and
// GraphQL variable builders stay aligned with what the GitHub GraphQL API
// actually accepts. GitHub rejects unknown content strings with a 400.
export const REACTION_CONTENTS = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
] as const;
export const ReactionContentSchema = z.enum(REACTION_CONTENTS);
export type ReactionContent = z.infer<typeof ReactionContentSchema>;

// `pulls.createReview.event` — the only three legal values for a batch submit.
export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
export const ReviewEventSchema = z.enum(REVIEW_EVENTS);
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

// `pulls.merge.merge_method` — the three merge strategies surfaced to the UI.
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export const MergeMethodSchema = z.enum(MERGE_METHODS);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

// GitHub's `PullRequestAutoMergeMethod` (GraphQL) — independent of the REST
// `merge_method` casing above, so we keep a separate constant.
export const AUTO_MERGE_METHODS = ['MERGE', 'REBASE', 'SQUASH'] as const;
export const AutoMergeMethodSchema = z.enum(AUTO_MERGE_METHODS);
export type AutoMergeMethod = z.infer<typeof AutoMergeMethodSchema>;

// Diff side used by both single-line comments and multi-line review comments.
export const ReviewSideSchema = z.enum(['LEFT', 'RIGHT']);
export type ReviewSide = z.infer<typeof ReviewSideSchema>;

// A single position on a diff — used for both an immediate single comment and
// one entry inside the `submitReview` batch. `startLine`/`startSide` are only
// set for multi-line (range) comments.
export const CommentPositionSchema = z
  .object({
    path: z.string().min(1).max(1024),
    line: z.number().int().positive(),
    side: ReviewSideSchema,
    startLine: z.number().int().positive().optional(),
    startSide: ReviewSideSchema.optional(),
  })
  .strict()
  .refine(value => value.startLine === undefined || value.startLine <= value.line, {
    message: 'startLine must be <= line',
    path: ['startLine'],
  })
  // A multi-line range requires BOTH startLine and startSide (or neither);
  // GitHub rejects a partially specified range.
  .refine(value => (value.startLine === undefined) === (value.startSide === undefined), {
    message: 'startLine and startSide must be provided together',
    path: ['startSide'],
  });
export type CommentPosition = z.infer<typeof CommentPositionSchema>;

// Pure input builders — return the typed values the procedures will hand to
// Octokit. They exist so Zod parsing and GraphQL variable construction can be
// unit-tested without spinning up an Octokit instance.

// `pulls.createReviewComment` body. `commitSha` pins the comment to a specific
// commit, matching what the mobile overview already has on hand.
export type CreateReviewCommentInput = {
  owner: string;
  repo: string;
  number: number;
  body: string;
  commitSha: string;
  path: string;
  line: number;
  side: ReviewSide;
  startLine?: number;
  startSide?: ReviewSide;
};

export function buildCreateReviewCommentParams(input: CreateReviewCommentInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
    body: input.body,
    commit_id: input.commitSha,
    path: input.path,
    line: input.line,
    side: input.side,
    ...(input.startLine !== undefined ? { start_line: input.startLine } : {}),
    ...(input.startSide !== undefined ? { start_side: input.startSide } : {}),
  };
}

// `pulls.createReplyForReviewComment` body.
export type ReplyToCommentInput = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  body: string;
};

export function buildReplyToCommentParams(input: ReplyToCommentInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
    comment_id: input.commentId,
    body: input.body,
  };
}

// `pulls.createReview` body. The mobile client queues a small batch of
// comments and submits them in one call together with an event.
export type SubmitReviewInput = {
  owner: string;
  repo: string;
  number: number;
  event: ReviewEvent;
  body?: string;
  commitSha: string;
  comments?: ReadonlyArray<{
    path: string;
    line: number;
    side: ReviewSide;
    startLine?: number;
    startSide?: ReviewSide;
    body: string;
  }>;
};

export function buildSubmitReviewParams(input: SubmitReviewInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
    event: input.event,
    commit_id: input.commitSha,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.comments && input.comments.length > 0
      ? {
          comments: input.comments.map(c => ({
            path: c.path,
            line: c.line,
            side: c.side,
            ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
            ...(c.startSide !== undefined ? { start_side: c.startSide } : {}),
            body: c.body,
          })),
        }
      : {}),
  };
}

// `pulls.merge` body. The client supplies `headRef` + `isCrossRepo` so we
// don't need an extra round-trip to discover whether the head lives in the
// same repo (and therefore whether `git.deleteRef` is permitted).
export type MergePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  method: MergeMethod;
  commitTitle?: string;
  commitMessage?: string;
  deleteBranch: boolean;
  expectedHeadSha: string;
  headRef: string;
  isCrossRepo: boolean;
};

// Narrowed view used by the GitHub-API param builder — the merge call only
// needs the fields GitHub accepts; the extra context (`deleteBranch`/`headRef`
// /`isCrossRepo`) is consumed by the procedure after `pulls.merge` succeeds.
export type BuildMergePullRequestParamsInput = {
  owner: string;
  repo: string;
  number: number;
  method: MergeMethod;
  commitTitle?: string;
  commitMessage?: string;
  expectedHeadSha: string;
};

export function buildMergePullRequestParams(input: BuildMergePullRequestParamsInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
    merge_method: input.method,
    sha: input.expectedHeadSha,
    ...(input.commitTitle !== undefined ? { commit_title: input.commitTitle } : {}),
    ...(input.commitMessage !== undefined ? { commit_message: input.commitMessage } : {}),
  };
}

// `pulls.updateBranch` body.
export type UpdateBranchInput = {
  owner: string;
  repo: string;
  number: number;
  expectedHeadSha: string;
};

export function buildUpdateBranchParams(input: UpdateBranchInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
    expected_head_sha: input.expectedHeadSha,
  };
}

// `git.deleteRef` body for best-effort branch delete after a successful merge.
export function buildDeleteRefParams(input: { owner: string; repo: string; headRef: string }) {
  return {
    owner: input.owner,
    repo: input.repo,
    ref: `heads/${input.headRef}`,
  };
}

// GraphQL variable builders — return the plain variable object so callers can
// hand it directly to `octokit.request('POST /graphql', { query, ...vars })`.

export function buildEnableAutoMergeVariables(input: {
  prNodeId: string;
  method: AutoMergeMethod;
  commitTitle?: string;
  commitMessage?: string;
}) {
  return {
    input: {
      pullRequestId: input.prNodeId,
      mergeMethod: input.method,
      ...(input.commitTitle !== undefined ? { commitHeadline: input.commitTitle } : {}),
      ...(input.commitMessage !== undefined ? { commitBody: input.commitMessage } : {}),
    },
  };
}

export function buildDisableAutoMergeVariables(input: { prNodeId: string }) {
  return { input: { pullRequestId: input.prNodeId } };
}

export function buildResolveThreadVariables(input: { threadId: string }) {
  return { input: { threadId: input.threadId } };
}

export function buildUnresolveThreadVariables(input: { threadId: string }) {
  return { input: { threadId: input.threadId } };
}

export function buildAddReactionVariables(input: {
  commentNodeId: string;
  content: ReactionContent;
}) {
  return { input: { subjectId: input.commentNodeId, content: input.content } };
}

export function buildRemoveReactionVariables(input: {
  commentNodeId: string;
  content: ReactionContent;
}) {
  return { input: { subjectId: input.commentNodeId, content: input.content } };
}
