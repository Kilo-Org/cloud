/**
 * GitLab merge-request READ layer for the provider review surfaces.
 *
 * Every function resolves credentials through gitlab-authorization first, so
 * the instance URL and token are always server-derived, and returns the shared
 * DTOs so provider differences stay within this module. Adapter helpers and
 * the neutral gitlab-http client share URL validation and pinned transport;
 * gitlab-discussion supplies the same resolution state used by writes.
 */
import 'server-only';

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
  fetchGitLabUser,
  getMRHeadCommit,
  type GitLabDiscussion,
  type GitLabMergeRequest,
  type GitLabMergeRequestDetail,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  FILE_LINES_MAX,
  FILE_READ_MAX_BYTES,
  FILE_READ_TOO_LARGE_MESSAGE,
} from '@/lib/github-pr-review/dtos';
import {
  authorizeOwner,
  authorizeProject,
  classifyGitLabError,
  classifyGitLabErrorForOwner,
  GitLabReviewError,
  type GitLabProjectAccess,
  type GitLabReviewOwner,
} from './gitlab-authorization';
import { getGitLabDiscussionState } from './gitlab-discussion';
import { requestGitLabJson, requestGitLabText } from './gitlab-http';

const GITLAB_PAGE_SIZE = 50;
/**
 * The diff-page bound for the summary's change counts: GitLab caps a merge
 * request's diff collection at the project's `diff_max_files` setting (1000
 * files by default), so 20 pages of 50 fold every diff GitLab will report
 * while a hostile instance still cannot stream pages forever.
 */
const MAX_SUMMARY_DIFFSTAT_PAGES = 20;
/** The MR-pipeline page bound for the checks list, same bounded-walk rule. */
const MAX_CHECK_PAGES = 20;

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

/**
 * The MR's own changed-file total, or null when GitLab has none yet. The
 * value is a string that is empty while the diff is still computing and
 * carries a `+` suffix once it exceeds the project's diff limit (`1000+`);
 * the digits before the cap are the largest total GitLab itself reports, so
 * the summary never presents a truncated page-walk as the total.
 */
function parseChangesCount(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\s*(\d+)\s*\+?\s*$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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
 * with change counts folded in from the MR's own total and the diff pages.
 */
export async function getMergeRequest(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  instanceHint?: string
): Promise<ProviderPrSummary> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const [detail, headSha] = await Promise.all([
      fetchGitLabMergeRequest({
        accessToken: access.accessToken,
        projectId: access.projectPath,
        mrIid,
        instanceUrl: access.instanceUrl,
      }),
      getMRHeadCommit(access.accessToken, access.projectPath, mrIid, access.instanceUrl),
    ]);
    // Counts come from the diffs. Fold every page GitLab will serve — it caps
    // a merge request's diff collection at the project's `diff_max_files`
    // (1000 by default), which the page bound covers — so a large merge
    // request reports complete totals. Each page is folded into the running
    // counters the moment it arrives and dropped, so the walk never holds the
    // parsed diff text it only reads once.
    let diffFileCount = 0;
    let additions = 0;
    let deletions = 0;
    for (let page = 1; page <= MAX_SUMMARY_DIFFSTAT_PAGES; page++) {
      const diffs = await fetchDiffPage(access, mrIid, page);
      for (const file of diffs) {
        const counts = diffLineCounts(file.diff ?? '');
        additions += counts.additions;
        deletions += counts.deletions;
      }
      diffFileCount += diffs.length;
      if (diffs.length < GITLAB_PAGE_SIZE) break;
    }
    // Prefer the MR's own total: the diff walk is capped even after the page
    // bound is raised, and `changes_count` covers every file GitLab counted.
    const changedFiles = Math.max(parseChangesCount(detail.changes_count) ?? 0, diffFileCount);
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
      changedFiles,
      additions,
      deletions,
      webUrl: detail.web_url,
      createdAt: detail.created_at ?? detail.updated_at ?? '',
      updatedAt: detail.updated_at ?? '',
    };
  } catch (error) {
    throw classifyGitLabErrorForOwner(error, owner);
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
    throw classifyGitLabErrorForOwner(error, owner);
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
    const text = await requestGitLabText(
      access,
      `/api/v4/projects/${encodeURIComponent(access.projectPath)}/repository/files/${encodeURIComponent(path)}/raw`,
      { ref },
      FILE_READ_MAX_BYTES,
      FILE_READ_TOO_LARGE_MESSAGE
    );
    const allLines = text.split('\n');
    const start = Math.max(1, Math.min(startLine, allLines.length));
    const cappedEnd = Math.min(endLine, startLine + FILE_LINES_MAX - 1);
    const end = Math.max(start, Math.min(cappedEnd, allLines.length));
    return { lines: allLines.slice(start - 1, end), totalLines: allLines.length };
  } catch (error) {
    throw classifyGitLabErrorForOwner(error, owner);
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
  const state = getGitLabDiscussionState(discussion.notes);
  const position = discussion.notes.find(note => note.position)?.position;
  const anchorLine = position?.new_line ?? position?.old_line ?? null;
  return {
    threadId: discussion.id,
    resolved: state.resolved,
    resolvable: state.resolvable,
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
    throw classifyGitLabErrorForOwner(error, owner);
  }
}

const FINISHED_PIPELINE_STATUSES = new Set(['success', 'failed', 'canceled']);

/**
 * The pipelines OF the merge request, as the shared checks DTO. The MR
 * pipelines endpoint is the only listing that includes the MR's merge-ref
 * pipelines: they run on the merge result sha, so the project-wide
 * pipelines-by-sha listing never reports them. The listing paginates, and the
 * checks DTO has no cursor, so every page is folded into the one rollup — a
 * failing pipeline past the first page is exactly what this surface exists to
 * show.
 */
export async function listChecks(
  owner: GitLabReviewOwner,
  projectPath: string,
  mrIid: number,
  instanceHint?: string
): Promise<ProviderPrChecksResult> {
  const access = await authorizeProject(owner, projectPath, instanceHint);
  try {
    const checks: ProviderPrChecksResult['checks'] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const pipelines = await requestGitLabJson<GitLabPipeline[]>(
        access,
        `/api/v4/projects/${projectSegment(access)}/merge_requests/${mrIid}/pipelines`,
        { query: { per_page: GITLAB_PAGE_SIZE, page } }
      );
      for (const pipeline of pipelines) {
        checks.push({
          name: pipeline.name || pipeline.ref,
          status: pipeline.status,
          conclusion: FINISHED_PIPELINE_STATUSES.has(pipeline.status) ? pipeline.status : null,
          detailsUrl: pipeline.web_url,
        });
      }
      if (pipelines.length < GITLAB_PAGE_SIZE) break;
    }
    return { checks };
  } catch (error) {
    throw classifyGitLabErrorForOwner(error, owner);
  }
}

/**
 * The inbox lists the acting account's own review requests, so a provider 403
 * on that read is the CONNECTION's — there is no merge-request role in play.
 * `classifyGitLabErrorForOwner` already resolves an organization connection's
 * 403 to `reconnect`; this adds the personal arm and, for both, copy that
 * names the inbox the person was reading instead of a merge request, which
 * the list request never mentioned.
 */
function classifyInboxError(error: unknown, owner: GitLabReviewOwner): GitLabReviewError {
  // The provider status has to be read before the owner-aware step: that step
  // rewrites an organization connection's 403 into a reconnect whose copy
  // names a merge request, which this list request never mentioned.
  if (classifyGitLabError(error).providerStatus !== 403) {
    return classifyGitLabErrorForOwner(error, owner);
  }
  return new GitLabReviewError(
    'reconnect',
    'Your GitLab connection cannot read your review requests. Reconnect GitLab and try again.'
  );
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
  try {
    const access = await authorizeOwner(owner, instanceHint);
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
          // scope value. reviewer_username is supported on gitlab.com and on
          // self-managed GitLab since 10.x — older than the versions we
          // advertise.
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
      // The adapter's author type omits `avatar_url`, but the list API
      // returns it; narrow instead of asserting the field into existence.
      const avatarUrl =
        mr.author && 'avatar_url' in mr.author && typeof mr.author.avatar_url === 'string'
          ? mr.author.avatar_url
          : null;
      items.push({
        ref,
        title: mr.title,
        author: mr.author
          ? {
              login: mr.author.username,
              avatarUrl,
            }
          : null,
        state: mapMergeRequestState(mr.state),
        draft: isDraftMr(mr),
        updatedAt: mr.updated_at ?? '',
      });
    }
    return { items, nextCursor: cursorForPage(identity, page, mergeRequests.length) };
  } catch (error) {
    throw classifyInboxError(error, owner);
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
    const mr = await fetchGitLabMergeRequest({
      accessToken: access.accessToken,
      projectId: access.projectPath,
      mrIid,
      instanceUrl: access.instanceUrl,
    });
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
    throw classifyGitLabErrorForOwner(error, owner);
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
    const unresolved = discussions.some(discussion => {
      const state = getGitLabDiscussionState(discussion.notes);
      return state.resolvable && !state.resolved;
    });
    if (unresolved) return true;
    if (discussions.length < 100) break;
  }
  return false;
}
