import 'server-only';

import { z } from 'zod';

export const GitHubPrReviewAuthorSchema = z
  .object({
    login: z.string().min(1),
    avatarUrl: z.string().url().nullable(),
  })
  .strict();

export const GitHubPrReviewOverviewSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    bodyMarkdown: z.string().nullable(),
    author: GitHubPrReviewAuthorSchema.nullable(),
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean(),
    baseRef: z.string(),
    headRef: z.string(),
    isCrossRepo: z.boolean(),
    headRepoFullName: z.string().nullable(),
    headSha: z.string().min(1),
    prNodeId: z.string().min(1),
    counts: z
      .object({
        commits: z.number().int().nonnegative(),
        changedFiles: z.number().int().nonnegative(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .strict(),
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().nullable(),
    autoMerge: z
      .object({
        method: z.string(),
      })
      .nullable(),
    reviewDecision: z.enum(['REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED']).nullable(),
    repo: z
      .object({
        allowMergeCommit: z.boolean(),
        allowSquashMerge: z.boolean(),
        allowRebaseMerge: z.boolean(),
        allowAutoMerge: z.boolean(),
        deleteBranchOnMerge: z.boolean(),
        allowUpdateBranch: z.boolean(),
        viewerCanPush: z.boolean(),
        viewerCanAdmin: z.boolean(),
        viewerLogin: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type GitHubPrReviewOverview = z.infer<typeof GitHubPrReviewOverviewSchema>;

export const GitHubPrReviewCheckRunSchema = z
  .object({
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().url().nullable(),
    appName: z.string().nullable(),
  })
  .strict();

export const GitHubPrReviewChecksResultSchema = z
  .object({
    checkRuns: z.array(GitHubPrReviewCheckRunSchema),
    rollup: z
      .object({
        total: z.number().int().nonnegative(),
        success: z.number().int().nonnegative(),
        failure: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type GitHubPrReviewChecksResult = z.infer<typeof GitHubPrReviewChecksResultSchema>;

export const GitHubPrReviewFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().nullable(),
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch: z.string().nullable(),
    patchMissing: z.boolean(),
  })
  .strict();
export type GitHubPrReviewFile = z.infer<typeof GitHubPrReviewFileSchema>;

export const GitHubPrReviewFilesResultSchema = z
  .object({
    files: z.array(GitHubPrReviewFileSchema),
    nextCursor: z.number().int().nullable(),
  })
  .strict();
export type GitHubPrReviewFilesResult = z.infer<typeof GitHubPrReviewFilesResultSchema>;

export const GitHubPrReviewFileLinesResultSchema = z
  .object({
    lines: z.array(z.string()),
    totalLines: z.number().int().nonnegative(),
  })
  .strict();
export type GitHubPrReviewFileLinesResult = z.infer<typeof GitHubPrReviewFileLinesResultSchema>;

export const GitHubPrReviewReactionSchema = z
  .object({
    content: z.string(),
    count: z.number().int().nonnegative(),
    viewerHasReacted: z.boolean(),
  })
  .strict();

export const GitHubPrReviewReviewCommentSchema = z
  .object({
    commentId: z.number().int().positive(),
    nodeId: z.string().min(1),
    author: GitHubPrReviewAuthorSchema.nullable(),
    bodyMarkdown: z.string(),
    createdAt: z.string(),
    reactions: z.array(GitHubPrReviewReactionSchema),
  })
  .strict();

export const GitHubPrReviewReviewThreadSchema = z
  .object({
    threadId: z.string().min(1),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    subjectType: z.enum(['LINE', 'FILE']),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    startLine: z.number().int().nullable(),
    originalLine: z.number().int().nullable(),
    originalStartLine: z.number().int().nullable(),
    diffSide: z.enum(['LEFT', 'RIGHT']).nullable(),
    comments: z.array(GitHubPrReviewReviewCommentSchema),
  })
  .strict();
export type GitHubPrReviewReviewThread = z.infer<typeof GitHubPrReviewReviewThreadSchema>;

export const GitHubPrReviewReviewThreadsResultSchema = z
  .object({
    threads: z.array(GitHubPrReviewReviewThreadSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type GitHubPrReviewReviewThreadsResult = z.infer<
  typeof GitHubPrReviewReviewThreadsResultSchema
>;

export const FILES_PAGE_SIZE = 50;
export const FILES_MAX_PAGES = 60;
export const FILE_LINES_MAX = 500;
export const REVIEW_THREADS_PAGE_SIZE = 50;
export const REVIEW_THREAD_COMMENTS_PAGE_SIZE = 50;
