/**
 * GitLab merge-request READ layer for the provider review surfaces.
 *
 * Every function resolves credentials through gitlab-authorization first, so
 * the instance URL and token are always server-derived, and returns the shared
 * s1 DTOs so a provider difference never leaks past this module. Adapter
 * helpers are reused wherever they exist; the remaining GitLab endpoints go
 * through the thin JSON request below, which uses the same URL builder,
 * DNS-pinned transport, and response cap the adapter applies, so a stored
 * self-managed URL cannot re-target the bearer token at another host.
 */
import 'server-only';

import * as http from 'http';
import * as https from 'https';
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
  fetchGitLabMergeRequest,
  fetchGitLabRootTextFileAtRef,
  fetchGitLabUser,
  getMRHeadCommit,
  type GitLabDiscussion,
  type GitLabMergeRequest,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  buildGitLabUrl,
  resolveGitLabUrlSafely,
  type GitLabResolvedUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import {
  authorizeOwner,
  authorizeProject,
  classifyGitLabError,
  GitLabApiStatusError,
  GitLabReviewError,
  type GitLabProjectAccess,
  type GitLabReviewOwner,
} from './gitlab-authorization';

const GITLAB_PAGE_SIZE = 50;
const GITLAB_REQUEST_TIMEOUT_MS = 30_000;
/** Same response cap the adapter applies, so a hostile instance cannot stream unbounded bytes. */
const MAX_GITLAB_RESPONSE_BYTES = 10 * 1024 * 1024;

/** The MR detail JSON carries more fields than the adapter's typed subset. */
type GitLabMergeRequestDetail = GitLabMergeRequest & {
  created_at?: string;
  updated_at?: string;
  project_id?: number;
  has_conflicts?: boolean;
  merge_status?: string;
  head_pipeline?: { id: number; sha: string; ref: string; status: string; web_url: string } | null;
  references?: { full?: string };
  // GitLab omits or nulls diff_refs on merge requests without a diff (for
  // example an empty repository or an unresolved merge ref), so it cannot be
  // trusted the way the adapter's non-optional type claims.
  diff_refs?: GitLabMergeRequest['diff_refs'] | null;
};

type GitLabDiff = {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
};

type GitLabPipeline = {
  id: number;
  sha: string;
  ref: string;
  status: string;
  web_url: string;
  name?: string | null;
};

type GitLabProjectSettings = {
  only_allow_merge_if_pipeline_succeeds?: boolean;
  only_allow_merge_if_all_discussions_are_resolved?: boolean;
};

type GitLabApprovals = {
  approvals_required?: number;
  approvals_left?: number;
};

/**
 * One JSON request against the authorized instance. The instance URL is the
 * server-derived one from authorizeProject/authorizeOwner. The URL is resolved
 * once with the adapter's guard and the request is then bound to that exact
 * resolved address, so a stored self-managed host cannot be DNS-rebound
 * between the check and the connect.
 */
export async function requestGitLabJson<T>(
  access: { accessToken: string; instanceUrl: string },
  path: string,
  request: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  } = {}
): Promise<T> {
  const query = request.query
    ? (Object.fromEntries(
        Object.entries(request.query).filter(([, value]) => value !== undefined)
      ) as Record<string, string | number | boolean>)
    : undefined;
  const url = buildGitLabUrl(access.instanceUrl, path, query);
  try {
    const response = await fetchGitLabValidated(url, {
      method: request.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Accept: 'application/json',
        ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Only the status survives — the provider body is never re-emitted.
      throw new GitLabApiStatusError(
        response.status,
        `GitLab ${request.method ?? 'GET'} request failed: ${response.status}`
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Resolve the URL once (refusing unsafe hosts), then send the request bound
 * to the resolved address. Only an IP literal or gitlab.com keeps the plain
 * transport — the same split the adapter's fetchGitLabOnce makes.
 */
async function fetchGitLabValidated(url: string, init: RequestInit): Promise<Response> {
  const resolvedUrl = await resolveGitLabUrlSafely(url);
  if (!resolvedUrl.address) {
    return fetch(url, { ...init, redirect: 'manual' });
  }
  return fetchGitLabBoundToAddress({ ...resolvedUrl, address: resolvedUrl.address }, init);
}

/**
 * Node-transport mirror of the adapter's fetchGitLabBoundToAddress: the DNS
 * answer from resolveGitLabUrlSafely is the only address the socket can
 * connect to, TLS keeps the original hostname as SNI, and the response is
 * capped. Redirects are never followed (the caller treats a 3xx as an error).
 */
function fetchGitLabBoundToAddress(
  { url, address, family }: GitLabResolvedUrl & { address: string },
  init: RequestInit
): Promise<Response> {
  const request = url.protocol === 'https:' ? https.request : http.request;
  const headers = new Headers(init.headers);
  const body = typeof init.body === 'string' ? Buffer.from(init.body) : undefined;
  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }

  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        family,
        lookup: (_hostname, _options, callback) => callback(null, address, family ?? 0),
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > MAX_GITLAB_RESPONSE_BYTES) {
            const error = new Error('GitLab response exceeded size limit');
            response.destroy(error);
            req.destroy(error);
            reject(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 500;
            const responseBody =
              status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) {
                  responseHeaders.append(key, item);
                }
              } else if (value !== undefined) {
                responseHeaders.set(key, value);
              }
            }
            resolve(
              new Response(responseBody, {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders,
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(GITLAB_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('GitLab request timed out'));
    });

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason);
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          req.destroy(signal.reason);
          reject(signal.reason);
        },
        { once: true }
      );
    }

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function projectSegment(access: Pick<GitLabProjectAccess, 'projectPath'>): string {
  return encodeURIComponent(access.projectPath);
}

/**
 * A page cursor carries the project identity it was minted for. A cursor
 * bound to another project is ignored (page 1), so page identity can never
 * switch the project a request reads.
 */
function encodePageCursor(identity: string, page: number): string {
  return Buffer.from(JSON.stringify({ identity, page })).toString('base64url');
}

function decodePageCursor(cursor: string | undefined, identity: string): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      identity?: unknown;
      page?: unknown;
    };
    if (typeof parsed.identity !== 'string' || parsed.identity !== identity) return 1;
    if (typeof parsed.page !== 'number' || !Number.isInteger(parsed.page) || parsed.page < 1) {
      return 1;
    }
    return parsed.page;
  } catch {
    return 1;
  }
}

function cursorForPage(identity: string, page: number, returnedCount: number): string | null {
  if (returnedCount < GITLAB_PAGE_SIZE) return null;
  return encodePageCursor(identity, page + 1);
}

function mapMergeRequestState(state: GitLabMergeRequest['state']): ProviderPrSummary['state'] {
  if (state === 'merged') return 'merged';
  if (state === 'opened') return 'open';
  return 'closed';
}

function isDraftMr(mr: GitLabMergeRequestDetail): boolean {
  if (typeof mr.draft === 'boolean') return mr.draft;
  if (typeof mr.work_in_progress === 'boolean') return mr.work_in_progress;
  return /^(draft|wip)\s*[:(-]/i.test(mr.title);
}

function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function mapDiffToFile(diff: GitLabDiff): ProviderPrFile {
  const { additions, deletions } = diffLineCounts(diff.diff ?? '');
  const status = diff.new_file
    ? 'added'
    : diff.deleted_file
      ? 'deleted'
      : diff.renamed_file
        ? 'renamed'
        : 'modified';
  return {
    path: diff.new_path,
    previousPath: diff.old_path !== diff.new_path ? diff.old_path : null,
    status,
    additions,
    deletions,
    patch: diff.diff || null,
    patchMissing: !diff.diff,
  };
}

async function fetchDiffPage(
  access: GitLabProjectAccess,
  mrIid: number,
  page: number
): Promise<GitLabDiff[]> {
  return requestGitLabJson<GitLabDiff[]>(
    access,
    `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/diffs`,
    { query: { per_page: GITLAB_PAGE_SIZE, page } }
  );
}

/**
 * The MR as the review screen renders it: detail, head sha, and diff refs,
 * with change counts folded in from the first diff pages.
 */
export async function getMergeRequest(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  instanceHint?: string
): Promise<ProviderPrSummary> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    // diff_refs are read off the MR response itself: the adapter's
    // getMRDiffRefs helper dereferences mr.diff_refs.base_sha and crashes the
    // whole detail load when GitLab omits them, while the mapping below
    // already tolerates absence.
    const [mr, headSha] = await Promise.all([
      fetchGitLabMergeRequest({
        accessToken: access.accessToken,
        projectId: access.projectPath,
        mrIid,
        instanceUrl: access.instanceUrl,
      }),
      getMRHeadCommit(access.accessToken, access.projectPath, mrIid, access.instanceUrl),
    ]);
    // Counts come from the diffs; cap the pages so one MR detail load can
    // never fan out into an unbounded crawl on a huge merge request.
    const files: GitLabDiff[] = [];
    for (let page = 1; page <= 3; page++) {
      const diffs = await fetchDiffPage(access, mrIid, page);
      files.push(...diffs);
      if (diffs.length < GITLAB_PAGE_SIZE) break;
    }
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      const counts = diffLineCounts(file.diff ?? '');
      additions += counts.additions;
      deletions += counts.deletions;
    }
    const detail = mr as GitLabMergeRequestDetail;
    return {
      ref: {
        platform: 'gitlab',
        projectPath: access.projectPath,
        mrIid,
        instanceHint: access.instanceUrl,
      },
      title: detail.title,
      body: detail.description ?? null,
      author: detail.author
        ? {
            login: detail.author.username,
            avatarUrl: (detail.author as { avatar_url?: string | null }).avatar_url ?? null,
          }
        : null,
      state: mapMergeRequestState(detail.state),
      draft: isDraftMr(detail),
      headRef: detail.source_branch,
      baseRef: detail.target_branch,
      // The diff head sha is the fence every write compares against; fall
      // back to the detail sha only when diff_refs is absent.
      headSha: detail.diff_refs?.head_sha || headSha || detail.sha,
      changedFiles: files.length,
      additions,
      deletions,
      webUrl: detail.web_url,
      createdAt: detail.created_at ?? detail.updated_at ?? '',
      updatedAt: detail.updated_at ?? '',
    };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/** One page of changed files. `cursor` is the opaque page token from a prior call. */
export async function listChangedFiles(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  cursor?: string,
  instanceHint?: string
): Promise<ProviderPrFilesPage> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const page = decodePageCursor(cursor, access.projectPath);
    const diffs = await fetchDiffPage(access, mrIid, page);
    return {
      files: diffs.map(mapDiffToFile),
      nextCursor: cursorForPage(access.projectPath, page, diffs.length),
    };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

export type GitLabFileLines = {
  lines: string[];
  totalLines: number;
};

/**
 * A 1-based inclusive line window of a file at a ref, for comment context.
 * A missing file is a non-retryable not_found.
 */
export async function getFileLines(
  owner: GitLabReviewOwner,
  projectPath: string,
  ref: string,
  path: string,
  startLine: number,
  endLine: number,
  instanceHint?: string
): Promise<GitLabFileLines> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const text = await fetchGitLabRootTextFileAtRef(
      access.accessToken,
      access.projectPath,
      path,
      ref,
      access.instanceUrl
    );
    if (text === null) {
      throw new GitLabReviewError('not_found', 'The file was not found at this ref.');
    }
    const allLines = text.split('\n');
    const start = Math.max(1, Math.min(startLine, allLines.length));
    const end = Math.max(start, Math.min(endLine, allLines.length));
    return { lines: allLines.slice(start - 1, end), totalLines: allLines.length };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * A discussion thread. `resolvable` is GitLab-specific (GitHub threads always
 * are), so it extends the s1 thread instead of dropping the flag.
 */
export type GitLabDiscussionThread = ProviderPrThread & { resolvable: boolean };

export type GitLabDiscussionsPage = {
  threads: GitLabDiscussionThread[];
  nextCursor: string | null;
};

function mapDiscussion(discussion: GitLabDiscussion): GitLabDiscussionThread {
  const firstNote = discussion.notes[0];
  const position = discussion.notes.find(note => note.position)?.position;
  const anchorLine = position?.new_line ?? position?.old_line ?? null;
  return {
    threadId: discussion.id,
    resolved: discussion.notes.some(note => note.resolvable)
      ? (discussion.notes.find(note => note.resolvable)?.resolved ?? false)
      : false,
    resolvable: firstNote?.resolvable ?? false,
    path: position ? position.new_path || position.old_path : null,
    line: anchorLine,
    side: position ? (position.new_line != null ? 'RIGHT' : 'LEFT') : null,
    comments: discussion.notes
      .filter(note => !note.system)
      .map(note => ({
        commentId: String(note.id),
        author: note.author
          ? {
              login: note.author.username,
              avatarUrl: (note.author as { avatar_url?: string | null }).avatar_url ?? null,
            }
          : null,
        body: note.body,
        createdAt: note.created_at,
      })),
  };
}

/** One page of discussions (threads and notes) with their diff anchors. */
export async function listDiscussions(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  cursor?: string,
  instanceHint?: string
): Promise<GitLabDiscussionsPage> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const page = decodePageCursor(cursor, access.projectPath);
    const discussions = await requestGitLabJson<GitLabDiscussion[]>(
      access,
      `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/discussions`,
      { query: { per_page: GITLAB_PAGE_SIZE, page } }
    );
    return {
      threads: discussions.map(mapDiscussion),
      nextCursor: cursorForPage(access.projectPath, page, discussions.length),
    };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

const FINISHED_PIPELINE_STATUSES = new Set(['success', 'failed', 'canceled']);

/**
 * The pipelines OF the merge request, as the shared checks DTO. The MR
 * pipelines endpoint is the only listing that includes the MR's merge-ref
 * pipelines: they run on the merge result sha, so the project-wide
 * pipelines-by-sha listing never reports them.
 */
export async function listChecks(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  instanceHint?: string
): Promise<ProviderPrChecksResult> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const pipelines = await requestGitLabJson<GitLabPipeline[]>(
      access,
      `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/pipelines`,
      { query: { per_page: GITLAB_PAGE_SIZE } }
    );
    return {
      checks: pipelines.map(pipeline => ({
        name: pipeline.name || pipeline.ref,
        status: pipeline.status,
        conclusion: FINISHED_PIPELINE_STATUSES.has(pipeline.status) ? pipeline.status : null,
        detailsUrl: pipeline.web_url,
      })),
    };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * Open merge requests awaiting the acting user's review. Each item carries
 * platform, project path, and the connected instance origin, so the list can
 * never navigate into a different provider's repo.
 */
export async function listInbox(
  owner: GitLabReviewOwner,
  cursor?: string,
  instanceHint?: string
): Promise<ProviderPrInboxPage> {
  const access = await authorizeOwner(owner, instanceHint);
  try {
    const me = await fetchGitLabUser(access.accessToken, access.instanceUrl);
    const identity = `gitlab-inbox:${owner.type === 'user' ? owner.userId : `${owner.organizationId}:${owner.userId}`}`;
    const page = decodePageCursor(cursor, identity);
    const mergeRequests = await requestGitLabJson<GitLabMergeRequestDetail[]>(
      access,
      '/api/v4/merge_requests',
      {
        query: {
          state: 'opened',
          // Without a scope the API defaults to `created_by_me` — authored
          // merge requests, not review requests. `reviews_for_me` selects the
          // merge requests where the acting user is the reviewer;
          // reviewer_username keeps that filter on versions that predate the
          // scope value.
          scope: 'reviews_for_me',
          reviewer_username: me.username,
          per_page: GITLAB_PAGE_SIZE,
          page,
        },
      }
    );
    const items: ProviderPrInboxItem[] = [];
    for (const mr of mergeRequests) {
      const ref = inboxRefFrom(mr, access.instanceUrl);
      if (!ref) continue;
      items.push({
        ref,
        title: mr.title,
        author: mr.author
          ? {
              login: mr.author.username,
              avatarUrl: (mr.author as { avatar_url?: string | null }).avatar_url ?? null,
            }
          : null,
        state: mapMergeRequestState(mr.state),
        draft: isDraftMr(mr),
        updatedAt: mr.updated_at ?? '',
      });
    }
    return { items, nextCursor: cursorForPage(identity, page, mergeRequests.length) };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * The project path of a global-MR row: `references.full` is
 * `group/sub/repo!123`; fall back to the web URL shape
 * `https://host/group/proj/-/merge_requests/123`. A row with neither is
 * skipped — an item without a full path could navigate into the wrong repo.
 */
function inboxRefFrom(
  mr: GitLabMergeRequestDetail,
  instanceUrl: string
): ProviderPrSummary['ref'] | null {
  const full = mr.references?.full;
  if (full?.includes('!')) {
    const [projectPath, iid] = full.split('!');
    const mrIid = Number(iid);
    if (projectPath && Number.isInteger(mrIid) && mrIid > 0) {
      return { platform: 'gitlab', projectPath, mrIid, instanceHint: instanceUrl };
    }
  }
  try {
    const url = new URL(mr.web_url);
    const marker = '/-/merge_requests/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex > 1) {
      const mrIid = Number(url.pathname.slice(markerIndex + marker.length));
      if (Number.isInteger(mrIid) && mrIid > 0) {
        return {
          platform: 'gitlab',
          projectPath: decodeURIComponent(url.pathname.slice(1, markerIndex)),
          mrIid,
          instanceHint: instanceUrl,
        };
      }
    }
  } catch {
    // An unparseable web URL falls through to the skip case below.
  }
  return null;
}

/**
 * The merge gate: branch policy from project settings, approvals from the
 * approvals endpoint (absent on plans without approval rules → 0), conflicts
 * and pipeline state from the MR detail.
 */
export async function getMergeState(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  instanceHint?: string
): Promise<ProviderPrMergeState> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const mr = (await fetchGitLabMergeRequest({
      accessToken: access.accessToken,
      projectId: access.projectPath,
      mrIid,
      instanceUrl: access.instanceUrl,
    })) as GitLabMergeRequestDetail;
    const settings = await requestGitLabJson<GitLabProjectSettings>(
      access,
      `/api/v4/projects/${projectSegment(access)}`
    );
    const pipelineMustSucceed = settings.only_allow_merge_if_pipeline_succeeds === true;
    const discussionsMustBeResolved =
      settings.only_allow_merge_if_all_discussions_are_resolved === true;

    let approvalsRequired = 0;
    let approvalsLeft = 0;
    try {
      const approvals = await requestGitLabJson<GitLabApprovals>(
        access,
        `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/approvals`
      );
      approvalsRequired = approvals.approvals_required ?? 0;
      approvalsLeft = approvals.approvals_left ?? 0;
    } catch (error) {
      // Free/self-managed plans answer 404 when no approval rules exist —
      // that means no approval gate, not a missing merge request.
      if (!(error instanceof GitLabReviewError) || error.kind !== 'not_found') throw error;
    }

    const conflicts = mr.has_conflicts === true || mr.merge_status === 'cannot_be_merged';
    const blockedReasons: ProviderPrMergeBlockedReason[] = [];
    if (mr.state !== 'opened') {
      blockedReasons.push({
        code: 'other',
        message: 'Only open merge requests can be merged.',
      });
    }
    if (isDraftMr(mr)) {
      blockedReasons.push({ code: 'draft', message: 'The merge request is still a draft.' });
    }
    if (conflicts) {
      blockedReasons.push({
        code: 'conflicts',
        message: 'The merge request has conflicts that must be resolved.',
      });
    }
    if (approvalsLeft > 0) {
      blockedReasons.push({
        code: 'required_approvals',
        message: `${approvalsLeft} more approval${approvalsLeft === 1 ? '' : 's'} required.`,
      });
    }
    if (pipelineMustSucceed) {
      const pipelineStatus = mr.head_pipeline?.status;
      if (pipelineStatus === 'failed' || pipelineStatus === 'canceled') {
        blockedReasons.push({
          code: 'failing_pipeline',
          message: 'The pipeline on the latest commit failed.',
        });
      } else if (pipelineStatus !== 'success') {
        blockedReasons.push({
          code: 'pending_pipeline',
          message: pipelineStatus
            ? 'The pipeline on the latest commit has not finished yet.'
            : 'No pipeline was found for the latest commit.',
        });
      }
    }
    if (discussionsMustBeResolved && mr.state === 'opened') {
      const unresolved = await hasUnresolvedDiscussions(access, mrIid);
      if (unresolved) {
        blockedReasons.push({
          code: 'other',
          message: 'Resolve all discussions before merging.',
        });
      }
    }

    return {
      canMerge: mr.state === 'opened' && blockedReasons.length === 0,
      approvalsRequired,
      pipelineMustSucceed,
      conflicts,
      blockedReasons,
    };
  } catch (error) {
    throw classifyGitLabError(error);
  }
}

/**
 * The discussion walk bound for the merge gate: one merge-state load may
 * read at most this many pages of 100 discussions. Past the bound GitLab
 * itself enforces the resolved-discussions gate at merge time, so the
 * display reason failing open cannot let a merge through.
 */
const MAX_MERGE_GATE_DISCUSSION_PAGES = 20;

async function hasUnresolvedDiscussions(
  access: GitLabProjectAccess,
  mrIid: number
): Promise<boolean> {
  for (let page = 1; page <= MAX_MERGE_GATE_DISCUSSION_PAGES; page += 1) {
    const discussions = await requestGitLabJson<GitLabDiscussion[]>(
      access,
      `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/discussions`,
      { query: { per_page: 100, page } }
    );
    const unresolved = discussions.some(discussion =>
      discussion.notes.some(note => note.resolvable && note.resolved === false)
    );
    if (unresolved) return true;
    if (discussions.length < 100) break;
  }
  return false;
}
