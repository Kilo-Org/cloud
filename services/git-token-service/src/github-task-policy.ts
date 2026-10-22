import { z } from 'zod';
import {
  allowGitHubTaskRequest as allow,
  denyGitHubTaskRequest as deny,
  allowGitHubTaskRead,
  type GitHubTaskDecision,
  type GitHubTaskGrant,
} from '@kilocode/worker-utils/github-task-grant';
import { authorizeGitHubTaskGraphql } from './github-task-graphql.js';
import { getGitHubTaskArchive } from '@kilocode/worker-utils/github-task-archive';
import {
  GITHUB_LFS_CONTENT_TYPE,
  getGitHubTaskLfsRoute,
  githubLfsBatchSchema,
  githubLfsLockVerificationSchema,
} from '@kilocode/worker-utils/github-task-lfs';

export const MAX_GITHUB_TASK_JSON_BYTES = 256 * 1024;

export type GitHubTaskRequest = {
  method: string;
  url: string;
  contentType?: string;
  body?: Uint8Array;
};

const pullRequestCreateSchema = z
  .object({
    title: z.string().min(1).max(1024),
    body: z.string().max(65_536).optional(),
    head: z.string().min(1),
    base: z.string().min(1),
    draft: z.boolean().optional(),
    maintainer_can_modify: z.boolean().optional(),
  })
  .strict();
const pullRequestUpdateSchema = z
  .object({
    title: z.string().min(1).max(1024).optional(),
    body: z.string().max(65_536).optional(),
    state: z.enum(['open', 'closed']).optional(),
    base: z.string().min(1).optional(),
    maintainer_can_modify: z.boolean().optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0);
const commentSchema = z.object({ body: z.string().min(1).max(65_536) }).strict();
const reviewLocation = {
  path: z.string().min(1).max(4096).optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  start_line: z.number().int().positive().optional(),
  start_side: z.enum(['LEFT', 'RIGHT']).optional(),
  position: z.number().int().positive().optional(),
};
const pullReviewSchema = z
  .object({
    body: z.string().max(65_536).optional(),
    event: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
    commit_id: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    comments: z
      .array(z.object({ body: z.string().min(1).max(65_536), ...reviewLocation }).strict())
      .max(100)
      .optional(),
  })
  .strict();
const reviewCommentSchema = z
  .object({
    body: z.string().min(1).max(65_536),
    commit_id: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    subject_type: z.enum(['line', 'file']).optional(),
    in_reply_to: z.number().int().positive().optional(),
    ...reviewLocation,
  })
  .strict();

const issueFields = {
  title: z.string().min(1).max(1024),
  body: z.string().max(65_536).optional(),
  assignees: z.array(z.string().min(1)).max(100).optional(),
  labels: z
    .array(z.union([z.string(), z.number().int().positive()]))
    .max(100)
    .optional(),
  milestone: z.number().int().positive().nullable().optional(),
};
const issueCreateSchema = z.object(issueFields).strict();
const issueUpdateSchema = z
  .object({
    ...issueFields,
    title: issueFields.title.optional(),
    state: z.enum(['open', 'closed']).optional(),
    state_reason: z.enum(['completed', 'not_planned', 'reopened']).nullable().optional(),
  })
  .strict();

function parseUrl(value: string): URL | null {
  if (
    [...value].some(
      character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    ) ||
    value.includes('\\')
  )
    return null;
  // Inspect the original path, before URL parsing removes dot segments.
  const rawPath = value.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    /[%\\]/.test(decoded) ||
    [...decoded].some(
      character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    decoded.includes('//') ||
    decoded.split('/').some(part => part === '.' || part === '..')
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function jsonBody(request: GitHubTaskRequest, contentType = 'application/json'): unknown {
  if (
    request.contentType?.split(';', 1)[0].trim().toLowerCase() !== contentType ||
    !request.body ||
    request.body.byteLength > MAX_GITHUB_TASK_JSON_BYTES
  ) {
    return undefined;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(request.body)
    );
  } catch {
    return undefined;
  }
}

function repositoryRead(owner: string, name: string, grant: GitHubTaskGrant): GitHubTaskDecision {
  return owner === grant.repository.owner && name === grant.repository.name
    ? allowGitHubTaskRead()
    : allowGitHubTaskRead([{ kind: 'repository-read', owner, name }]);
}

function authorizeGit(
  request: GitHubTaskRequest,
  url: URL,
  grant: GitHubTaskGrant
): GitHubTaskDecision {
  const match = /^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\.git\/(.+)$/i.exec(url.pathname);
  if (!match) return deny('repository_mismatch');
  const [, rawOwner, rawName, route] = match;
  const owner = rawOwner.toLowerCase();
  const name = rawName.toLowerCase();
  const write = () =>
    owner === grant.repository.owner && name === grant.repository.name
      ? allow()
      : deny('repository_mismatch');
  const download = () => repositoryRead(owner, name, grant);
  const lfs = getGitHubTaskLfsRoute(url);
  if (lfs?.kind === 'batch') {
    const batch = githubLfsBatchSchema.safeParse(jsonBody(request, GITHUB_LFS_CONTENT_TYPE));
    if (request.method !== 'POST' || !batch.success) return deny('invalid_upstream_request');
    return batch.data.operation === 'download' ? download() : write();
  }
  if (lfs?.kind === 'download')
    return request.method === 'GET' ? download() : deny('operation_not_allowed');
  if (lfs?.kind === 'upload')
    return request.method === 'PUT' ? write() : deny('operation_not_allowed');
  if (lfs?.kind === 'locks-verify') {
    const verification = githubLfsLockVerificationSchema.safeParse(
      jsonBody(request, GITHUB_LFS_CONTENT_TYPE)
    );
    return request.method === 'POST' && verification.success
      ? write()
      : deny('invalid_upstream_request');
  }
  if (request.method === 'GET' && route === 'info/refs') {
    if ([...url.searchParams].length !== 1) return deny('invalid_upstream_request');
    const service = url.searchParams.get('service');
    return service === 'git-upload-pack'
      ? download()
      : service === 'git-receive-pack'
        ? write()
        : deny('invalid_upstream_request');
  }
  if (request.method !== 'POST' || url.search) return deny('operation_not_allowed');
  if (route === 'git-upload-pack') return download();
  if (route === 'git-receive-pack')
    return request.contentType === 'application/x-git-receive-pack-request'
      ? write()
      : deny('invalid_upstream_request');
  return deny('operation_not_allowed');
}

function authorizeRest(
  request: GitHubTaskRequest,
  url: URL,
  grant: GitHubTaskGrant
): GitHubTaskDecision {
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (read && url.pathname === '/user') return allowGitHubTaskRead();
  const ownerRoute = /^\/(orgs|users)\/([a-z0-9_.-]+)(\/repos)?$/i.exec(url.pathname);
  if (read && ownerRoute) {
    return ownerRoute[2].toLowerCase() === grant.repository.owner
      ? allowGitHubTaskRead([{ kind: 'owner-read' }])
      : deny('repository_mismatch');
  }
  const parts = url.pathname.split('/');
  // Decode only path components after the owner/repository boundary.
  if (
    parts[1] !== 'repos' ||
    !/^[a-z0-9_.-]+$/i.test(parts[2] ?? '') ||
    !/^[a-z0-9_.-]+$/i.test(parts[3] ?? '')
  ) {
    return deny('repository_mismatch');
  }
  const owner = parts[2].toLowerCase();
  const name = parts[3].toLowerCase();
  const path = decodeURIComponent(parts.slice(4).join('/'));
  const download = () => repositoryRead(owner, name, grant);
  if (read) {
    if (getGitHubTaskArchive(url)) return download();
    const allowed =
      path === '' ||
      /^(?:contents(?:\/.*)?|readme|branches(?:\/[^/]+)?|tags|languages)$/.test(path) ||
      /^(?:commits(?:\/[^/]+(?:\/(?:status|statuses|check-runs))?)?|compare\/[^/]+|git\/(?:ref|refs|matching-refs)\/.*|git\/(?:blobs|trees|commits)\/[a-f0-9]{40})$/.test(
        path
      ) ||
      /^(?:pulls(?:\/[1-9]\d*(?:\/(?:files|commits|reviews|comments))?)?|issues(?:\/[1-9]\d*(?:\/(?:comments|events|labels))?)?|issues\/comments\/[1-9]\d*|labels(?:\/[^/]+)?|milestones(?:\/[1-9]\d*)?)$/.test(
        path
      ) ||
      /^(?:actions\/runs(?:\/[1-9]\d*(?:\/(?:jobs|artifacts))?)?|actions\/jobs\/[1-9]\d*|check-runs\/[1-9]\d*|check-suites\/[1-9]\d*\/check-runs)$/.test(
        path
      );
    return allowed ? download() : deny('operation_not_allowed');
  }
  if (owner !== grant.repository.owner || name !== grant.repository.name)
    return deny('repository_mismatch');
  // Mutation query parameters can introduce alternate operations. Supported writes use JSON only.
  if (url.search) return deny('invalid_upstream_request');
  const body = jsonBody(request);
  if (request.method === 'POST' && path === 'pulls') {
    const parsed = pullRequestCreateSchema.safeParse(body);
    if (!parsed.success) return deny('invalid_upstream_request');
    return allow();
  }
  if (request.method === 'POST' && path === 'issues')
    return issueCreateSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  if (request.method === 'PATCH' && /^issues\/[1-9]\d*$/.test(path))
    return issueUpdateSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  const pull = /^pulls\/([1-9]\d*)$/.exec(path);
  if (request.method === 'PATCH' && pull) {
    return pullRequestUpdateSchema.safeParse(body).success
      ? allow()
      : deny('invalid_upstream_request');
  }
  const comments = /^issues\/([1-9]\d*)\/comments$/.exec(path);
  if (request.method === 'POST' && comments) {
    return commentSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  }
  const review = /^pulls\/([1-9]\d*)\/reviews$/.exec(path);
  if (request.method === 'POST' && review) {
    return pullReviewSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  }
  const reviewComment = /^pulls\/([1-9]\d*)\/comments$/.exec(path);
  if (request.method === 'POST' && reviewComment) {
    return reviewCommentSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  }
  const reply = /^pulls\/([1-9]\d*)\/comments\/[1-9]\d*\/replies$/.exec(path);
  if (request.method === 'POST' && reply) {
    return commentSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  }
  const comment = /^issues\/comments\/([1-9]\d*)$/.exec(path);
  if (request.method === 'PATCH' && comment) {
    return commentSchema.safeParse(body).success ? allow() : deny('invalid_upstream_request');
  }
  return deny('operation_not_allowed');
}

export function authorizeGitHubTaskRequest(
  request: GitHubTaskRequest,
  grant: GitHubTaskGrant
): GitHubTaskDecision {
  const url = parseUrl(request.url);
  if (!url) return deny('invalid_upstream_url');
  if (url.port || !['github.com', 'api.github.com'].includes(url.hostname)) {
    return deny('upstream_host_not_allowed');
  }
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT'].includes(request.method))
    return deny('operation_not_allowed');
  if (['GET', 'HEAD'].includes(request.method) && request.body?.byteLength)
    return deny('invalid_upstream_request');
  if (url.hostname === 'github.com') return authorizeGit(request, url, grant);
  if (url.pathname === '/graphql') {
    if (request.method !== 'POST' || url.search) return deny('invalid_upstream_request');
    return authorizeGitHubTaskGraphql(jsonBody(request), grant);
  }
  return authorizeRest(request, url, grant);
}
