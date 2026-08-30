import 'server-only';

import { z } from 'zod';
import {
  repositoryResourceKey,
  type RepositoryIdentity,
} from '@kilocode/app-shared/code-review/repository-identity';
import {
  ReviewActionSchema,
  ReviewCapabilitiesSchema,
  ReviewPositionSchema,
  ReviewRevisionSchema,
  REVIEW_WRITE_REQUEST_MAX_BYTES,
  parseReviewCursor,
  reviewPageKey,
  reviewResourceKey,
  type ReviewCapability,
  type ReviewCursor,
  type ReviewFile,
  type ReviewFileContext,
  type ReviewIdentity,
  type ReviewInbox,
  type ReviewOverview,
  type ReviewPage,
  type ReviewPageScope,
  type ReviewRevision,
  type ReviewThread,
} from '@kilocode/app-shared/provider-review';
import {
  GitLabInteractiveError,
  type GitLabInteractiveResponse,
} from '@/lib/integrations/platforms/gitlab/interactive-client';
import {
  GitLabPathSchema,
  GitLabUserSchema,
  gitLabActor,
  gitLabResourceUrl,
  parseGitLab,
  resolveGitLabReviewProject,
  type GitLabReviewAuthorization,
} from './gitlab-authorization';
import { MAX_GITLAB_RESPONSE_BYTES } from '@/lib/integrations/platforms/gitlab/safe-transport';

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_GITLAB_RESPONSE_BYTES)
    throw new GitLabInteractiveError('response_too_large');
  return value;
}

const id = z.number().int().positive();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const refs = z.object({ head_sha: sha, base_sha: sha, start_sha: sha });
const reviewSchema = z.object({
  id,
  iid: id,
  project_id: id,
  target_project_id: id,
  source_project_id: id.nullable(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  source_branch: z.string().nullable(),
  target_branch: z.string().min(1),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  sha: sha.nullish(),
  diff_refs: refs.nullish(),
  author: GitLabUserSchema.nullish(),
  assignees: z.array(GitLabUserSchema).nullish(),
  updated_at: z.string(),
  web_url: z.url(),
  detailed_merge_status: z.string().optional(),
  has_conflicts: z.boolean().optional(),
  blocking_discussions_resolved: z.boolean().optional(),
  merge_when_pipeline_succeeds: z.boolean().optional(),
  user: z.object({ can_merge: z.boolean().optional() }).nullish(),
  head_pipeline: z.object({ id, status: z.string().optional() }).nullish(),
});
const diffSchema = z.object({
  old_path: GitLabPathSchema,
  new_path: GitLabPathSchema,
  diff: z.string().nullish(),
  new_file: z.boolean(),
  deleted_file: z.boolean(),
  renamed_file: z.boolean(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
  binary: z.boolean().optional(),
});
const versionSchema = z.object({
  id,
  head_commit_sha: sha,
  base_commit_sha: sha,
  start_commit_sha: sha,
  state: z.string().optional(),
  real_size: z
    .string()
    .regex(/^\d+\+?$/)
    .optional(),
});
const approvalSchema = z.object({
  approved: z.boolean().optional(),
  approvals_required: z.number().int().nonnegative().optional(),
  approvals_left: z.number().int().nonnegative().optional(),
  approved_by: z.array(z.object({ user: GitLabUserSchema })),
});
const reviewerSchema = z.object({ user: GitLabUserSchema, state: z.string() });
const pipelineSchema = z.object({
  id,
  sha,
  status: z.string(),
  web_url: z.string().nullish(),
  name: z.string().nullish(),
});
const statusSchema = z.object({
  id,
  sha,
  status: z.string(),
  name: z.string(),
  target_url: z.string().nullish(),
  allow_failure: z.boolean().optional(),
});
const rangeEnd = z.object({
  line_code: z.string().min(1),
  type: z.enum(['old', 'new']),
  old_line: id.nullish(),
  new_line: id.nullish(),
});
const positionSchema = refs.extend({
  position_type: z.enum(['text', 'image', 'file']),
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  old_line: id.nullish(),
  new_line: id.nullish(),
  line_range: z.object({ start: rangeEnd, end: rangeEnd }).nullish(),
});
const noteSchema = z.object({
  id,
  body: z.string(),
  created_at: z.string(),
  author: GitLabUserSchema.nullish(),
  position: positionSchema.nullish(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  current_user: z.object({ can_resolve: z.boolean() }).optional(),
});
const discussionSchema = z.object({ id: z.string().min(1), notes: z.array(noteSchema).min(1) });
const awardSchema = z.object({ id, name: z.string().min(1), user: GitLabUserSchema });
const pageSize = 25;
const allPages = { perPage: 100, maxPages: 100 };

function revision(value: z.infer<typeof refs>): ReviewRevision {
  return {
    headSha: value.head_sha,
    baseSha: value.base_sha,
    startSha: value.start_sha,
    targetHeadSha: null,
  };
}
function versionRevision(value: z.infer<typeof versionSchema>): ReviewRevision {
  return revision({
    head_sha: value.head_commit_sha,
    base_sha: value.base_commit_sha,
    start_sha: value.start_commit_sha,
  });
}
function sameRevision(expected: ReviewRevision, actual: ReviewRevision) {
  const parsed = parseGitLab(ReviewRevisionSchema, expected, 'invalid_request');
  if (
    parsed.headSha !== actual.headSha ||
    parsed.baseSha !== actual.baseSha ||
    parsed.startSha !== actual.startSha ||
    parsed.targetHeadSha !== actual.targetHeadSha
  )
    throw new GitLabInteractiveError('conflict');
}
function assertIdentity(auth: GitLabReviewAuthorization, identity: ReviewIdentity) {
  if (
    repositoryResourceKey(auth.userId, identity) !==
    repositoryResourceKey(auth.userId, {
      repository: identity.repository,
      authorization: auth.authorization,
    })
  )
    throw new GitLabInteractiveError('forbidden');
}
function pagination(
  auth: GitLabReviewAuthorization,
  scope: ReviewPageScope,
  cursor?: ReviewCursor | null
) {
  const bound = {
    ...scope,
    resourceKey: JSON.stringify([scope.resourceKey, auth.actor.id, auth.credentialKind]),
  };
  let page = 1;
  if (cursor) {
    try {
      page = Number(parseReviewCursor(cursor, bound).token);
    } catch {
      throw new GitLabInteractiveError('invalid_request');
    }
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > 100)
    throw new GitLabInteractiveError('invalid_request');
  return {
    options: { page, perPage: pageSize, maxPages: 1 },
    finish<T>(items: T[], response: GitLabInteractiveResponse<unknown>): ReviewPage<T> {
      const nextLink = (response.headers.link ?? '').match(/<([^>]+)>;\s*rel="next"/);
      const token =
        response.headers['x-next-page'] ??
        (nextLink
          ? new URL(nextLink[1]).searchParams.get('page')
          : items.length === pageSize
            ? String(page + 1)
            : null);
      if (token && (Number(token) !== page + 1 || page >= 100))
        throw new GitLabInteractiveError('pagination_limit');
      return bounded<ReviewPage<T>>({
        items,
        nextCursor: token ? { scopeKey: reviewPageKey(bound), token } : null,
      });
    },
  };
}
function completeData<T>(response: GitLabInteractiveResponse<T>) {
  if (
    response.headers['x-next-page'] ||
    /rel="next"/.test(response.headers.link ?? '') ||
    Number(response.headers['x-total-pages'] ?? 1) > Number(response.headers['x-page'] ?? 1)
  )
    throw new GitLabInteractiveError('pagination_limit');
  return response.data;
}
async function optional<T>(operation: () => Promise<GitLabInteractiveResponse<T>>) {
  try {
    return completeData(await operation());
  } catch (error) {
    if (error instanceof GitLabInteractiveError && ['not_found', 'forbidden'].includes(error.code))
      return null;
    throw error;
  }
}
async function loadReview(
  auth: GitLabReviewAuthorization,
  repository: RepositoryIdentity,
  number: string,
  expectedId?: string
) {
  const iid = Number(parseGitLab(z.string().regex(/^[1-9]\d*$/), number, 'invalid_request'));
  parseGitLab(id, iid, 'invalid_request');
  const project = await resolveGitLabReviewProject(auth, repository.repositoryId, repository);
  const response = await project.client.execute(api =>
    api.MergeRequests.show(repository.repositoryId, iid)
  );
  const review = parseGitLab(reviewSchema, response.data);
  const canonicalUrl = `${project.canonicalUrl}/-/merge_requests/${iid}`;
  if (
    String(review.project_id) !== repository.repositoryId ||
    String(review.target_project_id) !== repository.repositoryId ||
    review.iid !== iid ||
    (expectedId !== undefined && String(review.id) !== expectedId) ||
    new URL(review.web_url).toString() !== canonicalUrl
  )
    throw new GitLabInteractiveError('not_found');
  if (!review.sha && !review.diff_refs) throw new GitLabInteractiveError('temporarily_unavailable');
  if (review.sha && review.diff_refs && review.sha !== review.diff_refs.head_sha)
    throw new GitLabInteractiveError('temporarily_unavailable');
  const currentRevision: ReviewRevision = review.diff_refs
    ? revision(review.diff_refs)
    : { headSha: review.sha ?? '', baseSha: null, startSha: null, targetHeadSha: null };
  const identity: ReviewIdentity = {
    repository: project.repository,
    authorization: auth.authorization,
    number,
    reviewId: String(review.id),
    canonicalUrl,
  };
  return { ...project, review, identity, revision: currentRevision, iid };
}
async function exactReview(auth: GitLabReviewAuthorization, identity: ReviewIdentity) {
  assertIdentity(auth, identity);
  return loadReview(auth, identity.repository, identity.number, identity.reviewId);
}
function inboxItem(
  auth: GitLabReviewAuthorization,
  repository: RepositoryIdentity,
  review: z.infer<typeof reviewSchema>
) {
  const canonicalUrl = gitLabResourceUrl(
    auth.instanceUrl,
    repository.fullName,
    `/-/merge_requests/${review.iid}`
  );
  if (
    String(review.project_id) !== repository.repositoryId ||
    String(review.target_project_id) !== repository.repositoryId ||
    new URL(review.web_url).toString() !== canonicalUrl
  )
    throw new GitLabInteractiveError('invalid_response');
  const identity: ReviewIdentity = {
    repository,
    authorization: auth.authorization,
    reviewId: String(review.id),
    number: String(review.iid),
    canonicalUrl,
  };
  return {
    identity,
    title: review.title,
    author: review.author ? gitLabActor(review.author, auth.instanceUrl) : null,
    state:
      review.state === 'opened'
        ? ('open' as const)
        : review.state === 'merged'
          ? ('merged' as const)
          : ('closed' as const),
    draft: review.draft ?? review.work_in_progress ?? false,
    updatedAt: review.updated_at,
  };
}

export async function listGitLabInbox(
  auth: GitLabReviewAuthorization,
  input: {
    repository?: RepositoryIdentity;
    filter?: 'reviewer' | 'author';
    cursor?: ReviewCursor | null;
  } = {}
): Promise<ReviewInbox> {
  if ((auth.authorization.owner.type === 'org' || auth.projectTokenId) && !input.repository)
    throw new GitLabInteractiveError('invalid_request');
  const project = input.repository
    ? await resolveGitLabReviewProject(auth, input.repository.repositoryId, input.repository)
    : null;
  const filter = input.filter ?? 'reviewer';
  const actorScoped = project === null;
  const scope = project
    ? { kind: 'repository' as const, actor: auth.actor, repository: project.repository }
    : { kind: 'actor' as const, actor: auth.actor };
  const page = pagination(
    auth,
    {
      resourceKey: JSON.stringify([auth.userId, auth.authorization, auth.instanceUrl, scope]),
      surface: 'inbox',
      queryKey: filter,
      revision: null,
    },
    input.cursor
  );
  const client = project?.client ?? auth.client();
  const response = await client.execute(api =>
    api.MergeRequests.all({
      ...page.options,
      scope: 'all',
      state: 'opened',
      orderBy: 'updated_at',
      sort: 'desc',
      ...(project
        ? { projectId: project.repository.repositoryId }
        : filter === 'author'
          ? { authorId: Number(auth.actor.id) }
          : { reviewerId: Number(auth.actor.id) }),
    })
  );
  const reviews = parseGitLab(z.array(reviewSchema).max(pageSize), response.data);
  const items = [];
  for (const review of reviews) {
    const repository =
      project?.repository ??
      (await resolveGitLabReviewProject(auth, String(review.project_id))).repository;
    items.push(inboxItem(auth, repository, review));
  }
  // Organization and project actors always retain an explicit repository scope, never a Personal label.
  return {
    ...page.finish(items, response),
    scope: actorScoped ? { kind: 'actor', actor: auth.actor } : scope,
  };
}

export async function listGitLabDiffVersions(
  auth: GitLabReviewAuthorization,
  identity: ReviewIdentity,
  cursor?: ReviewCursor | null
): Promise<ReviewPage<{ id: string; revision: ReviewRevision }>> {
  const loaded = await exactReview(auth, identity);
  const page = pagination(
    auth,
    {
      resourceKey: reviewResourceKey(auth.userId, identity),
      surface: 'files',
      queryKey: 'versions',
      revision: null,
    },
    cursor
  );
  const response = await loaded.client.execute(api =>
    api.MergeRequests.allDiffVersions(identity.repository.repositoryId, loaded.iid, page.options)
  );
  return page.finish(
    parseGitLab(z.array(versionSchema).max(pageSize), response.data).map(value => ({
      id: String(value.id),
      revision: versionRevision(value),
    })),
    response
  );
}
function fileFromDiff(
  auth: GitLabReviewAuthorization,
  loaded: Awaited<ReturnType<typeof loadReview>>,
  selected: ReviewRevision,
  diff: z.infer<typeof diffSchema>
): ReviewFile {
  const content =
    diff.too_large || diff.collapsed
      ? 'truncated'
      : diff.binary || /^Binary files /.test(diff.diff ?? '')
        ? 'binary'
        : diff.diff
          ? 'available'
          : 'unavailable';
  let additions = 0,
    deletions = 0,
    hunk = false;
  for (const line of (diff.diff ?? '').split('\n')) {
    if (line.startsWith('@@')) hunk = true;
    else if (hunk && line.startsWith('+')) additions++;
    else if (hunk && line.startsWith('-')) deletions++;
  }
  return {
    id: JSON.stringify([diff.old_path, diff.new_path]),
    oldPath: diff.old_path,
    newPath: diff.new_path,
    revision: selected,
    status: diff.renamed_file
      ? 'renamed'
      : diff.new_file
        ? 'added'
        : diff.deleted_file
          ? 'deleted'
          : 'modified',
    patch: content === 'available' ? (diff.diff ?? null) : null,
    content,
    additions: content === 'truncated' || diff.diff == null ? null : additions,
    deletions: content === 'truncated' || diff.diff == null ? null : deletions,
    canonicalUrl:
      diff.deleted_file || loaded.review.source_project_id === loaded.review.target_project_id
        ? gitLabResourceUrl(
            auth.instanceUrl,
            loaded.repository.fullName,
            `/-/blob/${diff.deleted_file ? selected.baseSha : selected.headSha}/${(diff.deleted_file ? diff.old_path : diff.new_path).split('/').map(encodeURIComponent).join('/')}`
          )
        : `${loaded.identity.canonicalUrl}/diffs`,
  };
}
function requireCompleteDiffVersion(version: z.infer<typeof versionSchema> | undefined) {
  // A terminal diff page does not prove completeness when GitLab applies its diff limits.
  if (version?.state?.startsWith('overflow') || version?.real_size?.endsWith('+'))
    throw new GitLabInteractiveError('response_too_large');
  if (
    !version ||
    (!['collected', 'without_files'].includes(version.state ?? '') &&
      !(version.state === 'empty' && version.real_size === '0'))
  )
    throw new GitLabInteractiveError('temporarily_unavailable');
  return version;
}
async function versionDiffs(
  loaded: Awaited<ReturnType<typeof loadReview>>,
  selected: ReviewRevision,
  versionId: string
) {
  const versionNumber = parseGitLab(
    id,
    Number(parseGitLab(z.string().regex(/^[1-9]\d*$/), versionId, 'invalid_request')),
    'invalid_request'
  );
  const response = await loaded.client.execute(api =>
    api.MergeRequests.showDiffVersion(loaded.repository.repositoryId, loaded.iid, versionNumber)
  );
  const version = parseGitLab(versionSchema.extend({ diffs: z.array(diffSchema) }), response.data);
  if (String(version.id) !== versionId) throw new GitLabInteractiveError('invalid_response');
  sameRevision(selected, versionRevision(version));
  requireCompleteDiffVersion(version);
  return version.diffs;
}
async function currentDiffs(
  loaded: Awaited<ReturnType<typeof loadReview>>,
  options: typeof allPages & { page?: number }
) {
  const versions = parseGitLab(
    z.array(versionSchema),
    completeData(
      await loaded.client.execute(api =>
        api.MergeRequests.allDiffVersions(loaded.repository.repositoryId, loaded.iid)
      )
    )
  );
  const current = requireCompleteDiffVersion(
    versions.find(
      value =>
        value.head_commit_sha === loaded.revision.headSha &&
        value.base_commit_sha === loaded.revision.baseSha &&
        value.start_commit_sha === loaded.revision.startSha
    )
  );
  const response = await loaded.client.execute(api =>
    api.MergeRequests.allDiffs(loaded.repository.repositoryId, loaded.iid, options)
  );
  const diffs = parseGitLab(
    z.array(diffSchema).max(options.perPage * options.maxPages),
    options.maxPages === 1 ? response.data : completeData(response)
  );
  const terminal =
    options.maxPages !== 1 ||
    response.headers['x-next-page'] === '' ||
    (!response.headers['x-next-page'] &&
      !/rel="next"/.test(response.headers.link ?? '') &&
      diffs.length < options.perPage);
  const received = ((options.page ?? 1) - 1) * options.perPage + diffs.length;
  if (terminal && current.real_size !== undefined && Number(current.real_size) > received)
    throw new GitLabInteractiveError('response_too_large');
  return { response, diffs };
}
export async function listGitLabFiles(
  auth: GitLabReviewAuthorization,
  identity: ReviewIdentity,
  selected: ReviewRevision,
  cursor?: ReviewCursor | null,
  versionId?: string
): Promise<ReviewPage<ReviewFile>> {
  const loaded = await exactReview(auth, identity);
  if (!versionId && !loaded.review.diff_refs)
    throw new GitLabInteractiveError('temporarily_unavailable');
  const page = pagination(
    auth,
    {
      resourceKey: reviewResourceKey(auth.userId, identity),
      surface: 'files',
      queryKey: versionId ?? 'current',
      revision: selected,
    },
    cursor
  );
  if (versionId) {
    const diffs = await versionDiffs(loaded, selected, versionId);
    const start = (page.options.page - 1) * pageSize;
    return page.finish(
      diffs.slice(start, start + pageSize).map(diff => fileFromDiff(auth, loaded, selected, diff)),
      {
        status: 200,
        data: null,
        headers: {
          'x-next-page': start + pageSize < diffs.length ? String(page.options.page + 1) : '',
        },
      }
    );
  }
  sameRevision(selected, loaded.revision);
  const { response, diffs } = await currentDiffs(loaded, page.options);
  sameRevision(selected, (await exactReview(auth, identity)).revision);
  return page.finish(
    diffs.map(diff => fileFromDiff(auth, loaded, selected, diff)),
    response
  );
}

export async function getGitLabFileContext(
  auth: GitLabReviewAuthorization,
  identity: ReviewIdentity,
  input: {
    file: Pick<ReviewFile, 'oldPath' | 'newPath' | 'revision'>;
    side: 'old' | 'new';
    startLine: number;
    lineCount: number;
    versionId?: string;
  }
): Promise<ReviewFileContext> {
  parseGitLab(
    z.object({ side: z.enum(['old', 'new']), startLine: id, lineCount: id.max(500) }),
    input,
    'invalid_request'
  );
  const loaded = await exactReview(auth, identity);
  const selected = parseGitLab(ReviewRevisionSchema, input.file.revision, 'invalid_request');
  let diffs;
  if (input.versionId) diffs = await versionDiffs(loaded, selected, input.versionId);
  else {
    sameRevision(selected, loaded.revision);
    diffs = (await currentDiffs(loaded, allPages)).diffs;
    sameRevision(selected, (await exactReview(auth, identity)).revision);
  }
  const files = diffs.map(diff => fileFromDiff(auth, loaded, selected, diff));
  if (
    !files.some(file => file.oldPath === input.file.oldPath && file.newPath === input.file.newPath)
  )
    throw new GitLabInteractiveError('conflict');
  const filePath = input.side === 'old' ? input.file.oldPath : input.file.newPath;
  const commit = input.side === 'old' ? selected.baseSha : selected.headSha;
  if (!filePath || !commit) throw new GitLabInteractiveError('invalid_request');
  parseGitLab(sha, commit, 'invalid_request');
  const result = bounded<ReviewFileContext>({
    revision: selected,
    path: filePath,
    side: input.side,
    startLine: input.startLine,
    lines: [],
    totalLines: null,
    content: 'unavailable',
    canonicalUrl: loaded.identity.canonicalUrl,
  });
  try {
    const sourceId =
      input.side === 'new' ? loaded.review.source_project_id : loaded.review.target_project_id;
    if (sourceId === null) return result;
    const project =
      String(sourceId) === loaded.repository.repositoryId
        ? loaded
        : await resolveGitLabReviewProject(auth, String(sourceId));
    result.canonicalUrl = gitLabResourceUrl(
      auth.instanceUrl,
      project.repository.fullName,
      `/-/blob/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`
    );
    const response = await project.client.execute(api =>
      api.RepositoryFiles.show(String(sourceId), filePath, commit)
    );
    const file = parseGitLab(
      z.object({
        file_path: z.string(),
        commit_id: sha,
        encoding: z.literal('base64'),
        content: z.string(),
        size: z.number().int().nonnegative(),
      }),
      response.data
    );
    if (file.file_path !== filePath || file.commit_id !== commit)
      throw new GitLabInteractiveError('conflict');
    const encoded = file.content.replace(/\s/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new GitLabInteractiveError('invalid_response');
    if (bytes.length !== file.size) return { ...result, content: 'truncated' };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ...result, content: 'binary' };
    }
    if (bytes.includes(0)) return { ...result, content: 'binary' };
    const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
    return bounded<ReviewFileContext>({
      ...result,
      content: 'available',
      lines: lines.slice(input.startLine - 1, input.startLine - 1 + input.lineCount),
      totalLines: lines.length,
    });
  } catch (error) {
    if (error instanceof GitLabInteractiveError && error.code === 'response_too_large')
      return { ...result, content: 'truncated' };
    if (error instanceof GitLabInteractiveError && ['not_found', 'forbidden'].includes(error.code))
      return result;
    throw error;
  }
}

function checkState(
  status: string
): 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled' | 'unknown' {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'manual':
    case 'scheduled':
      return 'pending';
    case 'running':
      return 'running';
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}
function detailsUrl(value?: string | null) {
  return z.url({ protocol: /^https$/ }).safeParse(value).success ? (value ?? null) : null;
}
async function checksFor(
  loaded: Awaited<ReturnType<typeof loadReview>>
): Promise<ReviewOverview['checks']> {
  const pipelines = await optional(() =>
    loaded.client.execute(api =>
      api.MergeRequests.allPipelines(loaded.repository.repositoryId, loaded.iid, allPages)
    )
  );
  const statuses = await optional(() =>
    loaded.client.execute(api =>
      api.Commits.allStatuses(loaded.repository.repositoryId, loaded.revision.headSha, allPages)
    )
  );
  if (pipelines === null || statuses === null)
    return { status: 'unavailable', explanation: 'forbidden_or_unavailable' };
  const checks = [
    ...parseGitLab(z.array(pipelineSchema), pipelines)
      .filter(
        value =>
          value.sha === loaded.revision.headSha || value.id === loaded.review.head_pipeline?.id
      )
      .map(value => ({
        id: `pipeline:${value.id}`,
        name: value.name || `#${value.id}`,
        state: checkState(value.status),
        required:
          value.id === loaded.review.head_pipeline?.id
            ? (loaded.project.only_allow_merge_if_pipeline_succeeds ?? null)
            : false,
        detailsUrl: detailsUrl(value.web_url),
      })),
    ...parseGitLab(z.array(statusSchema), statuses)
      .filter(value => value.sha === loaded.revision.headSha)
      .map(value => ({
        id: `status:${value.id}`,
        name: value.name,
        state: checkState(value.status),
        required: value.allow_failure === undefined ? null : !value.allow_failure,
        detailsUrl: detailsUrl(value.target_url),
      })),
  ];
  return checks.length ? { status: 'reported', checks } : { status: 'none', checks: [] };
}
export async function getGitLabChecks(
  auth: GitLabReviewAuthorization,
  identity: ReviewIdentity,
  selected?: ReviewRevision
): Promise<ReviewOverview['checks']> {
  const loaded = await exactReview(auth, identity);
  if (selected) sameRevision(selected, loaded.revision);
  const checks = await checksFor(loaded);
  sameRevision(loaded.revision, (await exactReview(auth, identity)).revision);
  return bounded(checks);
}

export async function getGitLabReview(
  auth: GitLabReviewAuthorization,
  repository: RepositoryIdentity,
  number: string
): Promise<ReviewOverview> {
  const loaded = await loadReview(auth, repository, number);
  const { review, client, iid } = loaded;
  const metadataData = await optional(() => client.execute(api => api.Metadata.show()));
  const metadata =
    metadataData === null
      ? null
      : parseGitLab(
          z.object({ version: z.string(), enterprise: z.boolean().optional() }),
          metadataData
        );
  const approvalData = await optional(() =>
    client.execute(api =>
      api.MergeRequestApprovals.showConfiguration(repository.repositoryId, { mergerequestIId: iid })
    )
  );
  const approvals = approvalData === null ? null : parseGitLab(approvalSchema, approvalData);
  // The approval state lists eligible users; the approvals endpoint lists every approving user.
  const approvalStateData = await optional(() =>
    client.execute(api => api.MergeRequestApprovals.showApprovalState(repository.repositoryId, iid))
  );
  const approvalState =
    approvalStateData === null
      ? null
      : parseGitLab(
          z.object({
            rules: z.array(z.object({ eligible_approvers: z.array(GitLabUserSchema).optional() })),
          }),
          approvalStateData
        );
  const canApprove = approvalState?.rules.some(rule =>
    rule.eligible_approvers?.some(user => String(user.id) === auth.actor.id)
  )
    ? true
    : undefined;
  const hasApproved = approvals?.approved_by.some(item => String(item.user.id) === auth.actor.id);
  const reviewerData = await optional(() =>
    client.execute(api => api.MergeRequests.showReviewers(repository.repositoryId, iid))
  );
  const reviewers =
    reviewerData === null ? null : parseGitLab(z.array(reviewerSchema), reviewerData);
  const checks = await checksFor(loaded);
  const { diffs } = await currentDiffs(loaded, allPages);
  const files = diffs.map(diff => fileFromDiff(auth, loaded, loaded.revision, diff));
  const commits = parseGitLab(
    z.array(z.object({ id: sha })),
    completeData(
      await client.execute(api =>
        api.MergeRequests.allCommits(repository.repositoryId, iid, allPages)
      )
    )
  );
  sameRevision(
    loaded.revision,
    (await loadReview(auth, repository, number, loaded.identity.reviewId)).revision
  );
  let source: RepositoryIdentity | null =
    review.source_project_id === review.target_project_id ? loaded.repository : null;
  if (!source && review.source_project_id !== null) {
    try {
      source = (await resolveGitLabReviewProject(auth, String(review.source_project_id)))
        .repository;
    } catch (error) {
      if (
        !(error instanceof GitLabInteractiveError) ||
        !['not_found', 'forbidden'].includes(error.code)
      )
        throw error;
    }
  }
  const version = metadata?.version.match(/^(\d+)\.(\d+)\./);
  const modernAutoMerge = version
    ? Number(version[1]) > 17 || (Number(version[1]) === 17 && Number(version[2]) >= 11)
    : null;
  const writable =
    auth.scopes === null ? 'unknown' : auth.scopes.includes('api') ? 'allowed' : 'forbidden';
  const access = Math.max(
    loaded.project.permissions?.project_access?.access_level ?? 0,
    loaded.project.permissions?.group_access?.access_level ?? 0
  );
  const currentPipelineState =
    review.head_pipeline?.status !== undefined
      ? checkState(review.head_pipeline.status)
      : checks.status === 'reported'
        ? checks.checks.find(check => check.id === `pipeline:${review.head_pipeline?.id}`)?.state
        : undefined;
  const restrictions = [
    ...(review.state !== 'opened' ? [review.state] : []),
    ...(review.draft || review.work_in_progress ? ['draft'] : []),
    ...(review.has_conflicts ? ['conflict'] : []),
    ...(review.detailed_merge_status &&
    review.detailed_merge_status !== 'mergeable' &&
    review.detailed_merge_status !== 'can_be_merged'
      ? [review.detailed_merge_status]
      : []),
    ...(loaded.project.only_allow_merge_if_all_discussions_are_resolved &&
    review.blocking_discussions_resolved !== true
      ? ['discussions_not_resolved']
      : []),
    ...(loaded.project.only_allow_merge_if_pipeline_succeeds &&
    currentPipelineState !== 'passed' &&
    !(currentPipelineState === 'skipped' && loaded.project.allow_merge_on_skipped_pipeline)
      ? ['pipeline_not_successful']
      : []),
    ...(!loaded.project.merge_method ? ['merge_method_unknown'] : []),
  ];
  const capability: ReviewCapability = {
    support: 'supported',
    version: 'available',
    license: 'available',
    permission: writable,
    restrictions: [],
    explanation: '',
    evidenceUrl: 'https://docs.gitlab.com/api/merge_requests/',
    recovery:
      writable === 'forbidden' ? 'reconnect' : writable === 'unknown' ? 'openProvider' : 'none',
    expectedHeadProtection: 'none',
  };
  const permission = (allowed?: boolean): ReviewCapability['permission'] =>
    writable !== 'allowed'
      ? writable
      : allowed === undefined
        ? 'unknown'
        : allowed
          ? 'allowed'
          : 'forbidden';
  const capabilities = ReviewCapabilitiesSchema.parse(
    Object.fromEntries(
      ReviewActionSchema.options.map(action => {
        const value: ReviewCapability = {
          ...capability,
          permission: permission(access > 0 ? true : undefined),
        };
        if (action === 'read') {
          value.permission = 'allowed';
          value.recovery = 'none';
        }
        if (action === 'merge' || action === 'enableAutoMerge' || action === 'disableAutoMerge') {
          value.permission = permission(review.user?.can_merge);
          value.restrictions =
            action === 'disableAutoMerge'
              ? review.merge_when_pipeline_succeeds
                ? []
                : ['auto_merge_not_enabled']
              : action === 'enableAutoMerge'
                ? restrictions.filter(
                    reason =>
                      ![
                        'pipeline_not_successful',
                        'ci_still_running',
                        ...(modernAutoMerge
                          ? ['not_approved', 'requested_changes', 'discussions_not_resolved']
                          : []),
                      ].includes(reason)
                  )
                : restrictions;
        }
        if (action === 'approve') value.permission = permission(canApprove);
        if (action === 'unapprove') {
          value.permission = permission(true);
          value.restrictions =
            hasApproved === undefined
              ? ['approval_state_unknown']
              : hasApproved
                ? []
                : ['not_approved'];
          value.explanation = value.restrictions[0] ?? '';
          if (hasApproved === undefined) value.recovery = 'refresh';
        }
        if (action === 'approve' || action === 'unapprove')
          value.evidenceUrl = 'https://docs.gitlab.com/api/merge_request_approvals/';
        if (
          [
            'deleteBranch',
            'updateBranch',
            'removeChangeRequest',
            'resolveThread',
            'reopenThread',
          ].includes(action)
        )
          value.permission = permission();
        if (action === 'inlineComment') value.expectedHeadProtection = 'revisionAttachment';
        if (action === 'merge' || action === 'approve')
          value.expectedHeadProtection = 'atomicSource';
        if (action === 'requestChanges') {
          const assigned = reviewers?.some(item => String(item.user.id) === auth.actor.id);
          // update_merge_request permits Developers, authors, and assignees of readable reviews.
          const canUpdate =
            access >= 30 ||
            String(review.author?.id) === auth.actor.id ||
            review.assignees?.some(user => String(user.id) === auth.actor.id)
              ? true
              : undefined;
          value.permission =
            assigned === false ? 'forbidden' : permission(assigned ? canUpdate : undefined);
          value.version = reviewers?.some(item => item.state === 'requested_changes')
            ? 'available'
            : 'unknown';
          value.explanation = value.version === 'unknown' ? 'review_state_support_unknown' : '';
          value.evidenceUrl =
            'https://docs.gitlab.com/api/graphql/reference/#mutationmergerequestrequestchanges';
        }
        if (action === 'enableAutoMerge' || action === 'disableAutoMerge') {
          value.version = modernAutoMerge === null ? 'unknown' : 'available';
          // Old instances use merge_when_pipeline_succeeds. Remove this legacy form only after
          // pre-17.11 instances and old clients/records disappear and the 30-day ledger window expires.
          value.explanation =
            modernAutoMerge === null
              ? 'version_unknown'
              : modernAutoMerge
                ? 'auto_merge'
                : 'merge_when_pipeline_succeeds';
        }
        if (value.version === 'unknown') value.recovery = 'openProvider';
        if (value.permission !== 'allowed' && !value.explanation)
          value.explanation = value.permission;
        if (value.permission !== 'allowed')
          value.recovery =
            value.permission === 'forbidden' && writable === 'forbidden'
              ? 'reconnect'
              : 'openProvider';
        return [action, value];
      })
    )
  );
  const blocksMerge =
    review.detailed_merge_status === 'requested_changes'
      ? true
      : metadata?.enterprise === false
        ? false
        : null;
  const { identity, title, author, state, draft } = inboxItem(auth, loaded.repository, review);
  return bounded<ReviewOverview>({
    identity,
    title,
    author,
    state,
    draft,
    bodyMarkdown: review.description ?? null,
    revision: loaded.revision,
    source: { repository: source, branch: review.source_branch },
    target: { repository: loaded.repository, branch: review.target_branch },
    authorization: {
      actor: auth.actor,
      credentialKind: auth.credentialKind,
      capabilities,
      writeLimits: { requestMaxBytes: REVIEW_WRITE_REQUEST_MAX_BYTES, bodyMaxBytes: null },
    },
    providerState: {
      provider: 'gitlab',
      approvals: {
        approved: approvals?.approved ?? null,
        required: approvals?.approvals_required ?? null,
        remaining: approvals?.approvals_left ?? null,
        actorIds: approvals?.approved_by.map(item => String(item.user.id)) ?? [],
      },
      requestedChanges: {
        actorIds:
          reviewers
            ?.filter(item => item.state === 'requested_changes')
            .map(item => String(item.user.id)) ?? [],
        blocksMerge,
        blockingCapability: {
          ...capability,
          version: blocksMerge === true ? 'available' : 'unknown',
          license:
            blocksMerge === true
              ? 'available'
              : metadata?.enterprise === false
                ? 'unavailable'
                : 'unknown',
          permission: 'allowed',
          explanation: blocksMerge === null ? 'license_or_feature_flag_unknown' : '',
          recovery: blocksMerge === null ? 'openProvider' : 'none',
          evidenceUrl:
            'https://docs.gitlab.com/user/project/merge_requests/reviews/#request-changes',
        },
      },
    },
    checks,
    counts: {
      commits: commits.length,
      files: files.length,
      additions: files.reduce<number | null>(
        (total, file) =>
          total === null || file.additions === null ? null : total + file.additions,
        0
      ),
      deletions: files.reduce<number | null>(
        (total, file) =>
          total === null || file.deletions === null ? null : total + file.deletions,
        0
      ),
    },
    merge: {
      methods: loaded.project.merge_method
        ? [{ id: loaded.project.merge_method, label: loaded.project.merge_method }]
        : [],
      squash:
        loaded.project.squash_option === 'always'
          ? 'required'
          : loaded.project.squash_option === 'never'
            ? 'forbidden'
            : loaded.project.squash_option
              ? 'optional'
              : null,
      autoMerge: review.merge_when_pipeline_succeeds
        ? { method: loaded.project.merge_method ?? 'unknown' }
        : null,
      task: null,
    },
  });
}

export async function listGitLabDiscussions(
  auth: GitLabReviewAuthorization,
  identity: ReviewIdentity,
  cursor?: ReviewCursor | null
): Promise<ReviewPage<ReviewThread>> {
  const loaded = await exactReview(auth, identity);
  const page = pagination(
    auth,
    {
      resourceKey: reviewResourceKey(auth.userId, identity),
      surface: 'threads',
      queryKey: 'all',
      revision: loaded.revision,
    },
    cursor
  );
  const response = await loaded.client.execute(api =>
    api.MergeRequestDiscussions.all(loaded.repository.repositoryId, loaded.iid, page.options)
  );
  const discussions = parseGitLab(z.array(discussionSchema).max(pageSize), response.data);
  if (discussions.reduce((count, discussion) => count + discussion.notes.length, 0) > 100)
    throw new GitLabInteractiveError('response_too_large');
  const items: ReviewThread[] = [];
  for (const discussion of discussions) {
    const first = discussion.notes[0];
    const resolvableNotes = discussion.notes.filter(note => note.resolvable !== false);
    const resolved = resolvableNotes.some(note => note.resolvable && note.resolved === false)
      ? false
      : resolvableNotes.length > 0 &&
          resolvableNotes.every(note => note.resolvable && note.resolved === true)
        ? true
        : null;
    const native = first.position;
    const file = native
      ? {
          oldPath: native.old_path ?? null,
          newPath: native.new_path ?? null,
          revision: revision(native),
        }
      : null;
    const mapEnd = (end: z.infer<typeof rangeEnd>) => ({
      lineCode: end.line_code,
      side: end.type,
      oldLine: end.old_line ?? null,
      newLine: end.new_line ?? null,
    });
    const position =
      native?.position_type === 'text'
        ? parseGitLab(ReviewPositionSchema, {
            ...file,
            side: native.line_range?.end.type ?? (native.new_line ? 'new' : 'old'),
            line: native.line_range
              ? native.line_range.end.type === 'old'
                ? native.line_range.end.old_line
                : native.line_range.end.new_line
              : (native.new_line ?? native.old_line),
            ...(native.line_range
              ? {
                  startSide: native.line_range.start.type,
                  startLine:
                    native.line_range.start.type === 'old'
                      ? native.line_range.start.old_line
                      : native.line_range.start.new_line,
                }
              : {}),
            native: {
              provider: 'gitlab',
              oldLine: native.old_line ?? null,
              newLine: native.new_line ?? null,
              ...(native.line_range
                ? {
                    lineRange: {
                      start: mapEnd(native.line_range.start),
                      end: mapEnd(native.line_range.end),
                    },
                  }
                : {}),
            },
          })
        : null;
    const comments = [];
    for (const note of discussion.notes) {
      const awards = parseGitLab(
        z.array(awardSchema),
        completeData(
          await loaded.client.execute(api =>
            api.MergeRequestNoteAwardEmojis.all(
              loaded.repository.repositoryId,
              loaded.iid,
              note.id,
              allPages
            )
          )
        )
      );
      const reactions = new Map<
        string,
        { id: string; content: string; count: number; viewerHasReacted: boolean }
      >();
      for (const award of awards) {
        const own = String(award.user.id) === auth.actor.id;
        const old = reactions.get(award.name);
        reactions.set(award.name, {
          id: own ? String(award.id) : (old?.id ?? String(award.id)),
          content: award.name,
          count: (old?.count ?? 0) + 1,
          viewerHasReacted: own || old?.viewerHasReacted === true,
        });
      }
      comments.push({
        id: String(note.id),
        reference: {
          provider: 'gitlab' as const,
          kind: 'comment' as const,
          id: String(note.id),
          url: `${loaded.identity.canonicalUrl}#note_${note.id}`,
        },
        author: note.author ? gitLabActor(note.author, auth.instanceUrl) : null,
        bodyMarkdown: note.body,
        createdAt: note.created_at,
        reactions: [...reactions.values()],
      });
      bounded(comments);
    }
    // GitLab permits Developers, Maintainers, Owners, and the merge request author to resolve threads.
    const isAuthor = String(loaded.review.author?.id) === auth.actor.id;
    const canResolve =
      first.current_user?.can_resolve ??
      (isAuthor
        ? true
        : loaded.project.permissions
          ? Math.max(
              loaded.project.permissions.project_access?.access_level ?? 0,
              loaded.project.permissions.group_access?.access_level ?? 0
            ) >= 30
          : undefined);
    const missingGrant = auth.scopes !== null && !auth.scopes.includes('api');
    const resolveCapability: ReviewCapability = {
      support: 'supported',
      version: 'available',
      license: 'available',
      permission: missingGrant
        ? 'forbidden'
        : auth.scopes === null || canResolve === undefined
          ? 'unknown'
          : canResolve
            ? 'allowed'
            : 'forbidden',
      restrictions: first.resolvable ? [] : ['not_resolvable'],
      explanation: first.resolvable ? '' : 'not_resolvable',
      recovery: missingGrant
        ? 'reconnect'
        : auth.scopes === null || canResolve !== true
          ? 'openProvider'
          : 'none',
      evidenceUrl: 'https://docs.gitlab.com/api/discussions/',
      expectedHeadProtection: 'none',
    };
    items.push({
      id: discussion.id,
      reference: {
        provider: 'gitlab',
        kind: 'thread',
        id: discussion.id,
        url: `${loaded.identity.canonicalUrl}#note_${first.id}`,
      },
      subjectType: position ? 'line' : file ? 'file' : 'conversation',
      file,
      position,
      diffHunk: null,
      resolved,
      outdated: native
        ? native.head_sha !== loaded.revision.headSha ||
          native.base_sha !== loaded.revision.baseSha ||
          native.start_sha !== loaded.revision.startSha
        : null,
      comments: { items: comments, nextCursor: null },
      capabilities: { resolveThread: resolveCapability, reopenThread: resolveCapability },
    });
    bounded(items);
  }
  sameRevision(loaded.revision, (await exactReview(auth, identity)).revision);
  return page.finish(items, response);
}
