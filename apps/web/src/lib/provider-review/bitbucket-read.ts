/**
 * Bitbucket Cloud pull-request READ layer for the provider review surfaces.
 *
 * Every function resolves credentials through bitbucket-authorization first,
 * so the workspace identity and the workspace access token are always
 * server-derived, and returns the shared s1 DTOs so a provider difference
 * never leaks past this module. Bitbucket paginates with opaque `next` URLs:
 * cursors are encoded server-side, every page re-authorizes against the org
 * integration, and a cursor — or a provider next URL — can never change the
 * workspace or repository identity a request reads.
 */
import 'server-only';

import { z } from 'zod';
import type {
  ProviderPrChecksResult,
  ProviderPrFile,
  ProviderPrFilesPage,
  ProviderPrInboxItem,
  ProviderPrInboxPage,
  ProviderPrMergeBlockedReason,
  ProviderPrMergeState,
  ProviderPrSummary,
  ProviderPrThread,
} from '@kilocode/app-shared/provider-review';
import {
  authorizeRepository,
  authorizeWorkspace,
  classifyBitbucketError,
  BitbucketApiStatusError,
  BitbucketReviewError,
  type BitbucketRepositoryAccess,
  type BitbucketReviewOwner,
} from './bitbucket-authorization';

const BITBUCKET_API_ORIGIN = 'https://api.bitbucket.org';
const BITBUCKET_PAGE_SIZE = 50;
const BITBUCKET_REQUEST_TIMEOUT_MS = 30_000;
/** Same response cap the GitLab read layer applies, so one response cannot stream unbounded bytes. */
const MAX_BITBUCKET_RESPONSE_BYTES = 10 * 1024 * 1024;
/**
 * The counts folded into the PR summary come from the diffstat; cap the pages
 * so one detail load can never fan out into an unbounded crawl on a huge pull
 * request (same rule as the GitLab detail load).
 */
const MAX_SUMMARY_DIFFSTAT_PAGES = 3;
/** The merge gate checks at most this many pages of the latest builds. */
const MAX_BUILD_PAGES = 3;
/** The inbox enumerates at most this many pages of this size of workspace repositories. */
const INBOX_REPOSITORY_PAGE_SIZE = 100;
const INBOX_REPOSITORY_PAGES = 3;
/** How many repository PR collections the inbox fetches at once. */
const INBOX_REPOSITORY_CONCURRENCY = 8;
/**
 * The task-collection page bound for the discussion task walk: the same
 * bounded walk the write layer's thread resolution uses, so one discussion
 * load can never crawl an unbounded collection.
 */
const MAX_TASK_COLLECTION_PAGES = 10;

const BitbucketUserSchema = z.object({
  uuid: z.string().min(1),
  display_name: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  links: z
    .object({ avatar: z.object({ href: z.string() }).nullable().optional() })
    .nullable()
    .optional(),
});

const BitbucketCommitSideSchema = z.object({
  branch: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  commit: z
    .object({ hash: z.string().min(1) })
    .nullable()
    .optional(),
  repository: z
    .object({
      full_name: z.string().min(3).optional(),
      uuid: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
});

/** The PR detail JSON carries more fields than the mapped subset. */
const BitbucketPullRequestDetailSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  draft: z.boolean().nullable().optional(),
  summary: z.object({ raw: z.string().nullable().optional() }).nullable().optional(),
  author: BitbucketUserSchema.nullable().optional(),
  source: BitbucketCommitSideSchema.nullable().optional(),
  destination: BitbucketCommitSideSchema.nullable().optional(),
  task_count: z.number().nullable().optional(),
  merge_state: z.string().nullable().optional(),
  created_on: z.string().nullable().optional(),
  updated_on: z.string().nullable().optional(),
  links: z
    .object({ html: z.object({ href: z.string() }).nullable().optional() })
    .nullable()
    .optional(),
  participants: z.array(z.unknown()).nullable().optional(),
});

type BitbucketPullRequestDetail = z.infer<typeof BitbucketPullRequestDetailSchema>;

const BitbucketDiffstatEntrySchema = z.object({
  status: z.string().nullable().optional(),
  lines_added: z.number().nullable().optional(),
  lines_removed: z.number().nullable().optional(),
  old: z
    .object({
      path: z.string().nullable().optional(),
      escaped_path: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  new: z
    .object({
      path: z.string().nullable().optional(),
      escaped_path: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const BitbucketCommentSchema = z.object({
  id: z.number(),
  parent: z.object({ id: z.number() }).nullable().optional(),
  content: z.object({ raw: z.string().nullable().optional() }).nullable().optional(),
  inline: z
    .object({
      path: z.string().nullable().optional(),
      from: z.number().nullable().optional(),
      to: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  created_on: z.string().nullable().optional(),
  deleted: z.boolean().nullable().optional(),
  user: BitbucketUserSchema.nullable().optional(),
});

const BitbucketBuildStatusSchema = z.object({
  state: z.string(),
  key: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  links: z
    .object({ status: z.object({ href: z.string() }).nullable().optional() })
    .nullable()
    .optional(),
});

const BitbucketTaskSchema = z.object({
  id: z.number(),
  resolved_on: z.string().nullable().optional(),
  comment: z.object({ id: z.number() }).nullable().optional(),
});

const BitbucketBranchRestrictionSchema = z.object({
  kind: z.string(),
  value: z.union([z.number(), z.string(), z.null()]).nullable().optional(),
});

const BitbucketParticipantSchema = z.object({
  user: BitbucketUserSchema.nullable().optional(),
  role: z.string().nullable().optional(),
  approved: z.boolean().nullable().optional(),
  state: z.string().nullable().optional(),
});

const BitbucketInboxPullRequestSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  draft: z.boolean().nullable().optional(),
  author: BitbucketUserSchema.nullable().optional(),
  updated_on: z.string().nullable().optional(),
  source: BitbucketCommitSideSchema.nullable().optional(),
  destination: BitbucketCommitSideSchema.nullable().optional(),
});

const BitbucketPageSchema = z.object({
  values: z.array(z.unknown()).default([]),
  next: z.string().nullable().optional(),
});

function mapPullRequestState(state: string): ProviderPrSummary['state'] {
  if (state === 'MERGED') return 'merged';
  if (state === 'OPEN') return 'open';
  return 'closed';
}

function mapUser(user: z.infer<typeof BitbucketUserSchema> | null | undefined) {
  if (!user) return null;
  const login = user.nickname ?? user.display_name ?? '';
  if (!login) return null;
  return { login, avatarUrl: user.links?.avatar?.href ?? null };
}

/**
 * One JSON request against api.bitbucket.org. The origin is fixed (Bitbucket
 * Cloud is SaaS-only — there is no self-managed URL to resolve) and the
 * bearer token is the server-derived workspace access token. Only the status
 * survives a provider failure, so no response body can leak into the error.
 */
export async function requestBitbucketJson<T>(
  access: { accessToken: string },
  path: string,
  request: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {}
): Promise<T> {
  if (!path.startsWith('/2.0/')) {
    throw new BitbucketReviewError('bad_request', 'Bitbucket request paths must use the 2.0 API.');
  }
  // The path is the full versioned API path; the origin contributes no
  // version prefix, so a double `/2.0/2.0/` segment can never be built.
  const url = new URL(`${BITBUCKET_API_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  try {
    const text = await fetchBoundedText(url.toString(), {
      accessToken: access.accessToken,
      method: request.method ?? 'GET',
      body: request.body,
    });
    if (text === null || text === '') return undefined as T;
    return JSON.parse(text) as T;
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * One bearer request with a bounded read: the body is streamed with a cap so
 * a hostile response cannot stream unbounded bytes (same rule as the GitLab
 * transport). Returns null for a bodyless 204/205/304.
 */
async function fetchBoundedText(
  url: string,
  request: {
    accessToken: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    accept?: string;
  }
): Promise<string | null> {
  const method = request.method ?? 'GET';
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${request.accessToken}`,
      Accept: request.accept ?? 'application/json',
      ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(BITBUCKET_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new BitbucketApiStatusError(
      response.status,
      `Bitbucket ${method} request failed: ${response.status}`
    );
  }
  if (response.status === 204 || response.status === 205 || response.status === 304) return null;
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected response.');
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BITBUCKET_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read remains failed if cancellation itself fails.
        }
        throw new BitbucketReviewError(
          'retryable',
          'The Bitbucket response exceeded the size limit.'
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** One raw-text request (the `/src` file endpoint answers plain text). */
async function requestBitbucketText(
  access: { accessToken: string },
  path: string
): Promise<string> {
  try {
    const text = await fetchBoundedText(`${BITBUCKET_API_ORIGIN}${path}`, {
      accessToken: access.accessToken,
      accept: '*/*',
    });
    return text ?? '';
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

function repositorySegment(repository: { fullName: string }): string {
  const [workspace, repoSlug] = repository.fullName.split('/');
  return `${encodeURIComponent(workspace ?? '')}/${encodeURIComponent(repoSlug ?? '')}`;
}

/**
 * A provider `next` URL is followed only when it stays on the Bitbucket API
 * origin under `/2.0/`. Anything else ends pagination — a hostile next link
 * must never re-target the bearer token.
 */
function validatedNextUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.bitbucket.org' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !url.pathname.startsWith('/2.0/') ||
    url.hash !== ''
  ) {
    return null;
  }
  return url.toString();
}

/**
 * A page cursor carries the collection identity it was minted for. A cursor
 * bound to another collection is ignored (page 1), so a cursor can never
 * switch the workspace or repository a request reads.
 */
function encodePageCursor(identity: string, nextUrl: string): string {
  return Buffer.from(JSON.stringify({ identity, next: nextUrl })).toString('base64url');
}

function decodePageCursor(
  cursor: string | undefined,
  identity: string
): { followUrl: string | null } {
  if (!cursor) return { followUrl: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      identity?: unknown;
      next?: unknown;
    };
    if (typeof parsed.identity !== 'string' || parsed.identity !== identity) {
      return { followUrl: null };
    }
    if (typeof parsed.next !== 'string') return { followUrl: null };
    return { followUrl: validatedNextUrl(parsed.next) };
  } catch {
    return { followUrl: null };
  }
}

function repositoryPathGuard(repository: BitbucketRepositoryAccess): (pathname: string) => boolean {
  const prefix = `/2.0/repositories/${encodeURIComponent(repository.workspace.slug)}/${encodeURIComponent(repository.repository.slug)}/`;
  return pathname => pathname.startsWith(prefix);
}

export { repositoryPathGuard };

/**
 * One page of any Bitbucket collection. When a cursor carries a validated
 * next URL the page is fetched there (with the caller's fresh token); the
 * next URL is followed only inside the guarded path space, so a cursor — or
 * a provider next link — can never change the collection a request reads.
 * Shared with the write layer, which paginates the task collection the same
 * way when it resolves a thread.
 */
export async function fetchPage(
  access: { accessToken: string },
  basePath: string,
  identity: string,
  cursor: string | undefined,
  pathGuard: (pathname: string) => boolean,
  extraQuery: Record<string, string | number | boolean> = {}
): Promise<{ values: unknown[]; nextCursor: string | null }> {
  const page = decodePageCursor(cursor, identity);
  let payload: unknown;
  if (page.followUrl) {
    const followUrl = new URL(page.followUrl);
    if (!pathGuard(followUrl.pathname)) return { values: [], nextCursor: null };
    try {
      const text = await fetchBoundedText(followUrl.toString(), {
        accessToken: access.accessToken,
      });
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      if (error instanceof BitbucketReviewError || error instanceof BitbucketApiStatusError) {
        throw error;
      }
      throw classifyBitbucketError(error);
    }
  } else {
    payload = await requestBitbucketJson<unknown>(access, basePath, {
      query: { pagelen: BITBUCKET_PAGE_SIZE, ...extraQuery },
    });
  }

  const parsed = BitbucketPageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected page.');
  }
  // validatedNextUrl never throws: a malformed provider next link ends
  // pagination instead of failing the page, and a next link outside the
  // guarded path space is dropped the same way.
  const nextUrl = validatedNextUrl(parsed.data.next ?? null);
  const guardedNext = nextUrl && pathGuard(new URL(nextUrl).pathname) ? nextUrl : null;
  return {
    values: parsed.data.values,
    nextCursor: guardedNext ? encodePageCursor(identity, guardedNext) : null,
  };
}

async function fetchPullRequestDetail(
  access: BitbucketRepositoryAccess,
  prId: number
): Promise<BitbucketPullRequestDetail> {
  const payload = await requestBitbucketJson<unknown>(
    access,
    `/2.0/repositories/${repositorySegment(access.repository)}/pullrequests/${prId}`
  );
  const parsed = BitbucketPullRequestDetailSchema.safeParse(payload);
  if (!parsed.success) {
    throw new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected pull request.');
  }
  return parsed.data;
}

function mapDiffstatEntry(entry: z.infer<typeof BitbucketDiffstatEntrySchema>): ProviderPrFile {
  const oldPath = entry.old?.escaped_path ?? entry.old?.path ?? null;
  const newPath = entry.new?.escaped_path ?? entry.new?.path ?? null;
  const path = newPath ?? oldPath ?? '';
  return {
    path,
    previousPath: oldPath !== null && oldPath !== path ? oldPath : null,
    status: entry.status ?? 'modified',
    additions: entry.lines_added ?? 0,
    deletions: entry.lines_removed ?? 0,
    patch: null,
    patchMissing: true,
  };
}

async function fetchDiffstatPage(
  access: BitbucketRepositoryAccess,
  prId: number,
  identity: string,
  cursor: string | undefined
): Promise<{ values: z.infer<typeof BitbucketDiffstatEntrySchema>[]; nextCursor: string | null }> {
  const page = await fetchPage(
    access,
    `/2.0/repositories/${repositorySegment(access.repository)}/pullrequests/${prId}/diffstat`,
    identity,
    cursor,
    repositoryPathGuard(access)
  );
  const values: z.infer<typeof BitbucketDiffstatEntrySchema>[] = [];
  for (const value of page.values) {
    const parsed = BitbucketDiffstatEntrySchema.safeParse(value);
    if (parsed.success) values.push(parsed.data);
  }
  return { values, nextCursor: page.nextCursor };
}

/**
 * The PR as the review screen renders it: detail with `source.commit.hash` as
 * the head sha, and change counts folded in from the first diffstat pages.
 */
export async function getPullRequest(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number
): Promise<ProviderPrSummary> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const identity = `bitbucket-pr:${access.repository.fullName}#${prId}`;
    const detail = await fetchPullRequestDetail(access, prId);
    // Counts come from the diffstat; cap the pages so one detail load can
    // never fan out into an unbounded crawl on a huge pull request.
    const files: z.infer<typeof BitbucketDiffstatEntrySchema>[] = [];
    let cursor: string | undefined = undefined;
    for (let page = 0; page < MAX_SUMMARY_DIFFSTAT_PAGES; page++) {
      const result = await fetchDiffstatPage(access, prId, identity, cursor);
      files.push(...result.values);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      const mapped = mapDiffstatEntry(file);
      additions += mapped.additions;
      deletions += mapped.deletions;
    }

    return {
      ref: {
        platform: 'bitbucket',
        workspace: access.workspace.slug,
        repoSlug: access.repository.slug,
        prId,
      },
      title: detail.title,
      body: detail.summary?.raw ?? null,
      author: mapUser(detail.author ?? null),
      state: mapPullRequestState(detail.state),
      draft: detail.draft === true,
      headRef: detail.source?.branch?.name ?? '',
      baseRef: detail.destination?.branch?.name ?? '',
      headSha: detail.source?.commit?.hash ?? '',
      changedFiles: files.length,
      additions,
      deletions,
      webUrl: detail.links?.html?.href ?? '',
      createdAt: detail.created_on ?? detail.updated_on ?? '',
      updatedAt: detail.updated_on ?? '',
    };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/** One page of changed files. `cursor` is the opaque page token from a prior call. */
export async function listChangedFiles(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number,
  cursor?: string
): Promise<ProviderPrFilesPage> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const identity = `bitbucket-diffstat:${access.repository.fullName}#${prId}`;
    const page = await fetchDiffstatPage(access, prId, identity, cursor);
    return {
      files: page.values.map(mapDiffstatEntry),
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

export type BitbucketFileLines = {
  lines: string[];
  totalLines: number;
};

/**
 * A 1-based inclusive line window of a file at a commit, for comment context.
 * A missing file is a non-retryable not_found.
 */
export async function getFileLines(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  ref: string,
  path: string,
  startLine: number,
  endLine: number
): Promise<BitbucketFileLines> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    if (!/^[0-9a-fA-F]{6,64}$/.test(ref)) {
      throw new BitbucketReviewError('bad_request', 'The file ref must be a commit hash.');
    }
    const cleanPath = path.replace(/^\/+/, '');
    if (!cleanPath || cleanPath.includes('..')) {
      throw new BitbucketReviewError('not_found', 'The file was not found at this commit.');
    }
    const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
    const text = await requestBitbucketText(
      access,
      `/2.0/repositories/${repositorySegment(access.repository)}/src/${encodeURIComponent(ref)}/${encodedPath}`
    );
    const allLines = text.split('\n');
    const start = Math.max(1, Math.min(startLine, allLines.length));
    const end = Math.max(start, Math.min(endLine, allLines.length));
    return { lines: allLines.slice(start - 1, end), totalLines: allLines.length };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * A discussion thread. Bitbucket threads are top-level comments with replies;
 * inline anchors come from the root comment's `inline` block. `taskCount` is
 * the number of tasks collected for the thread root, resolved and unresolved
 * — Bitbucket comments carry no task count of their own.
 */
export type BitbucketDiscussionThread = ProviderPrThread & { taskCount: number };

export type BitbucketDiscussionsPage = {
  threads: BitbucketDiscussionThread[];
  nextCursor: string | null;
};

/**
 * Build threads from one flat page of comments: top-level comments are the
 * thread roots, replies attach to their parent. Both the resolved flag and
 * the task count come from the task evidence the caller supplies — Bitbucket
 * never sends task fields on comments: a thread is resolved when a task
 * exists for its root comment and no task on it is unresolved.
 */
function buildThreadsFromComments(
  comments: z.infer<typeof BitbucketCommentSchema>[],
  taskEvidence: {
    commentIds: ReadonlySet<number>;
    unresolvedCommentIds: ReadonlySet<number>;
    taskCounts: ReadonlyMap<number, number>;
  }
): BitbucketDiscussionThread[] {
  const roots = comments.filter(comment => !comment.parent && comment.deleted !== true);
  const repliesByParent = new Map<number, z.infer<typeof BitbucketCommentSchema>[]>();
  for (const comment of comments) {
    if (comment.parent && comment.deleted !== true) {
      const existing = repliesByParent.get(comment.parent.id) ?? [];
      existing.push(comment);
      repliesByParent.set(comment.parent.id, existing);
    }
  }
  return roots.map(root => {
    const inline = root.inline ?? null;
    const anchorLine = inline?.to ?? inline?.from ?? null;
    const taskCount = taskEvidence.taskCounts.get(root.id) ?? 0;
    return {
      threadId: String(root.id),
      resolved:
        taskEvidence.commentIds.has(root.id) && !taskEvidence.unresolvedCommentIds.has(root.id),
      path: inline?.path ?? null,
      line: anchorLine,
      side: inline ? (inline.to != null ? 'RIGHT' : 'LEFT') : null,
      comments: [root, ...(repliesByParent.get(root.id) ?? [])].map(comment => ({
        commentId: String(comment.id),
        author: mapUser(comment.user),
        body: comment.content?.raw ?? '',
        createdAt: comment.created_on ?? '',
      })),
      taskCount,
    };
  });
}

/**
 * Fetch the PR's task collection and fold it into task evidence per
 * comment: which comments hold tasks at all, which still hold an unresolved
 * task, and how many tasks each holds. The collection is paginated, so the
 * walk follows every page up to the same bounded page count the write
 * layer's thread resolution uses. A provider that does not expose the
 * collection (404) or forbids reading it leaves no task evidence — threads
 * then read unresolved and taskless instead of failing the whole discussion
 * list. A walk that hits the page bound with pages left unread is treated
 * the same way: partial evidence must never claim a resolution or a count
 * the unread pages could contradict.
 */
async function fetchTaskEvidence(
  access: BitbucketRepositoryAccess,
  prId: number
): Promise<{
  commentIds: ReadonlySet<number>;
  unresolvedCommentIds: ReadonlySet<number>;
  taskCounts: ReadonlyMap<number, number>;
}> {
  const noTaskEvidence = () => ({
    commentIds: new Set<number>(),
    unresolvedCommentIds: new Set<number>(),
    taskCounts: new Map<number, number>(),
  });
  const { commentIds, unresolvedCommentIds, taskCounts } = noTaskEvidence();
  let cursor: string | undefined = undefined;
  let exhausted = true;
  try {
    for (let pageIndex = 0; pageIndex < MAX_TASK_COLLECTION_PAGES; pageIndex++) {
      const page = await fetchPage(
        access,
        `/2.0/repositories/${repositorySegment(access.repository)}/pullrequests/${prId}/tasks`,
        `bitbucket-tasks:${access.repository.fullName}#${prId}`,
        cursor,
        repositoryPathGuard(access),
        { pagelen: 100 }
      );
      for (const value of page.values) {
        const parsed = BitbucketTaskSchema.safeParse(value);
        if (!parsed.success) continue;
        const commentId = parsed.data.comment?.id;
        if (typeof commentId !== 'number') continue;
        commentIds.add(commentId);
        if (parsed.data.resolved_on == null) unresolvedCommentIds.add(commentId);
        taskCounts.set(commentId, (taskCounts.get(commentId) ?? 0) + 1);
      }
      if (!page.nextCursor) {
        exhausted = true;
        break;
      }
      exhausted = false;
      cursor = page.nextCursor;
    }
  } catch (error) {
    if (
      error instanceof BitbucketReviewError &&
      (error.kind === 'not_found' || error.kind === 'forbidden')
    ) {
      return noTaskEvidence();
    }
    throw error;
  }
  if (!exhausted) return noTaskEvidence();
  return { commentIds, unresolvedCommentIds, taskCounts };
}

/** One page of discussions (threads and replies) with their diff anchors. */
export async function listDiscussions(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number,
  cursor?: string
): Promise<BitbucketDiscussionsPage> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const identity = `bitbucket-comments:${access.repository.fullName}#${prId}`;
    const page = await fetchPage(
      access,
      `/2.0/repositories/${repositorySegment(access.repository)}/pullrequests/${prId}/comments`,
      identity,
      cursor,
      repositoryPathGuard(access)
    );
    const comments: z.infer<typeof BitbucketCommentSchema>[] = [];
    for (const value of page.values) {
      const parsed = BitbucketCommentSchema.safeParse(value);
      if (parsed.success) comments.push(parsed.data);
    }
    const taskEvidence = await fetchTaskEvidence(access, prId);
    return {
      threads: buildThreadsFromComments(comments, taskEvidence),
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

async function fetchBuildStatusesPage(
  access: BitbucketRepositoryAccess,
  headSha: string,
  cursor: string | undefined
): Promise<{ values: z.infer<typeof BitbucketBuildStatusSchema>[]; nextCursor: string | null }> {
  const page = await fetchPage(
    access,
    `/2.0/repositories/${repositorySegment(access.repository)}/commit/${encodeURIComponent(headSha)}/statuses`,
    `bitbucket-statuses:${access.repository.fullName}#${headSha}`,
    cursor,
    repositoryPathGuard(access)
  );
  const values: z.infer<typeof BitbucketBuildStatusSchema>[] = [];
  for (const value of page.values) {
    const parsed = BitbucketBuildStatusSchema.safeParse(value);
    if (parsed.success) values.push(parsed.data);
  }
  return { values, nextCursor: page.nextCursor };
}

const FINISHED_BUILD_STATES = new Set(['SUCCESSFUL', 'FAILED']);

/**
 * The builds running on the PR head commit, as the shared checks DTO. A
 * finished build keeps the provider verdict; a running or stopped build reads
 * as pending with no conclusion.
 */
export async function listChecks(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number
): Promise<ProviderPrChecksResult> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const detail = await fetchPullRequestDetail(access, prId);
    const headSha = detail.source?.commit?.hash;
    if (!headSha) return { checks: [] };
    const checks: ProviderPrChecksResult['checks'] = [];
    let cursor: string | undefined = undefined;
    for (let page = 0; page < MAX_BUILD_PAGES; page++) {
      const result = await fetchBuildStatusesPage(access, headSha, cursor);
      for (const status of result.values) {
        const state = status.state.toUpperCase();
        checks.push({
          name: status.name ?? status.key ?? 'build',
          status: FINISHED_BUILD_STATES.has(state) ? 'completed' : 'pending',
          conclusion: state === 'SUCCESSFUL' ? 'success' : state === 'FAILED' ? 'failed' : null,
          detailsUrl: status.links?.status?.href ?? status.url ?? null,
        });
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return { checks };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

/**
 * Open pull requests across the connected workspace, for the PR Review inbox.
 * Each item carries platform, workspace, and repository identity, so the list
 * can never navigate into a different provider's repo.
 *
 * Bitbucket removed the aggregate collections that used to answer this in one
 * request (`/2.0/pullrequests?role=REVIEWER` and the workspace-level twin
 * both answer "There is no API hosted at this URL" today), and a workspace
 * access token cannot resolve its own account (`/2.0/user` answers 403), so
 * "reviewer = me" is not reproducible. The inbox therefore lists every open
 * PR of the workspace's repositories, newest first.
 */
export async function listInbox(
  owner: BitbucketReviewOwner,
  cursor?: string
): Promise<ProviderPrInboxPage> {
  const access = await authorizeWorkspace(owner);
  try {
    const identity = `bitbucket-inbox:${access.workspace.slug}`;
    const page = decodeInboxPageCursor(cursor, identity);
    const slugs = await listWorkspaceRepositorySlugs(access, access.workspace.slug);
    const values: unknown[] = [];
    let hasMore = false;
    for (let offset = 0; offset < slugs.length; offset += INBOX_REPOSITORY_CONCURRENCY) {
      const batch = slugs.slice(offset, offset + INBOX_REPOSITORY_CONCURRENCY);
      const pages = await Promise.all(
        batch.map(slug =>
          requestBitbucketJson<unknown>(
            access,
            `/2.0/repositories/${encodeURIComponent(access.workspace.slug)}/${encodeURIComponent(slug)}/pullrequests`,
            { query: { pagelen: BITBUCKET_PAGE_SIZE, page, q: 'state="OPEN"' } }
          )
        )
      );
      for (const payload of pages) {
        const parsedPage = BitbucketPageSchema.safeParse(payload);
        if (!parsedPage.success) {
          throw new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected page.');
        }
        values.push(...parsedPage.data.values);
        if (parsedPage.data.values.length >= BITBUCKET_PAGE_SIZE) hasMore = true;
      }
    }
    const items: ProviderPrInboxItem[] = [];
    for (const value of values) {
      const parsed = BitbucketInboxPullRequestSchema.safeParse(value);
      if (!parsed.success) continue;
      const ref = inboxRefFrom(parsed.data, access.workspace.slug);
      if (!ref) continue;
      items.push({
        ref,
        title: parsed.data.title,
        author: mapUser(parsed.data.author ?? null),
        state: mapPullRequestState(parsed.data.state),
        draft: parsed.data.draft === true,
        updatedAt: parsed.data.updated_on ?? '',
      });
    }
    items.sort((left, right) => inboxUpdatedMs(right) - inboxUpdatedMs(left));
    const trimmed = items.slice(0, BITBUCKET_PAGE_SIZE);
    if (items.length > trimmed.length) hasMore = true;
    return {
      items: trimmed,
      nextCursor: hasMore ? encodeInboxPageCursor(identity, page + 1) : null,
    };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

function inboxUpdatedMs(item: ProviderPrInboxItem): number {
  const ms = Date.parse(item.updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The inbox cursor is a plain page counter, not a provider `next` URL: one
 * inbox page fans out over the workspace's repositories, so no single next
 * link can represent it. A cursor minted for another workspace, or in the
 * old next-URL shape, decodes to page 1 — a cursor can never switch the
 * workspace a request reads.
 */
function encodeInboxPageCursor(identity: string, page: number): string {
  return Buffer.from(JSON.stringify({ identity, page })).toString('base64url');
}

function decodeInboxPageCursor(cursor: string | undefined, identity: string): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      identity?: unknown;
      page?: unknown;
    };
    if (parsed.identity !== identity || !Number.isInteger(parsed.page)) return 1;
    return Math.max(1, parsed.page as number);
  } catch {
    return 1;
  }
}

/**
 * Repository slugs of the workspace, newest enumeration capped: at most
 * INBOX_REPOSITORY_PAGES pages of INBOX_REPOSITORY_PAGE_SIZE. A workspace
 * larger than the cap shows PRs of the repositories Bitbucket enumerates
 * first — a bounded inbox beats an unbounded crawl.
 */
async function listWorkspaceRepositorySlugs(
  access: { accessToken: string },
  workspaceSlug: string
): Promise<string[]> {
  const slugs: string[] = [];
  for (let repoPage = 1; repoPage <= INBOX_REPOSITORY_PAGES; repoPage += 1) {
    const payload = await requestBitbucketJson<unknown>(
      access,
      `/2.0/repositories/${encodeURIComponent(workspaceSlug)}`,
      { query: { pagelen: INBOX_REPOSITORY_PAGE_SIZE, page: repoPage } }
    );
    const parsed = z
      .object({ values: z.array(z.object({ slug: z.string().min(1).nullable().optional() })).default([]) })
      .safeParse(payload);
    if (!parsed.success) {
      throw new BitbucketReviewError('retryable', 'Bitbucket returned an unexpected page.');
    }
    for (const repository of parsed.data.values) {
      if (repository.slug) slugs.push(repository.slug);
    }
    if (parsed.data.values.length < INBOX_REPOSITORY_PAGE_SIZE) break;
  }
  return slugs;
}

/**
 * The ref of an inbox row: `workspace/repo-slug` from the destination
 * repository full name. A row whose identity is unparseable — or outside the
 * connected workspace — is skipped: an item without a full identity could
 * navigate into the wrong repository.
 */
function inboxRefFrom(
  value: z.infer<typeof BitbucketInboxPullRequestSchema>,
  workspaceSlug: string
): ProviderPrSummary['ref'] | null {
  const fullName =
    value.destination?.repository?.full_name ?? value.source?.repository?.full_name ?? '';
  const segments = fullName.split('/');
  if (segments.length !== 2) return null;
  const [rowWorkspace, rowRepoSlug] = segments;
  if (rowWorkspace.toLowerCase() !== workspaceSlug.toLowerCase() || !rowRepoSlug) return null;
  return {
    platform: 'bitbucket',
    workspace: rowWorkspace,
    repoSlug: rowRepoSlug,
    prId: value.id,
  };
}

/**
 * The merge gate: the PR's own state (open, draft, unresolved tasks) plus the
 * repository's merge checks (branch restrictions, where the token can reach
 * them) → `blockedReasons[]` in provider wording. Reviewer approvals come
 * from the PR's participants.
 */
export async function getMergeRestrictions(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number
): Promise<ProviderPrMergeState> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const detail = await fetchPullRequestDetail(access, prId);

    const participants: z.infer<typeof BitbucketParticipantSchema>[] = [];
    for (const value of detail.participants ?? []) {
      const parsed = BitbucketParticipantSchema.safeParse(value);
      if (parsed.success) participants.push(parsed.data);
    }

    // Repository merge checks: a workspace access token without the
    // administration scope may not read branch restrictions — absent
    // restrictions mean no visible merge gate, not a missing repository.
    const restrictions: z.infer<typeof BitbucketBranchRestrictionSchema>[] = [];
    try {
      const page = await fetchPage(
        access,
        `/2.0/repositories/${repositorySegment(access.repository)}/branch-restrictions`,
        `bitbucket-restrictions:${access.repository.fullName}`,
        undefined,
        repositoryPathGuard(access),
        { pagelen: 100 }
      );
      for (const value of page.values) {
        const parsed = BitbucketBranchRestrictionSchema.safeParse(value);
        if (parsed.success) restrictions.push(parsed.data);
      }
    } catch (error) {
      if (
        !(error instanceof BitbucketReviewError) ||
        (error.kind !== 'forbidden' && error.kind !== 'not_found')
      ) {
        throw error;
      }
    }

    const approvalsRequired = readRestrictionNumber(restrictions, 'require_approvals_to_merge');
    const buildsMustPass = hasRestriction(restrictions, 'require_passing_builds_to_merge');
    // The provider's own merge verdict: an UNCLEAN (or conflict-worded) merge
    // state means the branches diverged — independent of the restriction list.
    const conflicts = isConflictMergeState(detail.merge_state);

    const blockedReasons: ProviderPrMergeBlockedReason[] = [];
    if (detail.state !== 'OPEN') {
      blockedReasons.push({
        code: 'other',
        message: 'Only open pull requests can be merged.',
      });
    }
    if (detail.draft === true) {
      blockedReasons.push({ code: 'draft', message: 'The pull request is still a draft.' });
    }
    if (conflicts) {
      blockedReasons.push({
        code: 'conflicts',
        message: 'The pull request has conflicts that must be resolved.',
      });
    }
    // Unresolved tasks always gate the merge from the PR's own task_count:
    // the restriction list is often unreadable or unconfigured, so it must
    // never decide whether the provider counts tasks.
    if ((detail.task_count ?? 0) > 0) {
      blockedReasons.push({
        code: 'other',
        message: 'Resolve all tasks before merging.',
      });
    }
    if (approvalsRequired > 0) {
      const approvedCount = participants.filter(
        participant => participant.approved === true
      ).length;
      const approvalsLeft = Math.max(0, approvalsRequired - approvedCount);
      if (approvalsLeft > 0) {
        blockedReasons.push({
          code: 'required_approvals',
          message: `${approvalsLeft} more approval${approvalsLeft === 1 ? '' : 's'} required.`,
        });
      }
    }
    if (buildsMustPass && detail.state === 'OPEN') {
      const buildState = await latestBuildStateFor(access, detail.source?.commit?.hash ?? '');
      if (buildState === 'failed') {
        blockedReasons.push({
          code: 'failing_pipeline',
          message: 'The build on the latest commit failed.',
        });
      } else if (buildState !== 'success') {
        blockedReasons.push({
          code: 'pending_pipeline',
          message:
            buildState === 'none'
              ? 'No build was found for the latest commit.'
              : 'The builds on the latest commit have not finished yet.',
        });
      }
    }

    return {
      canMerge: detail.state === 'OPEN' && blockedReasons.length === 0,
      approvalsRequired,
      pipelineMustSucceed: buildsMustPass,
      conflicts,
      blockedReasons,
    };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}

function hasRestriction(
  restrictions: z.infer<typeof BitbucketBranchRestrictionSchema>[],
  kind: string
): boolean {
  return restrictions.some(restriction => restriction.kind === kind);
}

/**
 * Bitbucket's own merge verdict. `UNCLEAN` (any casing, or provider wording
 * that names a conflict) means the source and destination branches diverged
 * and Bitbucket cannot merge them cleanly.
 */
function isConflictMergeState(mergeState: string | null | undefined): boolean {
  const normalized = mergeState?.toUpperCase() ?? '';
  return normalized === 'UNCLEAN' || normalized.includes('CONFLICT');
}

function readRestrictionNumber(
  restrictions: z.infer<typeof BitbucketBranchRestrictionSchema>[],
  kind: string
): number {
  const restriction = restrictions.find(candidate => candidate.kind === kind);
  const value = typeof restriction?.value === 'number' ? restriction.value : 0;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

async function latestBuildStateFor(
  access: BitbucketRepositoryAccess,
  headSha: string
): Promise<'success' | 'failed' | 'pending' | 'none'> {
  if (!headSha) return 'none';
  let sawSuccess = false;
  let sawPending = false;
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_BUILD_PAGES; page++) {
    const result = await fetchBuildStatusesPage(access, headSha, cursor);
    for (const status of result.values) {
      const state = status.state.toUpperCase();
      // One failed build blocks the merge even when another build succeeded;
      // a running build keeps the gate pending until every build finished.
      if (state === 'FAILED') return 'failed';
      if (state === 'SUCCESSFUL') sawSuccess = true;
      else sawPending = true;
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (sawPending) return 'pending';
  return sawSuccess ? 'success' : 'none';
}

export type BitbucketReviewStatusParticipant = {
  login: string;
  avatarUrl: string | null;
  /** Whether the participant has approved the pull request. */
  approved: boolean;
  /** True when the participant holds the REVIEWER role. */
  reviewer: boolean;
};

export type BitbucketReviewStatus = {
  participants: BitbucketReviewStatusParticipant[];
};

/**
 * The review status of one PR: the provider's participants with their
 * approval state and REVIEWER role, straight from the PR detail.
 */
export async function getReviewStatus(
  owner: BitbucketReviewOwner,
  workspaceSlug: string,
  repoSlug: string,
  prId: number
): Promise<BitbucketReviewStatus> {
  const access = await authorizeRepository(owner, workspaceSlug, repoSlug);
  try {
    const detail = await fetchPullRequestDetail(access, prId);
    const participants: BitbucketReviewStatusParticipant[] = [];
    for (const value of detail.participants ?? []) {
      const parsed = BitbucketParticipantSchema.safeParse(value);
      if (!parsed.success) continue;
      const user = mapUser(parsed.data.user ?? null);
      if (!user) continue;
      participants.push({
        login: user.login,
        avatarUrl: user.avatarUrl,
        approved: parsed.data.approved === true,
        reviewer: parsed.data.role === 'REVIEWER',
      });
    }
    return { participants };
  } catch (error) {
    throw classifyBitbucketError(error);
  }
}
