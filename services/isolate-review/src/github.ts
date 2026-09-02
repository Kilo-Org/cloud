import { Buffer } from 'node:buffer';
import {
  buildPreviousReviewSummaryHistory,
  stripReviewSummaryFooter,
  stripReviewSummaryHistory,
} from '@kilocode/worker-utils/review-summary-cleaning';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  resolveReviewSnapshot,
  validateHeadSha,
  validateRepositoryName,
  type ReviewSnapshot,
} from './git';
import { REPO_ROOT, toRepoRelativePath } from './paths';
import {
  isDryRun,
  QueuedIsolatePublicationSchema,
  type IsolateReviewPreparation,
  type GithubHistoryState,
  type IsolateReviewSelection,
  type StartReviewInput,
  type SummaryContent,
} from './types';

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const SUMMARY_MARKER = '<!-- kilo-review -->';
const SUMMARY_OPERATION_MARKER_PATTERN = /\n?<!--\s*kilo-isolate-review-summary:[^>]*-->/gi;
const SERVER_BLOCK_PATTERN =
  /<!--\s*\/?kilo-(?:review-history(?:-entry)?|usage|review-guidance)\s*-->/i;
const KILO_GITHUB_BOT_LOGINS = new Set([
  'kilo-code',
  'kilo-code[bot]',
  'kilo-code-bot',
  'kilo-code-bot[bot]',
  'kilo-code-review-bot',
  'kilo-code-review-bot[bot]',
  'kilocode[bot]',
  'kiloconnect[bot]',
  'kiloconnect-development[bot]',
  'kiloconnect-lite[bot]',
]);
export const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_GITHUB_TRAVERSAL_BYTES = 8 * 1024 * 1024;
export const MAX_GITHUB_PAGES = 50;
export const MAX_CONTEXT_RECORDS = 5_000;
export const MAX_DIFF_FILES = 300;
export const MAX_PR_FILES = 3_000;
export const MAX_FALLBACK_PATCH_BYTES = 256 * 1024;
export const MAX_INLINE_COMMENTS = 500;
export const MAX_COMMENTS_PER_CATEGORY = 100;
export const MAX_COMMENT_BODY_LENGTH = 512;
export const MAX_RETRIEVAL_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PUBLICATION_ATTEMPTS = 2;
export const MAX_HISTORY_REQUESTS = 20;
export const MAX_HISTORY_COMMITS = 100;
export const MAX_RENAME_PROOF_REQUESTS = 100;
const HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGES = 5;
const MAX_CATEGORY_OUTPUT_BYTES = 128 * 1024;
const MAX_PATCH_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BODY_BYTES = 64 * 1024;
const QUEUED_SUMMARY_FOOTER_BYTES = 2 * 1024;
const MAX_REVIEW_COMMENTS = 100;
const PAGE_SIZE = 100;
const encoder = new TextEncoder();

export const READ_ONLY_GITHUB_TOOL_NAMES = [
  'pr_view',
  'pr_diff',
  'pr_comments',
  'pr_comment',
  'pr_file',
  'pr_file_patch',
  'pr_history',
  'pr_commit',
] as const;
export const GITHUB_TOOL_NAMES = [
  ...READ_ONLY_GITHUB_TOOL_NAMES,
  'submit_review',
  'upsert_summary',
] as const;
export type GithubToolName = (typeof GITHUB_TOOL_NAMES)[number];

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`GitHub API returned ${status}: ${body}`);
    this.name = 'GithubApiError';
  }
}

function isDefinitivePublicationRejection(error: unknown): error is GithubApiError {
  return error instanceof GithubApiError && [400, 401, 403, 404, 422].includes(error.status);
}

export class GithubContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubContextError';
  }
}

export type GithubResponse<T> = {
  data: T;
  headers: Headers;
  bytes?: number;
};

export type PaginateOptions = {
  maxItems?: number;
  fromEnd?: boolean;
  signal?: AbortSignal;
};

export type GithubClient = {
  get<T>(path: string, headers?: HeadersInit, signal?: AbortSignal): Promise<T>;
  getResponse<T>(
    path: string,
    headers?: HeadersInit,
    signal?: AbortSignal
  ): Promise<GithubResponse<T>>;
  getTextResponse(
    path: string,
    headers?: HeadersInit,
    signal?: AbortSignal
  ): Promise<GithubResponse<string>>;
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  patch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  paginate<T>(path: string, options?: PaginateOptions): Promise<T[]>;
};

function linkUrl(link: string | null, rel: 'next' | 'prev' | 'last'): string | undefined {
  if (!link) return undefined;
  const pattern = new RegExp(`^<([^>]+)>;\\s*rel="${rel}"$`, 'i');
  return link
    .split(',')
    .map(part => part.trim().match(pattern)?.[1])
    .find((url): url is string => Boolean(url));
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function responseBytes(response: GithubResponse<unknown>): number {
  return response.bytes ?? byteLength(JSON.stringify(response.data));
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (declaredLength > MAX_GITHUB_RESPONSE_BYTES) {
      throw new GithubContextError('GitHub response exceeds the 2 MiB transport byte budget');
    }
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array))
        throw new GithubContextError('GitHub returned a non-byte response stream');
      bytes += value.byteLength;
      if (bytes > MAX_GITHUB_RESPONSE_BYTES) {
        throw new GithubContextError('GitHub response exceeds the 2 MiB transport byte budget');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function jsonHeaders(token: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (!result.has('Accept')) result.set('Accept', 'application/vnd.github+json');
  result.set('Authorization', `Bearer ${token}`);
  result.set('User-Agent', 'kilo-isolate-review');
  result.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  return result;
}

export function resolveGithubApiUrl(apiUrl?: string): string {
  return apiUrl?.trim() || DEFAULT_GITHUB_API_URL;
}

export function createGithubClient(
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  apiUrl?: string
): GithubClient {
  const baseUrl = resolveGithubApiUrl(apiUrl);
  const baseOrigin = new URL(baseUrl).origin;

  async function request(path: string, init: RequestInit = {}): Promise<GithubResponse<string>> {
    const url = new URL(path, baseUrl);
    if (url.origin !== baseOrigin || url.username || url.password) {
      throw new GithubContextError(
        'GitHub request origin does not match the configured API origin'
      );
    }
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const response = await fetchImpl(url.toString(), {
      ...init,
      redirect: 'manual',
      headers: jsonHeaders(token, init.headers),
    });
    signal?.throwIfAborted();
    let body: string;
    try {
      body = await readBoundedBody(response, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!response.ok) throw new GithubApiError(response.status, 'Response body unavailable');
      throw error;
    }
    if (!response.ok) {
      throw new GithubApiError(
        response.status,
        body.replaceAll(token, '[redacted]').slice(0, 4_096)
      );
    }
    return { data: body, headers: response.headers, bytes: byteLength(body) };
  }

  function parseJson<T>(response: GithubResponse<string>): GithubResponse<T> {
    try {
      return { ...response, data: JSON.parse(response.data) as T };
    } catch {
      throw new GithubContextError('GitHub returned invalid JSON');
    }
  }

  async function getResponse<T>(
    path: string,
    headers?: HeadersInit,
    signal?: AbortSignal
  ): Promise<GithubResponse<T>> {
    return parseJson<T>(await request(path, { headers, signal }));
  }

  async function sendJson<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await request(path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseJson<T>(response).data;
  }

  async function paginate<T>(path: string, options: PaginateOptions = {}): Promise<T[]> {
    const { signal, fromEnd, maxItems } = options;
    if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 1)) {
      throw new Error('maxItems must be a positive integer');
    }
    const values: T[] = [];
    const visited = new Set<string>();
    const initial = new URL(path, baseUrl);
    const matchesPaginationPath = createPaginationPathMatcher(
      async (repositoryPath, signal) =>
        parseExternal(
          repositorySchema,
          (await getResponse<unknown>(repositoryPath, undefined, signal)).data,
          'repository identity'
        ).id
    );
    let bytes = 0;
    let current: string | undefined = path;
    let backwards = false;
    while (current) {
      signal?.throwIfAborted();
      const url = new URL(current, baseUrl);
      if (url.origin !== baseOrigin || url.username || url.password) {
        throw new GithubContextError(
          'GitHub request origin does not match the configured API origin'
        );
      }
      if (!(await matchesPaginationPath(url.pathname, initial.pathname, signal))) {
        throw new GithubContextError(
          'GitHub pagination escaped its endpoint, repeated, or exceeded 50 pages'
        );
      }
      url.pathname = initial.pathname;
      if (visited.has(url.href) || visited.size >= MAX_GITHUB_PAGES) {
        throw new GithubContextError(
          'GitHub pagination escaped its endpoint, repeated, or exceeded 50 pages'
        );
      }
      visited.add(url.href);
      const page = await getResponse<T[]>(url.href, undefined, signal);
      signal?.throwIfAborted();
      if (!Array.isArray(page.data))
        throw new GithubContextError('GitHub pagination endpoint returned a non-array');
      bytes += responseBytes(page);
      if (
        bytes > MAX_GITHUB_TRAVERSAL_BYTES ||
        values.length + page.data.length > MAX_CONTEXT_RECORDS
      ) {
        throw new GithubContextError(
          'GitHub pagination exceeds the 8 MiB or 5,000-record traversal budget'
        );
      }
      const last = linkUrl(page.headers.get('Link'), 'last');
      if (fromEnd && visited.size === 1 && last) {
        current = last;
        backwards = true;
        continue;
      }
      if (backwards) values.unshift(...page.data);
      else values.push(...page.data);
      if (maxItems !== undefined && values.length >= maxItems && (!fromEnd || backwards)) {
        return backwards ? values.slice(-maxItems).reverse() : values.slice(0, maxItems);
      }
      current = linkUrl(page.headers.get('Link'), backwards ? 'prev' : 'next');
    }
    return fromEnd ? (maxItems === undefined ? values : values.slice(-maxItems)).reverse() : values;
  }

  return {
    get: async <T>(path: string, headers?: HeadersInit, signal?: AbortSignal) =>
      (await getResponse<T>(path, headers, signal)).data,
    getResponse,
    getTextResponse: (path, headers, signal) => request(path, { headers, signal }),
    post: <T>(path: string, body: unknown, signal?: AbortSignal) =>
      sendJson<T>('POST', path, body, signal),
    patch: <T>(path: string, body: unknown, signal?: AbortSignal) =>
      sendJson<T>('PATCH', path, body, signal),
    paginate,
  };
}

const githubIdSchema = z.number().int().positive().safe();
const repositorySchema = z.object({ id: githubIdSchema });
const shaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
  .transform(sha => sha.toLowerCase());
const userSchema = z
  .object({
    login: z.string().min(1).max(100),
    id: githubIdSchema.optional(),
    type: z.string().optional(),
  })
  .nullable();
const bodySchema = z.string().max(262_144);
const pathSchema = z.string().min(1).max(4_096);
const pullSchema = z.object({
  title: z.string().max(4_096).optional(),
  body: bodySchema.nullable().optional(),
  user: userSchema.optional(),
  head: z.object({ sha: shaSchema, ref: z.string().max(1_024).optional() }),
  base: z.object({ sha: shaSchema, ref: z.string().max(1_024).optional() }),
  state: z.enum(['open', 'closed']).optional(),
  draft: z.boolean().optional(),
  changed_files: z.number().int().nonnegative().safe(),
});
const fileSchema = z.object({
  sha: shaSchema,
  filename: pathSchema,
  previous_filename: pathSchema.optional(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().nonnegative().safe(),
  deletions: z.number().int().nonnegative().safe(),
  changes: z.number().int().nonnegative().safe(),
  patch: z.string().optional(),
});
const compareSchema = z.object({
  base_commit: z.object({ sha: shaSchema }),
  merge_base_commit: z.object({ sha: shaSchema }),
  files: z.array(fileSchema).max(MAX_DIFF_FILES),
});
const incrementalCompareSchema = compareSchema.extend({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
});
const historyCommitSchema = z.object({
  sha: shaSchema,
  commit: z.object({
    message: bodySchema,
    author: z
      .object({ name: z.string().max(1_024), date: z.string().max(100) })
      .nullable()
      .optional(),
  }),
  parents: z.array(z.object({ sha: shaSchema })).max(100),
});
const commitDetailsSchema = historyCommitSchema.extend({
  files: z.array(fileSchema).max(PAGE_SIZE),
});
const gitCommitSchema = z.object({
  sha: shaSchema,
  tree: z.object({ sha: shaSchema }),
});
const gitTreeEntrySchema = z
  .object({
    path: pathSchema.refine(
      path => path !== '.' && path !== '..' && !path.includes('/') && !path.includes('\0')
    ),
    sha: shaSchema,
    mode: z.enum(['100644', '100755', '040000', '120000', '160000']),
    type: z.enum(['blob', 'tree', 'commit']),
  })
  .refine(
    entry =>
      entry.type ===
      (entry.mode === '040000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob')
  );
const gitTreeSchema = z
  .object({
    sha: shaSchema,
    truncated: z.literal(false),
    tree: z.array(gitTreeEntrySchema).max(MAX_CONTEXT_RECORDS),
  })
  .refine(tree => new Set(tree.tree.map(entry => entry.path)).size === tree.tree.length);
const contentSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string(),
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha: shaSchema,
  path: pathSchema,
  submodule_git_url: z.string().nullable().optional(),
  target: z.string().optional(),
});
const commentSchema = z.object({
  id: githubIdSchema,
  body: bodySchema,
  user: userSchema,
  created_at: z.string().max(100).optional(),
  updated_at: z.string().max(100).optional(),
  html_url: z.string().max(2_048).optional(),
});
const issueCommentSchema = commentSchema.extend({
  issue_url: z.string().max(2_048),
  performed_via_github_app: z.object({ id: githubIdSchema }).nullable().optional(),
});
const inlineCommentSchema = commentSchema
  .extend({
    path: pathSchema,
    line: githubIdSchema.nullable(),
    original_line: githubIdSchema.nullable().optional(),
    position: z.number().int().nonnegative().nullable().optional(),
    side: z.enum(['LEFT', 'RIGHT']).nullable().optional(),
    subject_type: z.enum(['line', 'file']),
    commit_id: shaSchema,
    original_commit_id: shaSchema.optional(),
    in_reply_to_id: githubIdSchema.nullable().optional(),
    pull_request_url: z.string().max(2_048),
  })
  .refine(
    comment => comment.line === null || comment.side != null,
    'Current line comments require a side'
  );
const reviewSchema = commentSchema.extend({
  commit_id: shaSchema,
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  submitted_at: z.string().max(100).nullable().optional(),
  pull_request_url: z.string().max(2_048),
});
const publishedSchema = z.object({ id: githubIdSchema });
const ownershipSchema = z.object({
  previousRunId: z.string().min(1).max(256),
  commentId: githubIdSchema,
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
});

type PullRequest = z.infer<typeof pullSchema>;
type DiffFile = z.infer<typeof fileSchema>;
type InlineComment = z.infer<typeof inlineCommentSchema>;
type IssueComment = z.infer<typeof issueCommentSchema>;
type Review = z.infer<typeof reviewSchema>;
type CommentCategory = 'inline' | 'issue' | 'reviews';
type FileComparison = 'review' | 'current-pr';
type IncrementalComparisonFallback = {
  fallbackReason: 'previous_head_not_ancestor' | 'comparison_unavailable' | 'comparison_incomplete';
};
type ReviewComment = { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string };
type FileEvidence = Omit<DiffFile, 'patch'> & {
  patch?: string;
  patchLength: number | null;
  patchBytes: number | null;
  patchStatus: 'available' | 'incomplete' | 'binary_or_omitted';
  page?: number;
};

function parseExternal<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GithubContextError(`GitHub returned invalid ${label}`);
  return result.data;
}

function validChangedFileMetadata(files: DiffFile[]): boolean {
  const names = new Set<string>();
  for (const file of files) {
    if (
      names.has(file.filename) ||
      toRepoRelativePath(file.filename) !== file.filename ||
      (file.previous_filename !== undefined &&
        toRepoRelativePath(file.previous_filename) !== file.previous_filename) ||
      (file.status === 'renamed' && !file.previous_filename) ||
      file.additions + file.deletions !== file.changes
    ) {
      return false;
    }
    names.add(file.filename);
  }
  return true;
}

function incrementalComparisonFiles(
  value: unknown,
  previousHeadSha: string
): { files: DiffFile[] } | IncrementalComparisonFallback {
  const result = incrementalCompareSchema.safeParse(value);
  if (!result.success) return { fallbackReason: 'comparison_incomplete' };
  const comparison = result.data;
  if (
    comparison.base_commit.sha !== previousHeadSha ||
    comparison.merge_base_commit.sha !== previousHeadSha ||
    comparison.status !== 'ahead'
  ) {
    return { fallbackReason: 'previous_head_not_ancestor' };
  }
  if (comparison.files.length >= MAX_DIFF_FILES || !validChangedFileMetadata(comparison.files)) {
    return { fallbackReason: 'comparison_incomplete' };
  }
  return { files: comparison.files };
}

export async function resolveIncrementalComparison(
  github: GithubClient,
  input: Pick<StartReviewInput, 'owner' | 'repo'>,
  snapshot: ReviewSnapshot,
  previousHeadSha: string,
  signal?: AbortSignal
): Promise<{ changedFileCount: number } | IncrementalComparisonFallback> {
  signal?.throwIfAborted();
  validateRepositoryName(input.owner, input.repo);
  validateHeadSha(snapshot.headSha);
  validateHeadSha(previousHeadSha);
  const previous = previousHeadSha.toLowerCase();
  if (previous === snapshot.headSha.toLowerCase()) {
    return { fallbackReason: 'previous_head_not_ancestor' };
  }
  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${previous}...${snapshot.headSha.toLowerCase()}?per_page=1`;
  let response: GithubResponse<unknown>;
  try {
    response = await github.getResponse<unknown>(path, undefined, signal);
    signal?.throwIfAborted();
    if (responseBytes(response) > MAX_GITHUB_RESPONSE_BYTES) {
      return { fallbackReason: 'comparison_unavailable' };
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { fallbackReason: 'comparison_unavailable' };
  }
  const result = incrementalComparisonFiles(response.data, previous);
  return 'files' in result ? { changedFileCount: result.files.length } : result;
}

function createPaginationPathMatcher(
  readRepositoryId: (path: string, signal?: AbortSignal) => Promise<number>
) {
  const repositoryIds = new Map<string, number>();
  return async (pathname: string, expectedPath: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    if (pathname === expectedPath) return true;
    const named = /^(\/repos\/[^/]+\/[^/]+)(\/.*)$/.exec(expectedPath);
    const numeric = /^\/repositories\/[1-9]\d*(\/.*)$/.exec(pathname);
    const repositoryPath = named?.[1];
    const endpoint = named?.[2];
    if (!repositoryPath || !endpoint || numeric?.[1] !== endpoint) return false;
    let repositoryId = repositoryIds.get(repositoryPath);
    if (repositoryId === undefined) {
      const resolvedId = await readRepositoryId(repositoryPath, signal);
      signal?.throwIfAborted();
      repositoryId = repositoryIds.get(repositoryPath);
      if (repositoryId !== undefined && repositoryId !== resolvedId) {
        throw new GithubContextError('GitHub repository identity changed during pagination');
      }
      repositoryId = resolvedId;
      repositoryIds.set(repositoryPath, repositoryId);
    }
    return pathname === `/repositories/${repositoryId}${endpoint}`;
  };
}

function isKiloBotUser(user: z.infer<typeof userSchema>): boolean {
  return user !== null && KILO_GITHUB_BOT_LOGINS.has(user.login.toLowerCase());
}

function belongsTo(url: string, path: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname.toLowerCase() === path.toLowerCase() &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function textChunk(body: string, offset: number, maxBytes: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > body.length ||
    (offset > 0 && /[\uDC00-\uDFFF]/.test(body.charAt(offset)))
  ) {
    throw new Error('offset must be a valid character boundary within the body');
  }
  const bytes = encoder.encode(body.slice(offset));
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  const nextOffset = offset + text.length;
  return {
    body: text,
    bodyTruncated: offset !== 0 || nextOffset < body.length,
    originalLength: body.length,
    originalBytes: byteLength(body),
    offset,
    nextOffset: nextOffset < body.length ? nextOffset : null,
  };
}

function contextBody(body: string): string {
  if (!body.startsWith(SUMMARY_MARKER)) return body;
  return stripReviewSummaryFooter(
    stripReviewSummaryHistory(body.replace(SUMMARY_OPERATION_MARKER_PATTERN, ''))
  );
}

function projectComment(comment: InlineComment | IssueComment | Review, category: CommentCategory) {
  const visibleBody = contextBody(comment.body);
  const chunk = textChunk(visibleBody, 0, MAX_COMMENT_BODY_LENGTH);
  return {
    ...comment,
    ...chunk,
    originalLength: comment.body.length,
    originalBytes: byteLength(comment.body),
    contextLength: visibleBody.length,
    serverOwnedBlocksExcluded: visibleBody !== comment.body,
    retrieval: { tool: 'pr_comment', category, id: comment.id, offset: 0 },
    ...('subject_type' in comment
      ? {
          isReply: comment.in_reply_to_id != null,
          outdated: comment.subject_type === 'line' && comment.line === null,
          resolution: 'unknown',
        }
      : {}),
  };
}

function projectCommentPage(
  comments: Array<InlineComment | IssueComment | Review>,
  category: CommentCategory,
  offset = 0
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > comments.length) {
    throw new Error('offset must be within the requested discussion page');
  }
  const projected: ReturnType<typeof projectComment>[] = [];
  let bytes = 0;
  let index = offset;
  for (; index < comments.length; index++) {
    const comment = projectComment(comments[index], category);
    const size = byteLength(JSON.stringify(comment));
    if (bytes + size > MAX_CATEGORY_OUTPUT_BYTES) break;
    bytes += size;
    projected.push(comment);
  }
  return { comments: projected, nextOffset: index < comments.length ? index : null };
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function publicationFingerprint(
  kind: 'review' | 'summary',
  headSha: string,
  path: string,
  payload: { body: string; comments?: ReviewComment[]; commit_id?: string; event?: string }
): Promise<string> {
  const canonicalPayload =
    kind === 'review' && payload.comments
      ? {
          ...payload,
          comments: [...payload.comments].sort((left, right) => {
            if (left.path !== right.path) return left.path < right.path ? -1 : 1;
            if (left.line !== right.line) return left.line - right.line;
            if (left.side !== right.side) return left.side < right.side ? -1 : 1;
            return left.body < right.body ? -1 : left.body > right.body ? 1 : 0;
          }),
        }
      : payload;
  return hashText(JSON.stringify([kind, headSha, path, canonicalPayload]));
}

function normalizeReviewComments(
  comments: ReviewComment[]
): { comments: ReviewComment[] } | { error: string } {
  if (comments.length === 0 || comments.length > MAX_REVIEW_COMMENTS) {
    return { error: 'An atomic review requires between 1 and 100 inline comments' };
  }
  const normalized: ReviewComment[] = [];
  const keys = new Set<string>();
  for (const comment of comments) {
    const absoluteOutsideWorkspace =
      comment.path.trim().startsWith('/') && !comment.path.trim().startsWith(`${REPO_ROOT}/`);
    const path = toRepoRelativePath(comment.path);
    if (!path || path.length > 4_096 || absoluteOutsideWorkspace)
      return { error: 'Inline comment path must be a repository-relative file path' };
    if (!Number.isSafeInteger(comment.line) || comment.line < 1)
      return { error: 'Inline comment line must be a positive integer' };
    if (comment.side !== 'RIGHT')
      return {
        error:
          'Only current RIGHT-side diff anchors are supported; keep deletion findings summary-only',
      };
    if (!comment.body.trim() || byteLength(comment.body) > MAX_WRITE_BODY_BYTES) {
      return { error: 'Inline comment body must be nonempty and at most 64 KiB' };
    }
    const key = JSON.stringify([path, comment.line, comment.body]);
    if (keys.has(key))
      return { error: `Exact duplicate inline comment in batch at ${path}:${comment.line}` };
    keys.add(key);
    normalized.push({ ...comment, path });
  }
  if (byteLength(JSON.stringify(normalized)) > MAX_FALLBACK_PATCH_BYTES) {
    return { error: 'Atomic review exceeds the 256 KiB publication budget' };
  }
  return { comments: normalized };
}

function rightDiffLines(
  patch: string,
  file: Pick<DiffFile, 'additions' | 'deletions' | 'changes'>
): Set<number> {
  const lines = new Set<number>();
  let oldRemaining = 0;
  let newRemaining = 0;
  let nextLine = 0;
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (oldRemaining || newRemaining)
        throw new GithubContextError('GitHub per-file patch is incomplete');
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      nextLine = Number(header[3]);
      if (![oldRemaining, newRemaining, nextLine].every(Number.isSafeInteger)) {
        throw new GithubContextError('GitHub per-file patch has invalid hunk coordinates');
      }
      hunks++;
    } else if (line.startsWith('\\ No newline at end of file')) {
      continue;
    } else if (hunks && (oldRemaining || newRemaining)) {
      if (line.startsWith('+')) {
        newRemaining--;
        additions++;
        lines.add(nextLine++);
      } else if (line.startsWith('-')) {
        oldRemaining--;
        deletions++;
      } else if (line.startsWith(' ')) {
        oldRemaining--;
        newRemaining--;
        lines.add(nextLine++);
      } else {
        throw new GithubContextError('GitHub per-file patch is incomplete');
      }
      if (oldRemaining < 0 || newRemaining < 0)
        throw new GithubContextError('GitHub per-file patch has invalid hunk lengths');
    } else if (line !== '') {
      throw new GithubContextError('GitHub per-file patch contains unsupported diff data');
    }
  }
  if (
    !hunks ||
    oldRemaining ||
    newRemaining ||
    additions !== file.additions ||
    deletions !== file.deletions ||
    additions + deletions !== file.changes
  ) {
    throw new GithubContextError(
      'GitHub per-file patch is incomplete; retrieve the captured file revisions'
    );
  }
  return lines;
}

function filePatchStatus(file: DiffFile): FileEvidence['patchStatus'] {
  if (file.patch === undefined) return 'binary_or_omitted';
  try {
    rightDiffLines(file.patch, file);
    return 'available';
  } catch (error) {
    if (error instanceof GithubContextError) return 'incomplete';
    throw error;
  }
}

export type GithubPublicationState = {
  contextIncompleteReasons?: string[];
  reviewReconciliationAttempts?: number;
  summaryReconciliationAttempts?: number;
  reviewId?: number;
  reviewPending?: boolean;
  reviewPendingFingerprint?: string;
  reviewFingerprint?: string;
  summaryCommentId?: number;
  summaryPending?: boolean;
  summaryPendingFingerprint?: string;
  summaryPendingCommentId?: number;
  summaryPublished?: boolean;
  summaryFingerprint?: string;
  summaryBodyHash?: string;
};
export type GithubPublicationDetails = {
  fingerprint: string;
  commentId?: number;
  bodyHash?: string;
  summary?: { content: SummaryContent; gateResult?: 'pass' | 'fail' };
};
export type GithubPublishedEvent = {
  kind: 'review' | 'summary';
  id?: number;
  fingerprint?: string;
  bodyHash?: string;
};
export type GithubProposalEvent = {
  kind: 'review' | 'summary';
  fingerprint: string;
  bodyHash?: string;
  summaryContent?: SummaryContent;
  gateResult?: 'pass' | 'fail';
  publishable: boolean;
  blockedReason?: string;
};

export function createGithubTools(options: {
  input: StartReviewInput;
  runId?: string;
  headSha: string;
  baseTipSha?: string;
  mergeBaseSha?: string;
  reviewSelection?: IsolateReviewSelection;
  historyState?: GithubHistoryState;
  onHistoryRequest?: () => Promise<void>;
  onHistoryCommits?: (shas: string[]) => Promise<void>;
  summaryOwnership?: { previousRunId: string; commentId: number; bodyHash: string };
  queuedPublication?: IsolateReviewPreparation['queued'];
  token?: string;
  client?: GithubClient;
  fetchImpl?: typeof globalThis.fetch;
  apiUrl?: string;
  publicationState?: GithubPublicationState;
  onPublicationStarted?: (
    kind: 'review' | 'summary',
    details?: GithubPublicationDetails
  ) => Promise<void>;
  onPublicationRejected?: (kind: 'review' | 'summary') => Promise<void>;
  onReconciliationStarted?: (kind: 'review' | 'summary') => Promise<void>;
  onPublished?: (event?: GithubPublishedEvent) => Promise<void>;
  onProposal?: (event: GithubProposalEvent) => Promise<void>;
  onContextIncomplete?: (reason: string) => void | Promise<void>;
  tools?: readonly GithubToolName[];
}): ToolSet {
  const { input, runId } = options;
  const queuedPublication = options.queuedPublication
    ? QueuedIsolatePublicationSchema.parse(options.queuedPublication)
    : undefined;
  const summaryOwnership = queuedPublication?.summaryTarget ?? options.summaryOwnership;
  if (
    queuedPublication &&
    (queuedPublication.identity.attemptId !== runId ||
      queuedPublication.identity.target.repoFullName !==
        `${input.owner}/${input.repo}`.toLowerCase() ||
      queuedPublication.identity.target.prNumber !== input.pullNumber ||
      queuedPublication.identity.snapshot.headSha !== options.headSha ||
      queuedPublication.identity.organizationId !== input.organizationId ||
      queuedPublication.identity.integrationId !== input.expectedIntegrationId ||
      queuedPublication.identity.executionUserId !== input.userId)
  )
    throw new Error('Canonical summary authority does not match this review');
  if (runId !== undefined && (!runId.trim() || runId.length > 256)) {
    throw new Error('Trusted review run identity is invalid');
  }
  const headSha = options.headSha.toLowerCase();
  const incrementalSelection =
    options.reviewSelection?.effectiveMode === 'incremental'
      ? {
          ...options.reviewSelection,
          previousHeadSha: options.reviewSelection.previousHeadSha.toLowerCase(),
        }
      : undefined;
  const token = options.token ?? input.gitToken;
  if (!options.client && !token) throw new Error('GitHub token is required for GitHub tools');
  const github =
    options.client ?? createGithubClient(token ?? '', options.fetchImpl, options.apiUrl);
  const apiOrigin = new URL(resolveGithubApiUrl(options.apiUrl)).origin;
  const basePath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
    throw new Error('pullNumber must be a positive integer');
  const pullPath = `${basePath}/pulls/${input.pullNumber}`;
  const issuePath = `${basePath}/issues/${input.pullNumber}`;
  const reviewPath = `${pullPath}/reviews`;
  const createSummaryPath = `${issuePath}/comments`;
  const dryRun = isDryRun(input.dryRun);
  const state: GithubPublicationState = { ...options.publicationState };
  const historySeed = z
    .object({
      requestCount: z.number().int().nonnegative().max(MAX_HISTORY_REQUESTS),
      commitShas: z.array(shaSchema).max(MAX_HISTORY_COMMITS),
    })
    .parse(options.historyState ?? { requestCount: 0, commitShas: [] });
  let historyRequestCount = historySeed.requestCount;
  const historyCommitShas = new Set(historySeed.commitShas);
  const writeAttempts = { review: 0, summary: 0 };
  const reconciliationAttempts = {
    review: state.reviewReconciliationAttempts ?? 0,
    summary: state.summaryReconciliationAttempts ?? 0,
  };
  let rejected: 'review' | 'summary' | undefined;
  let contextFailure = state.contextIncompleteReasons?.length
    ? state.contextIncompleteReasons[0] || 'Required GitHub context is incomplete'
    : undefined;
  let snapshot: ReviewSnapshot | undefined;
  let reviewFiles: FileEvidence[] | undefined;
  let currentPrFiles: FileEvidence[] | undefined;
  let currentPrFileSource: 'exact-compare' | 'guarded-pr-files' = 'exact-compare';
  let cachedPatchBytes = 0;
  let renameProofRequestCount = 0;
  let renameProofBytes = 0;
  let inlineCommentsComplete = false;
  let existingInlineKeys = new Set<string>();
  let reviewResult: { id: number } | undefined;
  let summaryResult: { id: number } | undefined;

  async function recordIncomplete(reason: string): Promise<void> {
    if (!contextFailure) {
      contextFailure = reason;
      await options.onContextIncomplete?.(reason);
    }
  }

  async function incomplete(reason: string): Promise<never> {
    await recordIncomplete(reason);
    throw new GithubContextError(reason);
  }

  async function required<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    try {
      const value = await operation();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      return incomplete(
        error instanceof GithubContextError
          ? error.message
          : 'Required GitHub context could not be retrieved'
      );
    }
  }

  async function read<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    beforeRequest?: () => Promise<void>
  ): Promise<GithubResponse<T>> {
    signal?.throwIfAborted();
    await beforeRequest?.();
    signal?.throwIfAborted();
    let response: GithubResponse<unknown>;
    try {
      response = await github.getResponse<unknown>(path, undefined, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        error instanceof GithubContextError ||
        (error instanceof GithubApiError && error.status < 500)
      )
        throw error;
      await beforeRequest?.();
      signal?.throwIfAborted();
      response = await github.getResponse<unknown>(path, undefined, signal);
    }
    signal?.throwIfAborted();
    return { ...response, data: parseExternal(schema, response.data, 'required response fields') };
  }

  async function reserveHistoryRequest(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (options.onHistoryRequest) {
      await options.onHistoryRequest();
    } else {
      if (historyRequestCount >= MAX_HISTORY_REQUESTS)
        throw new GithubContextError('GitHub history request budget exhausted');
      historyRequestCount++;
    }
    signal?.throwIfAborted();
  }

  async function historyRead<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return read(path, schema, signal, () => reserveHistoryRequest(signal));
  }

  async function optionalHistory<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
      const result = await operation();
      signal?.throwIfAborted();
      if (byteLength(JSON.stringify(result)) > MAX_FALLBACK_PATCH_BYTES)
        throw new GithubContextError('GitHub history output exceeds the 256 KiB budget');
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return {
        available: false,
        complete: false,
        limited: true,
        error:
          error instanceof GithubContextError
            ? error.message
            : 'Optional GitHub history is unavailable or could not be durably authorized',
      };
    }
  }

  async function rememberHistoryCommits(shas: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (new Set([...historyCommitShas, ...shas]).size > MAX_HISTORY_COMMITS)
      throw new GithubContextError('GitHub history discovered-commit budget exhausted');
    if (options.onHistoryCommits) await options.onHistoryCommits(shas);
    signal?.throwIfAborted();
    if (new Set([...historyCommitShas, ...shas]).size > MAX_HISTORY_COMMITS)
      throw new GithubContextError('GitHub history discovered-commit budget exhausted');
    for (const sha of shas) historyCommitShas.add(sha);
  }

  function allowedHistorySha(sha: string, signal?: AbortSignal): boolean {
    signal?.throwIfAborted();
    validateHeadSha(headSha);
    return (
      historyCommitShas.has(sha) ||
      [
        headSha,
        snapshot?.baseTipSha ?? options.baseTipSha ?? input.baseTipSha,
        snapshot?.mergeBaseSha ?? options.mergeBaseSha ?? input.mergeBaseSha,
        incrementalSelection?.previousHeadSha,
      ].some(captured => captured?.toLowerCase() === sha)
    );
  }

  function commitMetadata(commit: z.infer<typeof historyCommitSchema>) {
    const preview = textChunk(commit.commit.message, 0, MAX_COMMENT_BODY_LENGTH);
    return {
      sha: commit.sha,
      message: preview.body,
      messageTruncated: preview.bodyTruncated,
      messageBytes: preview.originalBytes,
      author: commit.commit.author,
      parents: commit.parents.map(parent => parent.sha),
    };
  }

  async function fileContent(
    path: string,
    sha: string,
    offset: number,
    signal?: AbortSignal,
    history = false
  ) {
    const endpoint = `${basePath}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
    const content = (await (history ? historyRead : read)(endpoint, contentSchema, signal)).data;
    if (content.path !== path || content.submodule_git_url || content.target)
      throw new GithubContextError('Non-file, symlink, or submodule content is unsupported');
    const base64 = content.content.replace(/[\r\n]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      throw new GithubContextError('GitHub returned invalid base64 file content');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== content.size)
      throw new GithubContextError('GitHub file content size does not match its metadata');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('binary');
    } catch {
      throw new GithubContextError('Binary or non-UTF-8 file content is unsupported');
    }
    return {
      path,
      sha,
      blobSha: content.sha,
      found: true,
      ...textChunk(text, offset, MAX_RETRIEVAL_BYTES),
    };
  }

  async function getSnapshot(signal?: AbortSignal): Promise<ReviewSnapshot> {
    if (!snapshot) {
      validateHeadSha(headSha);
      const baseTipSha = options.baseTipSha ?? input.baseTipSha;
      const mergeBaseSha = options.mergeBaseSha ?? input.mergeBaseSha;
      if (baseTipSha !== undefined && mergeBaseSha !== undefined) {
        validateHeadSha(baseTipSha);
        validateHeadSha(mergeBaseSha);
        snapshot = {
          headSha,
          baseTipSha: baseTipSha.toLowerCase(),
          mergeBaseSha: mergeBaseSha.toLowerCase(),
        };
      } else {
        snapshot = await resolveReviewSnapshot(
          github,
          { ...input, headSha, baseTipSha, mergeBaseSha },
          signal
        );
      }
    }
    signal?.throwIfAborted();
    return snapshot;
  }

  async function currentPull(signal?: AbortSignal): Promise<PullRequest> {
    const captured = await getSnapshot(signal);
    const { data: pull } = await read(pullPath, pullSchema, signal);
    if (pull.head.sha !== captured.headSha)
      throw new GithubContextError('Pull request head changed; refusing stale review evidence');
    if (pull.base.sha !== captured.baseTipSha)
      throw new GithubContextError('Pull request base changed; refusing mixed review evidence');
    return pull;
  }

  const matchesPaginationPath = createPaginationPathMatcher(
    async (repositoryPath, signal) => (await read(repositoryPath, repositorySchema, signal)).data.id
  );

  async function nextPage(
    headers: Headers,
    path: string,
    page: number,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    const next = linkUrl(headers.get('Link'), 'next');
    if (!next) return undefined;
    const url = new URL(next, resolveGithubApiUrl(options.apiUrl));
    if (
      url.origin !== apiOrigin ||
      url.username ||
      url.password ||
      Number(url.searchParams.get('page')) !== page + 1 ||
      !(await matchesPaginationPath(url.pathname, path, signal))
    ) {
      throw new GithubContextError('GitHub pagination returned an invalid scoped continuation');
    }
    return page + 1;
  }

  async function pageOf<T>(
    path: string,
    schema: z.ZodType<T>,
    page: number,
    signal?: AbortSignal,
    query = ''
  ) {
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_GITHUB_PAGES) {
      throw new GithubContextError('GitHub pagination exceeds the 50-page retrieval budget');
    }
    const response = await read(
      `${path}?per_page=${PAGE_SIZE}&page=${page}${query}`,
      z.array(schema).max(PAGE_SIZE),
      signal
    );
    return { ...response, nextPage: await nextPage(response.headers, path, page, signal) };
  }

  async function walk<T>(
    path: string,
    schema: z.ZodType<T>,
    visit: (value: T, index: number, page: number) => Promise<void> | void,
    signal?: AbortSignal,
    query = ''
  ) {
    let page: number | undefined = 1;
    let count = 0;
    let bytes = 0;
    while (page !== undefined) {
      const response: GithubResponse<T[]> & { nextPage?: number } = await pageOf(
        path,
        schema,
        page,
        signal,
        query
      );
      bytes += responseBytes(response);
      if (
        bytes > MAX_GITHUB_TRAVERSAL_BYTES ||
        count + response.data.length > MAX_CONTEXT_RECORDS
      ) {
        throw new GithubContextError(
          'GitHub context exceeds the 8 MiB or 5,000-record traversal budget'
        );
      }
      for (const value of response.data) {
        signal?.throwIfAborted();
        await visit(value, count++, page);
      }
      page = response.nextPage;
    }
    return count;
  }

  async function compare(comparison: FileComparison, signal?: AbortSignal) {
    const captured = await getSnapshot(signal);
    const previous = comparison === 'review' ? incrementalSelection?.previousHeadSha : undefined;
    if (previous !== undefined) {
      validateHeadSha(previous);
      if (previous === captured.headSha)
        throw new GithubContextError('An unchanged head cannot be an incremental review');
    }
    const result = await read(
      `${basePath}/compare/${previous ?? captured.baseTipSha}...${captured.headSha}?per_page=1`,
      previous ? incrementalCompareSchema : compareSchema,
      signal
    );
    if (previous) {
      const delta = incrementalComparisonFiles(result.data, previous);
      if ('fallbackReason' in delta) {
        throw new GithubContextError(
          `Incremental comparison failed (${delta.fallbackReason}); review scope cannot change after investigation starts`
        );
      }
      if (delta.files.length !== incrementalSelection?.changedFileCount) {
        throw new GithubContextError('Incremental comparison differs from the selected file count');
      }
      return delta.files;
    }
    if (
      result.data.base_commit.sha !== captured.baseTipSha ||
      result.data.merge_base_commit.sha !== captured.mergeBaseSha
    ) {
      throw new GithubContextError(
        'GitHub comparison does not match the captured base tip and merge base'
      );
    }
    return result.data.files;
  }

  function createRenameProofReader<T extends { sha: string }>(
    endpoint: 'commits' | 'trees',
    schema: z.ZodType<T>
  ) {
    const cache = new Map<string, T>();
    const inFlight = new Map<string, { signal?: AbortSignal; promise: Promise<T> }>();
    return async (sha: string, signal?: AbortSignal): Promise<T> => {
      signal?.throwIfAborted();
      const cached = cache.get(sha);
      if (cached) return cached;
      let pending = inFlight.get(sha);
      if (!pending || pending.signal !== signal) {
        const promise = read(`${basePath}/git/${endpoint}/${sha}`, schema, signal, async () => {
          if (renameProofRequestCount >= MAX_RENAME_PROOF_REQUESTS)
            throw new GithubContextError('GitHub rename proof request budget exhausted');
          if (renameProofBytes >= MAX_GITHUB_TRAVERSAL_BYTES)
            throw new GithubContextError('GitHub rename proof metadata byte budget exhausted');
          renameProofRequestCount++;
        }).then(response => {
          signal?.throwIfAborted();
          const bytes = responseBytes(response);
          renameProofBytes += bytes;
          if (bytes > MAX_GITHUB_RESPONSE_BYTES || renameProofBytes > MAX_GITHUB_TRAVERSAL_BYTES)
            throw new GithubContextError('GitHub rename proof metadata byte budget exhausted');
          if (response.data.sha !== sha || linkUrl(response.headers.get('Link'), 'next'))
            throw new GithubContextError('GitHub returned mismatched or incomplete Git metadata');
          cache.set(sha, response.data);
          return response.data;
        });
        pending = { signal, promise };
        inFlight.set(sha, pending);
      }
      try {
        const value = await pending.promise;
        signal?.throwIfAborted();
        return value;
      } finally {
        if (inFlight.get(sha) === pending) inFlight.delete(sha);
      }
    };
  }

  const readGitCommit = createRenameProofReader('commits', gitCommitSchema);
  const readGitTree = createRenameProofReader('trees', gitTreeSchema);

  async function regularFileMode(
    path: string,
    commitSha: string,
    blobSha: string,
    signal?: AbortSignal
  ): Promise<'100644' | '100755' | undefined> {
    const parts = path.split('/');
    let treeSha = (await readGitCommit(commitSha, signal)).tree.sha;
    const visited = new Set<string>();
    for (let index = 0; index < parts.length; index++) {
      if (visited.has(treeSha))
        throw new GithubContextError('GitHub returned cyclic Git tree metadata');
      visited.add(treeSha);
      const tree = await readGitTree(treeSha, signal);
      const entry = tree.tree.find(entry => entry.path === parts[index]);
      if (!entry) return undefined;
      if (index === parts.length - 1) {
        return entry.type === 'blob' &&
          (entry.mode === '100644' || entry.mode === '100755') &&
          entry.sha === blobSha
          ? entry.mode
          : undefined;
      }
      if (entry.type !== 'tree' || entry.mode !== '040000') return undefined;
      treeSha = entry.sha;
    }
    return undefined;
  }

  async function isContentPreservingRename(
    file: DiffFile,
    comparison: FileComparison,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (
      file.status !== 'renamed' ||
      !file.previous_filename ||
      file.previous_filename === file.filename ||
      file.additions !== 0 ||
      file.deletions !== 0 ||
      file.changes !== 0 ||
      (file.patch !== undefined && file.patch !== '')
    ) {
      return false;
    }
    const captured = await getSnapshot(signal);
    const oldSha =
      comparison === 'review' && incrementalSelection
        ? incrementalSelection.previousHeadSha
        : captured.mergeBaseSha;
    try {
      const previousMode = await regularFileMode(file.previous_filename, oldSha, file.sha, signal);
      return (
        previousMode !== undefined &&
        previousMode === (await regularFileMode(file.filename, captured.headSha, file.sha, signal))
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return false;
    }
  }

  async function getFiles(
    comparison: FileComparison,
    signal?: AbortSignal
  ): Promise<FileEvidence[]> {
    const delta = comparison === 'review' && incrementalSelection !== undefined;
    const cached = delta ? reviewFiles : currentPrFiles;
    if (cached) return cached;
    const before = await currentPull(signal);
    if (!delta && before.changed_files > MAX_PR_FILES)
      throw new GithubContextError('PRs exceeding 3,000 changed files are unsupported');
    const compared = await compare(comparison, signal);
    const evidence: FileEvidence[] = [];
    const names = new Set<string>();
    async function add(file: DiffFile, page?: number) {
      if (
        names.has(file.filename) ||
        toRepoRelativePath(file.filename) !== file.filename ||
        (file.previous_filename !== undefined &&
          toRepoRelativePath(file.previous_filename) !== file.previous_filename) ||
        (file.status === 'renamed' && !file.previous_filename)
      ) {
        throw new GithubContextError('GitHub returned duplicate or invalid changed-file metadata');
      }
      names.add(file.filename);
      const metadataOnly = await isContentPreservingRename(file, comparison, signal);
      const patch = metadataOnly ? '' : file.patch;
      const patchStatus = metadataOnly ? 'available' : filePatchStatus(file);
      const patchBytes = patch === undefined ? null : byteLength(patch);
      const retain =
        patchStatus === 'available' &&
        patchBytes !== null &&
        cachedPatchBytes + patchBytes <= MAX_PATCH_CACHE_BYTES;
      if (retain) cachedPatchBytes += patchBytes;
      evidence.push({
        ...file,
        patch: retain ? patch : undefined,
        patchLength: patch?.length ?? null,
        patchBytes,
        patchStatus,
        ...(page === undefined ? {} : { page }),
      });
    }
    if (delta || (compared.length < MAX_DIFF_FILES && compared.length === before.changed_files)) {
      for (const file of compared) await add(file);
    } else {
      currentPrFileSource = 'guarded-pr-files';
      await currentPull(signal);
      await walk(
        `${pullPath}/files`,
        fileSchema,
        (file, index, page) => {
          if (index >= MAX_PR_FILES)
            throw new GithubContextError('PR-file pagination exceeds 3,000 files');
          return add(file, page);
        },
        signal
      );
    }
    const after = await currentPull(signal);
    if (
      !delta &&
      (evidence.length !== before.changed_files || evidence.length !== after.changed_files)
    ) {
      throw new GithubContextError(
        'GitHub changed-file listing is incomplete for the captured snapshot'
      );
    }
    if (delta) reviewFiles = evidence;
    else currentPrFiles = evidence;
    if (
      (delta || !incrementalSelection) &&
      evidence.some(file => file.patchStatus !== 'available')
    ) {
      await recordIncomplete(
        'Required GitHub patch evidence is incomplete or unavailable; complete revision recovery is unsupported'
      );
    }
    return evidence;
  }

  async function getPatch(
    file: FileEvidence,
    comparison: FileComparison,
    signal?: AbortSignal
  ): Promise<string> {
    if (file.patchStatus !== 'available')
      throw new GithubContextError(
        'GitHub per-file patch is incomplete or unavailable; retrieve captured file revisions instead'
      );
    if (file.patch !== undefined) return file.patch;
    await currentPull(signal);
    const candidates =
      file.page === undefined
        ? await compare(comparison, signal)
        : (await pageOf(`${pullPath}/files`, fileSchema, file.page, signal)).data;
    await currentPull(signal);
    const found = candidates.find(candidate => candidate.filename === file.filename);
    if (
      !found ||
      found.sha !== file.sha ||
      found.status !== file.status ||
      found.previous_filename !== file.previous_filename ||
      found.additions !== file.additions ||
      found.deletions !== file.deletions ||
      found.changes !== file.changes ||
      found.patch === undefined ||
      found.patch.length !== file.patchLength ||
      byteLength(found.patch) !== file.patchBytes
    ) {
      throw new GithubContextError('GitHub could not recover the captured per-file patch');
    }
    rightDiffLines(found.patch, file);
    return found.patch;
  }

  function checkScope(comment: InlineComment | IssueComment | Review): void {
    const matches =
      'issue_url' in comment
        ? belongsTo(comment.issue_url, issuePath, apiOrigin)
        : belongsTo(comment.pull_request_url, pullPath, apiOrigin);
    if (!matches)
      throw new GithubContextError(
        'GitHub comment does not belong to the current repository and pull request'
      );
  }

  async function scanInline(signal?: AbortSignal) {
    inlineCommentsComplete = false;
    const keys = new Set<string>();
    const ids = new Set<number>();
    const previews: ReturnType<typeof projectComment>[] = [];
    let outputBytes = 0;
    let previewComplete = false;
    let rootCount = 0;
    let activeRootCount = 0;
    const count = await walk(
      `${pullPath}/comments`,
      inlineCommentSchema,
      async comment => {
        checkScope(comment);
        if (ids.has(comment.id))
          throw new GithubContextError(
            'Inline comment pagination repeated a record; completeness is unknown'
          );
        ids.add(comment.id);
        if (comment.in_reply_to_id == null) rootCount++;
        if (
          comment.in_reply_to_id == null &&
          comment.subject_type === 'line' &&
          comment.line !== null &&
          comment.side === 'RIGHT'
        ) {
          activeRootCount++;
          keys.add(JSON.stringify([comment.path, comment.line, await hashText(comment.body)]));
        }
        if (!previewComplete) {
          const projected = projectComment(comment, 'inline');
          const bytes = byteLength(JSON.stringify(projected));
          if (
            previews.length < MAX_INLINE_COMMENTS &&
            outputBytes + bytes <= MAX_CATEGORY_OUTPUT_BYTES
          ) {
            previews.push(projected);
            outputBytes += bytes;
          } else previewComplete = true;
        }
      },
      signal,
      '&sort=created&direction=asc'
    );
    existingInlineKeys = keys;
    inlineCommentsComplete = true;
    return { previews, count, rootCount, activeRootCount };
  }

  async function scanIssues(signal?: AbortSignal) {
    const previews: ReturnType<typeof projectComment>[] = [];
    const summaries: ReturnType<typeof projectComment>[] = [];
    const markedIds: number[] = [];
    const ids = new Set<number>();
    let outputBytes = 0;
    let summaryBytes = 0;
    let previewComplete = false;
    const count = await walk(
      createSummaryPath,
      issueCommentSchema,
      comment => {
        checkScope(comment);
        if (ids.has(comment.id))
          throw new GithubContextError(
            'Issue comment pagination repeated a record; completeness is unknown'
          );
        ids.add(comment.id);
        const projected = projectComment(comment, 'issue');
        const bytes = byteLength(JSON.stringify(projected));
        if (
          comment.body.includes(SUMMARY_MARKER) &&
          (!queuedPublication || (comment.user?.type === 'Bot' && isKiloBotUser(comment.user)))
        ) {
          markedIds.push(comment.id);
          if (summaries.length < 20 && summaryBytes + bytes <= MAX_CATEGORY_OUTPUT_BYTES) {
            summaries.push(projected);
            summaryBytes += bytes;
          }
        }
        if (!previewComplete) {
          if (
            previews.length < MAX_COMMENTS_PER_CATEGORY &&
            outputBytes + bytes <= MAX_CATEGORY_OUTPUT_BYTES
          ) {
            previews.push(projected);
            outputBytes += bytes;
          } else previewComplete = true;
        }
      },
      signal
    );
    return { previews, summaries, markedIds, count };
  }

  async function summaryPreflight(
    signal?: AbortSignal
  ): Promise<{ commentId?: number; blockedReason?: string }> {
    const issues = await scanIssues(signal);
    const publicationRestriction = eligibility(await currentPull(signal));
    const parsed = queuedPublication
      ? QueuedIsolatePublicationSchema.shape.summaryTarget.unwrap().safeParse(summaryOwnership)
      : ownershipSchema.safeParse(summaryOwnership);
    if (!parsed.success) {
      if (
        issues.markedIds.length ||
        input.existingSummaryCommentId !== undefined ||
        summaryOwnership !== undefined
      ) {
        return {
          blockedReason:
            'Existing summary ownership is unknown; a confirmed previous candidate run and body hash are required',
        };
      }
      return { blockedReason: publicationRestriction };
    }
    const proof = parsed.data;
    if (
      (input.previousRunId !== undefined &&
        (!('previousRunId' in proof) || input.previousRunId !== proof.previousRunId)) ||
      (input.existingSummaryCommentId !== undefined &&
        input.existingSummaryCommentId !== proof.commentId)
    ) {
      return {
        blockedReason:
          'Summary ownership proof does not match the requested previous run or comment',
      };
    }
    if (issues.markedIds.some(id => id !== proof.commentId)) {
      return { blockedReason: 'Another marked summary conflicts with the candidate-owned target' };
    }
    let existing: IssueComment;
    try {
      existing = (
        await read(`${basePath}/issues/comments/${proof.commentId}`, issueCommentSchema, signal)
      ).data;
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404)
        return { blockedReason: 'Candidate-owned summary no longer exists' };
      throw error;
    }
    if (
      existing.id !== proof.commentId ||
      !belongsTo(existing.issue_url, issuePath, apiOrigin) ||
      !existing.body.startsWith(SUMMARY_MARKER) ||
      !isKiloBotUser(existing.user)
    ) {
      return {
        blockedReason: 'Summary target failed bot, marker, or pull-request ownership validation',
      };
    }
    if (
      'appId' in proof &&
      (existing.user?.id !== proof.authorId ||
        existing.user.type !== 'Bot' ||
        existing.user.login !== proof.authorLogin ||
        existing.performed_via_github_app?.id !== proof.appId)
    )
      return { blockedReason: 'Canonical summary app or author changed' };
    if (!queuedPublication && SERVER_BLOCK_PATTERN.test(existing.body))
      return { blockedReason: 'Summary contains server-owned history, usage, or guidance blocks' };
    const bodyHash = await hashText(existing.body);
    signal?.throwIfAborted();
    if (bodyHash !== proof.bodyHash)
      return {
        blockedReason: 'Candidate-owned summary body changed since its confirmed publication',
      };
    return { commentId: proof.commentId, blockedReason: publicationRestriction };
  }

  function eligibility(pull: PullRequest): string | undefined {
    if (pull.state !== 'open' || pull.draft !== false)
      return 'Pull request must be open and not a draft; refusing publication';
    if (input.expectedAppType === 'lite') return 'GitHub Lite installations cannot publish reviews';
    return undefined;
  }

  async function proposal(event: GithubProposalEvent, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (contextFailure) throw new GithubContextError(contextFailure);
    await options.onProposal?.(event);
    signal?.throwIfAborted();
  }

  function blocked(reason: string) {
    const partial = Boolean(state.reviewId || state.summaryPublished);
    return {
      error: reason,
      publishable: false,
      blockedReason: reason,
      partial,
      publicationOutcome:
        state.reviewPending || state.summaryPending ? 'uncertain' : partial ? 'partial' : 'blocked',
    };
  }

  async function clearRejected(kind: 'review' | 'summary') {
    await options.onPublicationRejected?.(kind);
    if (kind === 'review') {
      state.reviewPending = false;
      state.reviewPendingFingerprint = undefined;
    } else {
      state.summaryPending = false;
      state.summaryPendingFingerprint = undefined;
      state.summaryPendingCommentId = undefined;
    }
    rejected = undefined;
  }

  async function authorize(
    kind: 'review' | 'summary',
    details: GithubPublicationDetails,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    if (state.reviewPending || state.summaryPending)
      throw new Error('A publication is pending; no new write is authorized');
    if (contextFailure) throw new GithubContextError(contextFailure);
    if (writeAttempts[kind] >= MAX_PUBLICATION_ATTEMPTS)
      throw new Error('Publication retry budget exhausted; no further write is authorized');
    if (kind === 'review') {
      state.reviewPending = true;
      state.reviewPendingFingerprint = details.fingerprint;
    } else {
      state.summaryPending = true;
      state.summaryPendingFingerprint = details.fingerprint;
      state.summaryPendingCommentId = details.commentId;
    }
    await options.onPublicationStarted?.(kind, details);
    signal?.throwIfAborted();
    if (contextFailure) throw new GithubContextError(contextFailure);
    writeAttempts[kind]++;
  }

  async function confirmReview(result: { id: number }, fingerprint: string) {
    reviewResult = result;
    state.reviewId = result.id;
    state.reviewFingerprint = fingerprint;
    await options.onPublished?.({ kind: 'review', id: result.id, fingerprint });
    state.reviewPending = false;
    state.reviewPendingFingerprint = undefined;
    return result;
  }

  async function confirmSummary(result: { id: number }, fingerprint: string, bodyHash: string) {
    summaryResult = result;
    state.summaryCommentId = result.id;
    state.summaryFingerprint = fingerprint;
    state.summaryBodyHash = bodyHash;
    await options.onPublished?.({ kind: 'summary', id: result.id, fingerprint, bodyHash });
    state.summaryPending = false;
    state.summaryPendingFingerprint = undefined;
    state.summaryPendingCommentId = undefined;
    state.summaryPublished = true;
    return result;
  }

  async function startReconciliation(kind: 'review' | 'summary', signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (reconciliationAttempts[kind] >= MAX_PUBLICATION_ATTEMPTS) {
      throw new Error('Publication is pending; reconciliation budget exhausted');
    }
    reconciliationAttempts[kind]++;
    await options.onReconciliationStarted?.(kind);
    signal?.throwIfAborted();
  }

  async function reconcileReview(
    comments: ReviewComment[],
    fingerprint: string,
    signal?: AbortSignal
  ) {
    if (!state.reviewPendingFingerprint || state.reviewPendingFingerprint !== fingerprint) {
      throw new Error('Review publication fingerprint does not match the pending operation');
    }
    if (reviewResult) return confirmReview(reviewResult, fingerprint);
    const candidates: Review[] = [];
    await startReconciliation('review', signal);
    await required(
      () =>
        walk(
          reviewPath,
          reviewSchema,
          review => {
            checkScope(review);
            if (
              review.commit_id === headSha &&
              review.body === '' &&
              review.state === 'COMMENTED' &&
              isKiloBotUser(review.user)
            ) {
              if (candidates.length >= 10)
                throw new GithubContextError(
                  'Too many matching reviews for bounded publication reconciliation'
                );
              candidates.push(review);
            }
          },
          signal
        ),
      signal
    );
    let matched: { id: number } | undefined;
    for (const review of candidates) {
      const actual: ReviewComment[] = [];
      await required(
        () =>
          walk(
            `${reviewPath}/${review.id}/comments`,
            inlineCommentSchema,
            comment => {
              checkScope(comment);
              if (
                comment.line !== null &&
                comment.side !== null &&
                comment.side !== undefined &&
                comment.in_reply_to_id == null
              ) {
                actual.push({
                  path: comment.path,
                  line: comment.line,
                  side: comment.side,
                  body: comment.body,
                });
              } else {
                throw new GithubContextError(
                  'Pending review comment targets can no longer be proven'
                );
              }
              if (actual.length > MAX_REVIEW_COMMENTS)
                throw new GithubContextError('Pending review exceeds the atomic comment budget');
            },
            signal
          ),
        signal
      );
      const actualFingerprint = await publicationFingerprint('review', headSha, reviewPath, {
        commit_id: headSha,
        event: 'COMMENT',
        body: '',
        comments: actual,
      });
      signal?.throwIfAborted();
      if (actual.length !== comments.length || actualFingerprint !== fingerprint) continue;
      if (matched)
        throw new Error('Review publication is pending; multiple matching GitHub reviews exist');
      matched = { id: review.id };
    }
    if (!matched)
      throw new Error('Review publication is pending; no matching GitHub review could be proven');
    return confirmReview(matched, fingerprint);
  }

  async function reconcileSummary(
    body: string,
    fingerprint: string,
    bodyHash: string,
    signal?: AbortSignal,
    operationMarker?: string
  ) {
    if (!state.summaryPendingFingerprint || state.summaryPendingFingerprint !== fingerprint) {
      throw new Error('Summary publication fingerprint does not match the pending operation');
    }
    if (summaryResult) return confirmSummary(summaryResult, fingerprint, bodyHash);
    if (state.summaryPendingCommentId === undefined && !operationMarker) {
      throw new Error(
        'Summary publication is pending; trusted run identity is required to prove creation origin'
      );
    }
    await startReconciliation('summary', signal);
    let matched: { id: number } | undefined;
    let matches = 0;
    function match(comment: IssueComment) {
      if (
        comment.body !== body ||
        (state.summaryPendingCommentId === undefined &&
          (!operationMarker || !comment.body.includes(operationMarker))) ||
        !isKiloBotUser(comment.user) ||
        !belongsTo(comment.issue_url, issuePath, apiOrigin)
      )
        return;
      matches++;
      matched = { id: comment.id };
    }
    if (state.summaryPendingCommentId !== undefined) {
      const comment = await required(
        () =>
          read(
            `${basePath}/issues/comments/${state.summaryPendingCommentId}`,
            issueCommentSchema,
            signal
          ),
        signal
      );
      if (comment.data.id === state.summaryPendingCommentId) match(comment.data);
    } else {
      await required(() => walk(createSummaryPath, issueCommentSchema, match, signal), signal);
    }
    if (matches > 1)
      throw new Error('Summary publication is pending; multiple matching GitHub comments exist');
    if (!matched)
      throw new Error('Summary publication is pending; no matching GitHub comment could be proven');
    return confirmSummary(matched, fingerprint, bodyHash);
  }

  const allTools: ToolSet = {
    pr_view: tool({
      description:
        'View current PR metadata, verifying the captured head and base snapshot. Omit bodyHash on the first page; when continuing, pass the exact returned offset and bodyHash.',
      inputSchema: z.object({ offset: z.number().optional(), bodyHash: z.string().optional() }),
      execute: async ({ offset = 0, bodyHash }, { abortSignal }) =>
        required(async () => {
          const pull = await currentPull(abortSignal);
          const body = pull.body ?? '';
          const hash = await hashText(body);
          if ((offset > 0 && !bodyHash) || (bodyHash && bodyHash !== hash))
            throw new GithubContextError(
              'PR description changed or continuation lacks its body hash'
            );
          const chunk = textChunk(body, offset, MAX_RETRIEVAL_BYTES);
          return {
            ...pull,
            author: pull.user?.login,
            ...chunk,
            bodyHash: hash,
            snapshot: await getSnapshot(abortSignal),
            retrieval: { tool: 'pr_view', offset: chunk.nextOffset, bodyHash: hash },
          };
        }, abortSignal),
    }),
    pr_diff: tool({
      description:
        'Read selected review changes or the full current PR with bounded patch previews. Defaults to review; only current-pr anchors can publish.',
      inputSchema: z.object({
        cursor: z.number().optional(),
        comparison: z.enum(['review', 'current-pr']).optional(),
      }),
      execute: async ({ cursor = 0, comparison = 'review' }, { abortSignal }) => {
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          return { error: 'cursor must be a nonnegative integer' };
        if (comparison !== 'review' && comparison !== 'current-pr')
          return { error: 'comparison must be review or current-pr' };
        const oldRevision =
          comparison === 'review' && incrementalSelection ? 'previous' : 'merge-base';
        return required(async () => {
          await currentPull(abortSignal);
          const evidence = await getFiles(comparison, abortSignal);
          if (cursor > evidence.length) return { error: 'cursor is outside the changed-file list' };
          const projected: Record<string, unknown>[] = [];
          let bytes = 0;
          let index = cursor;
          for (; index < evidence.length && projected.length < MAX_DIFF_FILES; index++) {
            const file = evidence[index];
            const { patch, page: _page, patchLength, patchBytes, ...metadata } = file;
            const preview =
              patch === undefined
                ? undefined
                : textChunk(
                    patch,
                    0,
                    Math.min(MAX_RETRIEVAL_BYTES, Math.max(0, MAX_FALLBACK_PATCH_BYTES - bytes))
                  );
            const item = {
              ...metadata,
              patch: preview?.body,
              patchComplete: file.patchStatus === 'available',
              bodyTruncated: patchLength !== null && (preview?.body.length ?? 0) < patchLength,
              originalLength: patchLength,
              originalBytes: patchBytes,
              oldPath: file.previous_filename ?? file.filename,
              oldRevision,
              retrieval:
                file.patchStatus === 'available'
                  ? { tool: 'pr_file_patch', path: file.filename, comparison, offset: 0 }
                  : [
                      { tool: 'pr_file', path: file.filename, revision: 'head', offset: 0 },
                      { tool: 'pr_file', path: file.filename, revision: oldRevision, offset: 0 },
                    ],
            };
            const itemBytes = byteLength(JSON.stringify(item));
            if (projected.length && bytes + itemBytes > MAX_FALLBACK_PATCH_BYTES) break;
            bytes += itemBytes;
            projected.push(item);
          }
          await currentPull(abortSignal);
          return {
            snapshot: await getSnapshot(abortSignal),
            comparison,
            previousHeadSha:
              oldRevision === 'previous' ? incrementalSelection?.previousHeadSha : undefined,
            source:
              comparison === 'review' && incrementalSelection
                ? 'exact-compare'
                : currentPrFileSource,
            files: projected,
            fileCount: evidence.length,
            filesComplete: true,
            patchesComplete: evidence.every(file => file.patchStatus === 'available'),
            contextComplete: !contextFailure,
            truncated:
              index < evidence.length ||
              projected.some(file => file.bodyTruncated || file.patchStatus !== 'available'),
            nextCursor: index < evidence.length ? index : null,
          };
        }, abortSignal);
      },
    }),
    pr_file_patch: tool({
      description:
        'Retrieve a selected review or full current-PR patch in 32 KiB chunks. Defaults to review; missing patches remain explicitly incomplete.',
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().optional(),
        comparison: z.enum(['review', 'current-pr']).optional(),
      }),
      execute: async ({ path, offset = 0, comparison = 'review' }, { abortSignal }) => {
        if (comparison !== 'review' && comparison !== 'current-pr')
          return { error: 'comparison must be review or current-pr' };
        if (!Number.isSafeInteger(offset) || offset < 0)
          return { error: 'offset must be a nonnegative integer' };
        const oldRevision =
          comparison === 'review' && incrementalSelection ? 'previous' : 'merge-base';
        return required(async () => {
          await currentPull(abortSignal);
          const file = (await getFiles(comparison, abortSignal)).find(
            file => file.filename === path
          );
          if (!file)
            return { error: 'path must be a changed-file path in the requested comparison' };
          if (file.patchStatus !== 'available') {
            return {
              path,
              comparison,
              patchStatus: file.patchStatus,
              patchComplete: false,
              contextComplete: false,
              snapshot: await getSnapshot(abortSignal),
              bodyTruncated: file.patchStatus === 'incomplete',
              originalLength: file.patchLength,
              originalBytes: file.patchBytes,
              retrieval: [
                { tool: 'pr_file', path, revision: 'head', offset: 0 },
                { tool: 'pr_file', path, revision: oldRevision, offset: 0 },
              ],
            };
          }
          const patch = await getPatch(file, comparison, abortSignal);
          const chunk = textChunk(patch, offset, MAX_RETRIEVAL_BYTES);
          return {
            path,
            comparison,
            ...chunk,
            patchStatus: 'available',
            patchComplete: true,
            contextComplete: !contextFailure,
            snapshot: await getSnapshot(abortSignal),
            retrieval: { tool: 'pr_file_patch', path, comparison, offset: chunk.nextOffset },
          };
        }, abortSignal);
      },
    }),
    pr_history: tool({
      description:
        'Read commit history pinned to the captured head, optionally by path: 20 records per page, pages 1-5. Messages are previews; parents do not authorize traversal.',
      inputSchema: z.object({ path: z.string().optional(), page: z.number().optional() }),
      execute: async ({ path, page = 1 }, { abortSignal }) => {
        if (!Number.isSafeInteger(page) || page < 1 || page > MAX_HISTORY_PAGES)
          return { error: 'history page must be an integer between 1 and 5' };
        const relativePath = path === undefined ? undefined : toRepoRelativePath(path);
        if (path !== undefined && (!relativePath || relativePath.length > 4_096))
          return { error: 'history path must be a repository-relative path' };
        return optionalHistory(async () => {
          validateHeadSha(headSha);
          const query = new URLSearchParams({
            sha: headSha,
            per_page: String(HISTORY_PAGE_SIZE),
            page: String(page),
          });
          if (relativePath !== undefined) query.set('path', relativePath);
          const response = await historyRead(
            `${basePath}/commits?${query.toString()}`,
            z.array(historyCommitSchema).max(HISTORY_PAGE_SIZE),
            abortSignal
          );
          const shas = response.data.map(commit => commit.sha);
          if (new Set(shas).size !== shas.length)
            throw new GithubContextError('GitHub history returned duplicate commit records');
          const hasMore =
            response.data.length === HISTORY_PAGE_SIZE ||
            linkUrl(response.headers.get('Link'), 'next') !== undefined;
          const result = {
            available: true,
            headSha,
            path: relativePath,
            page,
            pageSize: HISTORY_PAGE_SIZE,
            commits: response.data.map(commitMetadata),
            pageComplete: true,
            complete: page === 1 && !hasMore,
            limited: hasMore && page === MAX_HISTORY_PAGES,
            nextPage: hasMore && page < MAX_HISTORY_PAGES ? page + 1 : null,
          };
          if (byteLength(JSON.stringify(result)) > MAX_FALLBACK_PATCH_BYTES)
            throw new GithubContextError('GitHub history output exceeds the 256 KiB budget');
          await rememberHistoryCommits(shas, abortSignal);
          return result;
        }, abortSignal);
      },
    }),
    pr_commit: tool({
      description:
        'Read metadata and an optional 32 KiB file patch from a captured or history-authorized commit. Only the first 100 changed files are supported; parents are not automatically authorized.',
      inputSchema: z.object({
        sha: z.string(),
        path: z.string().optional(),
        offset: z.number().optional(),
      }),
      execute: async ({ sha, path, offset = 0 }, { abortSignal }) => {
        const parsedSha = shaSchema.safeParse(sha);
        if (!parsedSha.success) return { error: 'sha must be a full authorized commit SHA' };
        const relativePath = path === undefined ? undefined : toRepoRelativePath(path);
        if (path !== undefined && (!relativePath || relativePath.length > 4_096))
          return { error: 'commit path must be a repository-relative path' };
        if (!Number.isSafeInteger(offset) || offset < 0 || (offset !== 0 && path === undefined))
          return { error: 'offset must be a nonnegative integer for a requested file patch' };
        return optionalHistory(async () => {
          const commitSha = parsedSha.data;
          if (!allowedHistorySha(commitSha, abortSignal))
            throw new GithubContextError(
              'Commit SHA is not in the captured snapshot or trusted history allowlist'
            );
          const response = await historyRead(
            `${basePath}/commits/${commitSha}?per_page=${PAGE_SIZE}&page=1`,
            commitDetailsSchema,
            abortSignal
          );
          const commit = response.data;
          if (commit.sha !== commitSha || !validChangedFileMetadata(commit.files))
            throw new GithubContextError(
              'GitHub returned mismatched commit or invalid changed-file metadata'
            );
          const projected = [];
          let outputBytes = 0;
          for (const file of commit.files) {
            const { patch, ...metadata } = file;
            const item = {
              ...metadata,
              patchStatus: filePatchStatus(file),
              patchBytes: patch === undefined ? null : byteLength(patch),
              retrieval: { tool: 'pr_commit', sha: commitSha, path: file.filename, offset: 0 },
            };
            const bytes = byteLength(JSON.stringify(item));
            if (outputBytes + bytes > MAX_CATEGORY_OUTPUT_BYTES) break;
            outputBytes += bytes;
            projected.push(item);
          }
          const filesComplete =
            commit.files.length < PAGE_SIZE &&
            linkUrl(response.headers.get('Link'), 'next') === undefined &&
            projected.length === commit.files.length;
          const file = commit.files.find(file => file.filename === relativePath);
          const patchStatus = file ? filePatchStatus(file) : undefined;
          const chunk =
            relativePath !== undefined && file?.patch !== undefined && patchStatus === 'available'
              ? textChunk(file.patch, offset, MAX_RETRIEVAL_BYTES)
              : undefined;
          const patch =
            relativePath === undefined
              ? undefined
              : {
                  path: relativePath,
                  patchStatus,
                  patchComplete: patchStatus === 'available',
                  ...(chunk
                    ? {
                        ...chunk,
                        retrieval: {
                          tool: 'pr_commit',
                          sha: commitSha,
                          path: relativePath,
                          offset: chunk.nextOffset,
                        },
                      }
                    : {
                        available: false,
                        error: file
                          ? 'Commit patch is incomplete or unavailable'
                          : 'Path is not in the returned commit files; no patch or absence is proven',
                      }),
                };
          return {
            available: true,
            ...commitMetadata(commit),
            files: projected,
            returnedFileCount: commit.files.length,
            fileLimit: PAGE_SIZE,
            filesComplete,
            complete: filesComplete && (patch === undefined || patch.patchComplete),
            limited: !filesComplete,
            patch,
          };
        }, abortSignal);
      },
    }),
    pr_file: tool({
      description:
        'Read a UTF-8 file at head, merge-base, base-tip (REVIEW.md), incremental previous head, or a trusted history commitSha. Historical paths are exact; old-side renames use their own comparison.',
      inputSchema: z.object({
        path: z.string(),
        revision: z.enum(['head', 'merge-base', 'base-tip', 'previous', 'history']),
        commitSha: z.string().optional(),
        offset: z.number().optional(),
      }),
      execute: async ({ path, revision, commitSha, offset = 0 }, { abortSignal }) => {
        const relativePath = toRepoRelativePath(path);
        if (
          !relativePath ||
          relativePath.length > 4_096 ||
          !['head', 'merge-base', 'base-tip', 'previous', 'history'].includes(revision)
        )
          return { error: 'A repository-relative path and captured revision are required' };
        if (!Number.isSafeInteger(offset) || offset < 0)
          return { error: 'offset must be a nonnegative integer' };
        if (revision === 'previous' && !incrementalSelection)
          return { error: 'previous revision requires an effective incremental review' };
        if (revision !== 'history' && commitSha !== undefined)
          return { error: 'commitSha is accepted only for a trusted history revision' };
        if (revision === 'history') {
          const parsedSha = shaSchema.safeParse(commitSha);
          if (!parsedSha.success)
            return { error: 'history revision requires a full authorized commitSha' };
          return optionalHistory(async () => {
            const sha = parsedSha.data;
            if (!allowedHistorySha(sha, abortSignal))
              throw new GithubContextError(
                'Commit SHA is not in the captured snapshot or trusted history allowlist'
              );
            const content = await fileContent(relativePath, sha, offset, abortSignal, true);
            return {
              available: true,
              complete: true,
              ...content,
              requestedPath: relativePath,
              revision,
              retrieval: {
                tool: 'pr_file',
                path,
                revision,
                commitSha: sha,
                offset: content.nextOffset,
              },
            };
          }, abortSignal);
        }
        return required(async () => {
          await currentPull(abortSignal);
          const captured = await getSnapshot(abortSignal);
          const comparison = revision === 'merge-base' ? 'current-pr' : 'review';
          const file = (await getFiles(comparison, abortSignal)).find(
            file => file.filename === relativePath
          );
          const oldSide = revision === 'merge-base' || revision === 'previous';
          const resolvedPath = oldSide ? (file?.previous_filename ?? relativePath) : relativePath;
          const sha =
            revision === 'head'
              ? captured.headSha
              : revision === 'merge-base'
                ? captured.mergeBaseSha
                : revision === 'previous'
                  ? incrementalSelection?.previousHeadSha
                  : captured.baseTipSha;
          if (!sha) throw new GithubContextError('The selected previous revision is unavailable');
          if (
            (revision === 'head' && file?.status === 'removed') ||
            (oldSide && file?.status === 'added')
          ) {
            return { path: resolvedPath, revision, sha, found: false, expectedAbsent: true };
          }
          const content = await fileContent(resolvedPath, sha, offset, abortSignal);
          await currentPull(abortSignal);
          return {
            ...content,
            requestedPath: relativePath,
            revision,
            retrieval: { tool: 'pr_file', path, revision, offset: content.nextOffset },
          };
        }, abortSignal);
      },
    }),
    pr_comments: tool({
      description:
        'Read discussion previews and discover summaries without mutation authority. The active-root duplicate index scans independently; category/page retrieves further discussion.',
      inputSchema: z.object({
        category: z.enum(['inline', 'issue', 'reviews']).optional(),
        page: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async ({ category, page = 1, offset = 0 }, { abortSignal }) =>
        required(async () => {
          await currentPull(abortSignal);
          if (category) {
            const path =
              category === 'inline'
                ? `${pullPath}/comments`
                : category === 'issue'
                  ? createSummaryPath
                  : reviewPath;
            const schema =
              category === 'inline'
                ? inlineCommentSchema
                : category === 'issue'
                  ? issueCommentSchema
                  : reviewSchema;
            const response = await pageOf<InlineComment | IssueComment | Review>(
              path,
              schema,
              page,
              abortSignal,
              category === 'inline' ? '&sort=created&direction=asc' : ''
            );
            for (const comment of response.data) checkScope(comment);
            await currentPull(abortSignal);
            const projected = projectCommentPage(response.data, category, offset);
            return {
              category,
              page,
              offset,
              comments: projected.comments,
              nextPage: projected.nextOffset === null ? (response.nextPage ?? null) : page,
              nextOffset: projected.nextOffset ?? 0,
              complete:
                page === 1 &&
                offset === 0 &&
                response.nextPage === undefined &&
                projected.nextOffset === null,
              continuation:
                projected.nextOffset !== null
                  ? { category, page, offset: projected.nextOffset }
                  : response.nextPage === undefined
                    ? null
                    : { category, page: response.nextPage, offset: 0 },
            };
          }
          const inline = await scanInline(abortSignal);
          const issues = await scanIssues(abortSignal);
          const reviews = await pageOf(reviewPath, reviewSchema, 1, abortSignal);
          for (const review of reviews.data) checkScope(review);
          await currentPull(abortSignal);
          const reviewPreview = projectCommentPage(reviews.data, 'reviews');
          return {
            inlineComments: inline.previews.filter(
              comment => !('in_reply_to_id' in comment) || comment.in_reply_to_id == null
            ),
            inlineReplies: inline.previews.filter(
              comment => 'in_reply_to_id' in comment && comment.in_reply_to_id != null
            ),
            issueComments: issues.previews,
            summaries: issues.summaries,
            summaryCount: issues.markedIds.length,
            summariesTruncated: issues.markedIds.length > issues.summaries.length,
            reviews: reviewPreview.comments,
            inlineCommentsComplete,
            activeRootIndexComplete: inlineCommentsComplete,
            inlineRecordCount: inline.count,
            inlineRootCount: inline.rootCount,
            activeRootCount: inline.activeRootCount,
            issueCommentCount: issues.count,
            reviewsComplete: reviews.nextPage === undefined && reviewPreview.nextOffset === null,
            truncated:
              inline.count > inline.previews.length ||
              issues.count > issues.previews.length ||
              reviews.nextPage !== undefined ||
              reviewPreview.nextOffset !== null ||
              [...inline.previews, ...issues.previews, ...reviewPreview.comments].some(
                comment => comment.bodyTruncated
              ),
            continuation: {
              inline:
                inline.count > inline.previews.length
                  ? {
                      category: 'inline',
                      page: Math.floor(inline.previews.length / PAGE_SIZE) + 1,
                      offset: inline.previews.length % PAGE_SIZE,
                    }
                  : null,
              issue:
                issues.count > issues.previews.length
                  ? {
                      category: 'issue',
                      page: Math.floor(issues.previews.length / PAGE_SIZE) + 1,
                      offset: issues.previews.length % PAGE_SIZE,
                    }
                  : null,
              reviews:
                reviewPreview.nextOffset !== null
                  ? { category: 'reviews', page: 1, offset: reviewPreview.nextOffset }
                  : reviews.nextPage === undefined
                    ? null
                    : { category: 'reviews', page: reviews.nextPage, offset: 0 },
            },
          };
        }, abortSignal),
    }),
    pr_comment: tool({
      description:
        'Retrieve full issue/inline/review comment context in 32 KiB chunks, scoped to this PR. Omit bodyHash on the first page; when continuing, pass the exact returned offset and bodyHash to detect intervening edits.',
      inputSchema: z.object({
        category: z.enum(['inline', 'issue', 'reviews']),
        id: z.number(),
        offset: z.number().optional(),
        bodyHash: z.string().optional(),
      }),
      execute: async ({ category, id, offset = 0, bodyHash }, { abortSignal }) => {
        if (!githubIdSchema.safeParse(id).success)
          return { error: 'id must be a positive integer' };
        return required(async () => {
          await currentPull(abortSignal);
          const path =
            category === 'inline'
              ? `${basePath}/pulls/comments/${id}`
              : category === 'issue'
                ? `${basePath}/issues/comments/${id}`
                : `${reviewPath}/${id}`;
          const schema =
            category === 'inline'
              ? inlineCommentSchema
              : category === 'issue'
                ? issueCommentSchema
                : reviewSchema;
          const comment = (
            await read<InlineComment | IssueComment | Review>(path, schema, abortSignal)
          ).data;
          checkScope(comment);
          if (comment.id !== id)
            throw new GithubContextError('GitHub returned a different comment ID');
          const hash = await hashText(comment.body);
          if ((offset > 0 && !bodyHash) || (bodyHash && bodyHash !== hash))
            throw new GithubContextError(
              'Comment body changed or continuation lacks a body hash; restart retrieval'
            );
          const visible = contextBody(comment.body);
          const chunk = textChunk(visible, offset, MAX_RETRIEVAL_BYTES);
          await currentPull(abortSignal);
          return {
            ...projectComment(comment, category),
            ...chunk,
            originalLength: comment.body.length,
            originalBytes: byteLength(comment.body),
            bodyHash: hash,
            retrieval: {
              tool: 'pr_comment',
              category,
              id,
              offset: chunk.nextOffset,
              bodyHash: hash,
            },
          };
        }, abortSignal);
      },
    }),
    submit_review: tool({
      description:
        'Submit all inline findings atomically with an empty review body after snapshot, target, duplicate, and summary-ownership preflight.',
      inputSchema: z.object({
        comments: z
          .array(
            z.object({
              path: z.string(),
              line: z.number(),
              side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
              body: z.string(),
            })
          )
          .min(1),
      }),
      execute: async ({ comments }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const normalized = normalizeReviewComments(comments);
        if ('error' in normalized) return normalized;
        const payload = {
          commit_id: headSha,
          event: 'COMMENT' as const,
          body: '',
          comments: normalized.comments,
        };
        const fingerprint = await publicationFingerprint('review', headSha, reviewPath, payload);
        abortSignal?.throwIfAborted();
        if (!dryRun) {
          if (rejected === 'review') await clearRejected('review');
          if (state.reviewPending)
            return reconcileReview(normalized.comments, fingerprint, abortSignal);
          if (state.reviewId !== undefined) {
            if (state.reviewFingerprint !== fingerprint)
              throw new Error(
                'Review is already published; refusing a conflicting or unproven operation'
              );
            return reviewResult ?? { id: state.reviewId };
          }
          if (state.summaryPending)
            return blocked('Summary publication is pending; no new write is authorized');
        }
        if (contextFailure) return blocked(contextFailure);
        const preflight = await required(async () => {
          await currentPull(abortSignal);
          await getFiles('review', abortSignal);
          const evidence = await getFiles('current-pr', abortSignal);
          for (const comment of normalized.comments) {
            const file = evidence.find(file => file.filename === comment.path);
            if (
              !file ||
              file.status === 'removed' ||
              file.patchLength === null ||
              file.patchLength === 0 ||
              (incrementalSelection && file.patchStatus !== 'available')
            )
              return {
                error: `No current RIGHT-side diff target at ${comment.path}:${comment.line}; keep this finding summary-only`,
              };
            const anchors = rightDiffLines(await getPatch(file, 'current-pr', abortSignal), file);
            if (!anchors.has(comment.line))
              return {
                error: `No current RIGHT-side diff target at ${comment.path}:${comment.line}`,
              };
          }
          await scanInline(abortSignal);
          for (const comment of normalized.comments) {
            const key = JSON.stringify([comment.path, comment.line, await hashText(comment.body)]);
            if (existingInlineKeys.has(key))
              return {
                error: `An exact active inline comment already targets ${comment.path}:${comment.line}; refusing duplicate publication`,
              };
          }
          const pull = await currentPull(abortSignal);
          const target = await summaryPreflight(abortSignal);
          return {
            blockedReason:
              target.blockedReason ??
              eligibility(pull) ??
              (state.reviewPending || state.summaryPending
                ? 'A publication is pending; proposal is not publishable'
                : undefined),
          };
        }, abortSignal);
        if ('error' in preflight) return preflight;
        if (contextFailure) return blocked(contextFailure);
        const { blockedReason } = preflight;
        await proposal(
          {
            kind: 'review',
            fingerprint,
            publishable: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
          },
          abortSignal
        );
        if (dryRun)
          return {
            dryRun: true,
            fingerprint,
            publishable: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
            wouldSend: payload,
          };
        if (blockedReason) return blocked(blockedReason);
        if (!state.reviewPending && state.reviewId !== undefined) {
          if (state.reviewFingerprint !== fingerprint)
            throw new Error(
              'Review is already published; refusing a conflicting or unproven operation'
            );
          return reviewResult ?? { id: state.reviewId };
        }
        await authorize('review', { fingerprint }, abortSignal);
        abortSignal?.throwIfAborted();
        let result: unknown;
        try {
          result = await github.post<unknown>(reviewPath, payload, abortSignal);
        } catch (error) {
          if (isDefinitivePublicationRejection(error)) {
            rejected = 'review';
            await clearRejected('review');
            return { error: error.body, status: error.status, publicationOutcome: 'rejected' };
          }
          throw error;
        }
        return confirmReview(
          parseExternal(publishedSchema, result, 'review publication ID'),
          fingerprint
        );
      },
    }),
    upsert_summary: tool({
      description: queuedPublication
        ? 'Publish one canonical summary after exact app, author, body hash, snapshot and current authority checks. History is added by code. Supply gateResult when the canonical threshold is not off.'
        : 'Propose one marked summary, or publish it once after complete ownership preflight. Only lifecycle-proven unchanged candidate summaries may be patched.',
      inputSchema: z.object({ body: z.string(), gateResult: z.enum(['pass', 'fail']).optional() }),
      execute: async ({ body, gateResult }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const gate = z.enum(['pass', 'fail']).optional().safeParse(gateResult);
        if (
          !gate.success ||
          (queuedPublication && queuedPublication.gateThreshold !== 'off' && !gate.data)
        ) {
          return blocked('A valid gateResult is required by the canonical merge-gate policy');
        }
        if (!dryRun && rejected === 'summary') await clearRejected('summary');
        const authoredBody = body.replace(SUMMARY_OPERATION_MARKER_PATTERN, '');
        const bodyWithoutMarker = authoredBody.startsWith(SUMMARY_MARKER)
          ? authoredBody.slice(SUMMARY_MARKER.length)
          : authoredBody;
        if (
          !bodyWithoutMarker.trim() ||
          (!(queuedPublication && state.summaryPending) && SERVER_BLOCK_PATTERN.test(authoredBody))
        )
          return {
            error:
              'Summary must be nonempty and must not contain server-owned history, usage, or guidance blocks',
          };
        const analysisBody = authoredBody.startsWith(SUMMARY_MARKER)
          ? authoredBody
          : `${SUMMARY_MARKER}\n${authoredBody}`;
        const operationMarker = runId
          ? `<!-- kilo-isolate-review-summary:${await hashText(runId)} -->`
          : undefined;
        const patchOperation = state.summaryPending
          ? state.summaryPendingCommentId !== undefined
          : summaryOwnership !== undefined;
        const replayingHistory =
          queuedPublication && state.summaryPending && SERVER_BLOCK_PATTERN.test(analysisBody);
        let history = replayingHistory ? '' : queuedPublication?.summaryHistory;
        if (history) {
          const availableHistoryBytes = Math.max(
            0,
            MAX_WRITE_BODY_BYTES -
              QUEUED_SUMMARY_FOOTER_BYTES -
              byteLength(analysisBody) -
              2 -
              (!patchOperation && operationMarker ? byteLength(`\n${operationMarker}`) : 0)
          );
          if (byteLength(history) > availableHistoryBytes)
            history = buildPreviousReviewSummaryHistory(history, {
              maxBytes: availableHistoryBytes,
            });
        }
        const unmarkedPayload = {
          body: history ? `${analysisBody}\n\n${history}` : analysisBody,
        };
        const createPayload = {
          body: operationMarker
            ? `${unmarkedPayload.body}\n${operationMarker}`
            : unmarkedPayload.body,
        };
        const payload = patchOperation ? unmarkedPayload : createPayload;
        const maxBodyBytes =
          queuedPublication && !state.summaryPending
            ? MAX_WRITE_BODY_BYTES - QUEUED_SUMMARY_FOOTER_BYTES
            : MAX_WRITE_BODY_BYTES;
        if (byteLength(payload.body) > maxBodyBytes)
          return {
            error: queuedPublication
              ? 'Summary exceeds the 64 KiB body budget including the backend footer'
              : 'Summary exceeds the 64 KiB body budget',
          };
        const bodyHash = await hashText(payload.body);
        abortSignal?.throwIfAborted();
        if (!dryRun && state.summaryPending) {
          if (
            state.summaryPendingCommentId !== undefined &&
            [
              state.summaryCommentId,
              summaryOwnership?.commentId,
              input.existingSummaryCommentId,
            ].some(id => id !== undefined && id !== state.summaryPendingCommentId)
          )
            throw new Error('Summary publication fingerprint does not match the pending operation');
          const path =
            state.summaryPendingCommentId === undefined
              ? createSummaryPath
              : `${basePath}/issues/comments/${state.summaryPendingCommentId}`;
          const fingerprint = await publicationFingerprint('summary', headSha, path, payload);
          return reconcileSummary(
            payload.body,
            fingerprint,
            bodyHash,
            abortSignal,
            operationMarker
          );
        }
        if (!dryRun && (state.summaryPublished || state.summaryCommentId !== undefined)) {
          const createFingerprint = await publicationFingerprint(
            'summary',
            headSha,
            createSummaryPath,
            createPayload
          );
          const patchFingerprint =
            state.summaryCommentId === undefined
              ? undefined
              : await publicationFingerprint(
                  'summary',
                  headSha,
                  `${basePath}/issues/comments/${state.summaryCommentId}`,
                  unmarkedPayload
                );
          const matchesCreate =
            state.summaryFingerprint === createFingerprint &&
            state.summaryBodyHash === (await hashText(createPayload.body));
          const matchesPatch =
            patchFingerprint !== undefined &&
            state.summaryFingerprint === patchFingerprint &&
            state.summaryBodyHash === (await hashText(unmarkedPayload.body));
          abortSignal?.throwIfAborted();
          if (!matchesCreate && !matchesPatch) {
            throw new Error(
              'Summary is already published; refusing a conflicting or unproven operation'
            );
          }
          return summaryResult ?? { id: state.summaryCommentId };
        }
        if (!dryRun && state.reviewPending)
          return blocked('Review publication is pending; no new write is authorized');
        if (contextFailure) return blocked(contextFailure);
        const targetPath =
          summaryOwnership === undefined
            ? createSummaryPath
            : `${basePath}/issues/comments/${summaryOwnership.commentId}`;
        const fingerprint = await publicationFingerprint('summary', headSha, targetPath, payload);
        const preflight = await required(async () => {
          await currentPull(abortSignal);
          await getFiles('review', abortSignal);
          const pull = await currentPull(abortSignal);
          const target = await summaryPreflight(abortSignal);
          return {
            ...target,
            blockedReason:
              target.blockedReason ??
              eligibility(pull) ??
              (state.reviewPending || state.summaryPending
                ? 'A publication is pending; proposal is not publishable'
                : undefined),
          };
        }, abortSignal);
        if (contextFailure) return blocked(contextFailure);
        const { commentId, blockedReason } = preflight;
        const summaryContent = { body: analysisBody, bodyHash: await hashText(analysisBody) };
        await proposal(
          {
            kind: 'summary',
            fingerprint,
            bodyHash,
            summaryContent,
            ...(queuedPublication && gate.data ? { gateResult: gate.data } : {}),
            publishable: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
          },
          abortSignal
        );
        const wouldSend = {
          method: commentId === undefined ? 'POST' : 'PATCH',
          path: targetPath,
          payload,
        };
        if (dryRun)
          return {
            dryRun: true,
            fingerprint,
            bodyHash,
            publishable: !blockedReason,
            ...(blockedReason ? { blockedReason } : {}),
            wouldSend,
          };
        if (blockedReason) return blocked(blockedReason);
        if (
          !state.summaryPending &&
          (state.summaryPublished || state.summaryCommentId !== undefined)
        ) {
          if (state.summaryFingerprint !== fingerprint || state.summaryBodyHash !== bodyHash)
            throw new Error(
              'Summary is already published; refusing a conflicting or unproven operation'
            );
          return summaryResult ?? { id: state.summaryCommentId };
        }
        await authorize(
          'summary',
          {
            fingerprint,
            bodyHash,
            ...(commentId === undefined ? {} : { commentId }),
            ...(queuedPublication
              ? { summary: { content: summaryContent, gateResult: gate.data } }
              : {}),
          },
          abortSignal
        );
        if (queuedPublication) {
          const fresh = await summaryPreflight(abortSignal);
          if (fresh.blockedReason || fresh.commentId !== commentId) {
            throw new Error(
              fresh.blockedReason ?? 'Canonical summary target changed before publication'
            );
          }
        }
        abortSignal?.throwIfAborted();
        let result: unknown;
        try {
          result =
            commentId === undefined
              ? await github.post<unknown>(targetPath, payload, abortSignal)
              : await github.patch<unknown>(targetPath, payload, abortSignal);
        } catch (error) {
          if (isDefinitivePublicationRejection(error)) {
            rejected = 'summary';
            await clearRejected('summary');
            return { error: error.body, status: error.status, publicationOutcome: 'rejected' };
          }
          throw error;
        }
        const published = parseExternal(publishedSchema, result, 'summary publication ID');
        if (commentId !== undefined && published.id !== commentId)
          throw new Error('GitHub summary publication returned a different comment ID');
        return confirmSummary(published, fingerprint, bodyHash);
      },
    }),
  };

  if (!options.tools) return allTools;
  const selected = new Set<string>(options.tools);
  return Object.fromEntries(Object.entries(allTools).filter(([name]) => selected.has(name)));
}
