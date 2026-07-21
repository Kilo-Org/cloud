import 'server-only';

import { z } from 'zod';

import {
  FILES_MAX_PAGES,
  REVIEW_THREADS_PAGE_SIZE,
  type GitHubPrReviewChecksResult,
  type GitHubPrReviewFile,
  type GitHubPrReviewFilesResult,
  type GitHubPrReviewReviewThread,
  type GitHubPrReviewReviewThreadsResult,
  GitHubPrReviewFilesResultSchema,
  GitHubPrReviewReviewThreadsResultSchema,
} from './dtos';
import {
  GitHubPrReviewAuthorSchema,
  GitHubPrReviewOverviewSchema,
  type GitHubPrReviewOverview,
} from './dtos';

export type PullRequestRestData = {
  number: number;
  title: string;
  body: string | null;
  user: { login: string; avatar_url: string } | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  base: { ref: string; repo?: { full_name: string } | null };
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  node_id: string;
  commits: number;
  changed_files: number;
  additions: number;
  deletions: number;
  mergeable: boolean | null;
  mergeable_state?: string | null;
  auto_merge?: { merge_method?: string | null } | null;
};

export type RepoRestData = {
  allow_merge_commit?: boolean | null;
  allow_squash_merge?: boolean | null;
  allow_rebase_merge?: boolean | null;
  allow_auto_merge?: boolean | null;
  delete_branch_on_merge?: boolean | null;
  allow_update_branch?: boolean | null;
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } | null;
};

export type ViewerInfo = { login: string } | null;

export type OverviewGraphQlData = {
  repository: {
    pullRequest: {
      reviewDecision: string | null;
    } | null;
  } | null;
  viewer: { login: string } | null;
} | null;

function normalizeReviewDecision(value: string | null): GitHubPrReviewOverview['reviewDecision'] {
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value;
  }
  return null;
}

const GitHubRestUserSchema = z
  .object({
    login: z.string().min(1),
    avatar_url: z.string().url(),
  })
  .strict();

export function buildOverviewDto(args: {
  pr: PullRequestRestData;
  repo: RepoRestData;
  graphQl: OverviewGraphQlData;
  viewer: ViewerInfo;
}): GitHubPrReviewOverview {
  const { pr, repo, graphQl, viewer } = args;
  const state: GitHubPrReviewOverview['state'] = pr.merged
    ? 'merged'
    : pr.state === 'open'
      ? 'open'
      : 'closed';
  const authorParsed = pr.user
    ? GitHubPrReviewAuthorSchema.safeParse({
        login: pr.user.login,
        avatarUrl: pr.user.avatar_url,
      })
    : null;
  const author = authorParsed?.success ? authorParsed.data : null;
  const headRepoFullName = pr.head.repo?.full_name ?? null;
  const isCrossRepo = Boolean(
    pr.base.repo?.full_name && headRepoFullName && pr.base.repo.full_name !== headRepoFullName
  );
  const autoMerge =
    pr.auto_merge && pr.auto_merge.merge_method ? { method: pr.auto_merge.merge_method } : null;
  const overview: GitHubPrReviewOverview = {
    number: pr.number,
    title: pr.title,
    bodyMarkdown: pr.body ?? null,
    author,
    state,
    draft: Boolean(pr.draft),
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    isCrossRepo,
    headRepoFullName,
    headSha: pr.head.sha,
    prNodeId: pr.node_id,
    counts: {
      commits: pr.commits,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state ?? null,
    autoMerge,
    reviewDecision: normalizeReviewDecision(
      graphQl?.repository?.pullRequest?.reviewDecision ?? null
    ),
    repo: {
      allowMergeCommit: Boolean(repo.allow_merge_commit),
      allowSquashMerge: Boolean(repo.allow_squash_merge),
      allowRebaseMerge: Boolean(repo.allow_rebase_merge),
      allowAutoMerge: Boolean(repo.allow_auto_merge),
      deleteBranchOnMerge: Boolean(repo.delete_branch_on_merge),
      allowUpdateBranch: Boolean(repo.allow_update_branch),
      viewerCanPush: Boolean(repo.permissions?.push),
      viewerCanAdmin: Boolean(repo.permissions?.admin),
      viewerLogin: viewer?.login ?? null,
    },
  };
  return GitHubPrReviewOverviewSchema.parse(overview);
}

const GitHubCheckRunRestSchema = z
  .object({
    name: z.string().min(1),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    details_url: z.string().url().nullable().optional(),
    html_url: z.string().url().nullable().optional(),
    app: z
      .object({
        name: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

type CheckRunInput = z.infer<typeof GitHubCheckRunRestSchema>;

export function buildChecksResult(args: {
  checkRuns: CheckRunInput[];
  commitStatuses: Array<{
    context: string;
    state: string;
    target_url: string | null;
    updated_at: string | null;
  }>;
}): GitHubPrReviewChecksResult {
  const checkRunDtos = args.checkRuns.map(c => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion ?? null,
    detailsUrl: c.details_url ?? c.html_url ?? null,
    appName: c.app?.name ?? null,
  }));
  // Dedupe commit statuses per context, keeping the latest by updated_at.
  const byContext = new Map<string, (typeof args.commitStatuses)[number]>();
  for (const status of args.commitStatuses) {
    const existing = byContext.get(status.context);
    if (!existing) {
      byContext.set(status.context, status);
      continue;
    }
    const existingTime = existing.updated_at ? Date.parse(existing.updated_at) : 0;
    const nextTime = status.updated_at ? Date.parse(status.updated_at) : 0;
    if (nextTime >= existingTime) {
      byContext.set(status.context, status);
    }
  }
  const statusDtos = Array.from(byContext.values()).map(s => ({
    name: s.context,
    // A commit status is only terminal for success/failure/error states; a
    // `pending` state must remain non-completed so the rollup counts it.
    status: s.state === 'pending' ? 'pending' : 'completed',
    conclusion: s.state,
    detailsUrl: s.target_url,
    appName: null,
  }));
  const merged = [...checkRunDtos, ...statusDtos];
  const rollup = {
    total: merged.length,
    success: merged.filter(c => rollupState(c.status, c.conclusion) === 'success').length,
    failure: merged.filter(c => rollupState(c.status, c.conclusion) === 'failure').length,
    pending: merged.filter(c => rollupState(c.status, c.conclusion) === 'pending').length,
    skipped: merged.filter(c => rollupState(c.status, c.conclusion) === 'skipped').length,
  };
  return { checkRuns: merged, rollup };
}

// Classify a merged check/status into exactly one rollup bucket. Anything that
// has not reached a terminal conclusion (non-completed status, or completed
// with a null/unknown conclusion) counts as pending so no check is dropped.
function rollupState(
  status: string,
  conclusion: string | null
): 'success' | 'failure' | 'pending' | 'skipped' {
  if (status !== 'completed') return 'pending';
  const value = conclusion ?? '';
  if (/^success$/i.test(value)) return 'success';
  if (/failure|error|cancelled|timed_out|action_required|stale/i.test(value)) return 'failure';
  if (/skipped|neutral/i.test(value)) return 'skipped';
  return 'pending';
}

type PullRequestFileInput = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export function buildFilesPage(args: {
  page: number;
  perPage: number;
  rawFiles: PullRequestFileInput[];
}): GitHubPrReviewFilesResult {
  const { page, perPage, rawFiles } = args;
  const clampedPage = Math.max(1, Math.min(FILES_MAX_PAGES, page));
  const files: GitHubPrReviewFile[] = rawFiles.map(f => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
    patchMissing: !f.patch,
  }));
  const reachedCap = clampedPage >= FILES_MAX_PAGES;
  const shortPage = files.length < perPage;
  const nextCursor = shortPage || reachedCap ? null : clampedPage + 1;
  return GitHubPrReviewFilesResultSchema.parse({ files, nextCursor });
}

export function sliceFileLines(args: { rawContent: string; startLine: number; endLine: number }): {
  lines: string[];
  totalLines: number;
} {
  const { rawContent, startLine, endLine } = args;
  const all = rawContent.split(/\r?\n/);
  const totalLines = all.length;
  const start = Math.max(1, startLine);
  const requestedEnd = Math.max(start, endLine);
  const cappedEnd = Math.min(requestedEnd, start + 500 - 1);
  const slice = all.slice(start - 1, cappedEnd);
  return { lines: slice, totalLines };
}

export type GraphQlReviewThreadInput = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  subjectType?: string | null;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  diffSide?: 'LEFT' | 'RIGHT' | null;
  comments: GraphQlReviewCommentInput[];
};

export type GraphQlReviewCommentInput = {
  databaseId: number;
  id: string;
  author: { login: string; avatarUrl: string } | null;
  body: string;
  createdAt: string;
  reactions: Array<{ content: string; count: number; viewerHasReacted: boolean }>;
};

export function buildReviewThreadsResult(args: {
  threads: GraphQlReviewThreadInput[];
  page: number;
  hasNextPage: boolean;
  endCursor: string | null;
}): GitHubPrReviewReviewThreadsResult {
  const { threads, page, hasNextPage, endCursor } = args;
  const dtos: GitHubPrReviewReviewThread[] = threads.map(t => {
    const subjectType: 'LINE' | 'FILE' = t.subjectType === 'FILE' ? 'FILE' : 'LINE';
    const diffSide = t.diffSide === 'LEFT' || t.diffSide === 'RIGHT' ? t.diffSide : null;
    return {
      threadId: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      subjectType,
      path: t.path ?? null,
      line: t.line ?? null,
      startLine: t.startLine ?? null,
      originalLine: t.originalLine ?? null,
      originalStartLine: t.originalStartLine ?? null,
      diffSide,
      comments: t.comments.map(c => ({
        commentId: c.databaseId,
        nodeId: c.id,
        author: c.author ? { login: c.author.login, avatarUrl: c.author.avatarUrl } : null,
        bodyMarkdown: c.body,
        createdAt: c.createdAt,
        reactions: c.reactions.map(r => ({
          content: r.content,
          count: r.count,
          viewerHasReacted: r.viewerHasReacted,
        })),
      })),
    };
  });
  const nextCursor =
    hasNextPage && endCursor && page < Number.MAX_SAFE_INTEGER / REVIEW_THREADS_PAGE_SIZE
      ? endCursor
      : null;
  return GitHubPrReviewReviewThreadsResultSchema.parse({
    threads: dtos,
    nextCursor,
  });
}

export { GitHubRestUserSchema };
