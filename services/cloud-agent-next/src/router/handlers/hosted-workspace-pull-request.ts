import type {
  CloudAgentWorkspaceSummary,
  CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { github_branch_pull_requests } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getPgDb } from '../../db/pg.js';
import { resolveCloudAgentGitHubAuthForRepo } from '../../services/git-token-service-client.js';
import {
  getHostedWorkspacePullRequestFileInput,
  getHostedWorkspacePullRequestFileOutput,
  getHostedWorkspacePullRequestInput,
  getHostedWorkspacePullRequestOutput,
  type GetHostedWorkspacePullRequestOutput,
  type HostedWorkspacePullRequestReason,
} from '../../shared/hosted-workspace-changes.js';
import type { TRPCContext } from '../../types.js';
import { protectedProcedure } from '../auth.js';
import { getAuthorizedHostedWorkspace } from './hosted-workspace-access.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const FILES_PAGE_SIZE = 50;
const FILES_MAX_PAGES = 60;
const MAX_PR_FILES = FILES_PAGE_SIZE * FILES_MAX_PAGES;
const FILE_INDEX_TTL_MS = 2 * 60_000;
const FILE_INDEX_MAX_ENTRIES = 4;

type GitHubFailure = 'access_denied' | 'rate_limited' | 'not_found' | 'unavailable';

class GitHubRequestError extends Error {
  constructor(readonly failure: GitHubFailure) {
    super(`GitHub request failed (${failure})`);
    this.name = 'GitHubRequestError';
  }
}

const pullRequestFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});

const livePullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.string(),
  draft: z.boolean().optional(),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/i),
    repo: z.object({ full_name: z.string() }).nullish(),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullish(),
  }),
});

type PullRequestFile = z.infer<typeof pullRequestFileSchema>;
type PullRequestFileSummary = Omit<PullRequestFile, 'patch'> & { patchAvailable: boolean };
type LivePullRequest = z.infer<typeof livePullRequestSchema>;

type PullRequestFileIndex = {
  pathToPage: Map<string, number>;
  summaries: PullRequestFileSummary[];
  truncated: boolean;
  expiresAt: number;
};

const fileIndexCache = new Map<string, PullRequestFileIndex>();

function fileIndexKey(target: PullRequestTarget, headSha: string): string {
  return `${target.repoFullName.toLowerCase()}#${target.number}@${headSha.toLowerCase()}`;
}

function readFileIndex(key: string): PullRequestFileIndex | null {
  const cached = fileIndexCache.get(key);
  if (cached === undefined) return null;
  if (cached.expiresAt <= Date.now()) {
    fileIndexCache.delete(key);
    return null;
  }
  return cached;
}

function writeFileIndex(key: string, index: Omit<PullRequestFileIndex, 'expiresAt'>): void {
  const now = Date.now();
  for (const [cachedKey, cached] of fileIndexCache) {
    if (cached.expiresAt <= now) fileIndexCache.delete(cachedKey);
  }
  while (fileIndexCache.size >= FILE_INDEX_MAX_ENTRIES) {
    const oldest = fileIndexCache.keys().next();
    if (oldest.done) break;
    fileIndexCache.delete(oldest.value);
  }
  fileIndexCache.set(key, { ...index, expiresAt: now + FILE_INDEX_TTL_MS });
}

export function resetHostedWorkspacePullRequestCachesForTest(): void {
  fileIndexCache.clear();
}

type PullRequestTarget = {
  owner: string;
  repo: string;
  repoFullName: string;
  number: number;
  token: string;
};

type LinkedPullRequest = {
  target: PullRequestTarget;
  branch: string;
  output: NonNullable<GetHostedWorkspacePullRequestOutput['pullRequest']>;
};

type PullRequestResolution =
  | { kind: 'linked'; linked: LinkedPullRequest }
  | { kind: 'not_github' }
  | { kind: 'not_linked' }
  | { kind: 'unverified'; reason: HostedWorkspacePullRequestReason }
  | { kind: 'credential_required'; reason: HostedWorkspacePullRequestReason }
  | { kind: 'unavailable'; reason: HostedWorkspacePullRequestReason };

type VerifiedPullRequestResolution =
  | { kind: 'verified'; pullRequest: LivePullRequest }
  | { kind: 'unverified'; reason: HostedWorkspacePullRequestReason }
  | { kind: 'unavailable'; reason: HostedWorkspacePullRequestReason };

type PullRequestRevalidation =
  | { kind: 'same' }
  | { kind: 'moved'; headSha: string }
  | Exclude<VerifiedPullRequestResolution, { kind: 'verified' }>;

function parseGitHubRepository(
  gitUrl: string
): { owner: string; repo: string; repoFullName: string } | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(normalizeGitUrl(gitUrl));
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo, repoFullName: `${owner}/${repo}` };
}

async function githubRequest(
  token: string,
  path: string
): Promise<{ data: unknown; link: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kilo-cloud-agent',
      },
    });
  } catch {
    throw new GitHubRequestError('unavailable');
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    if (
      response.status === 429 ||
      response.headers.get('retry-after') !== null ||
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new GitHubRequestError('rate_limited');
    }
    throw new GitHubRequestError('access_denied');
  }
  if (response.status === 404) throw new GitHubRequestError('not_found');
  if (!response.ok) throw new GitHubRequestError('unavailable');
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new GitHubRequestError('unavailable');
  }
  return { data, link: response.headers.get('link') };
}

async function readFilePage(
  target: PullRequestTarget,
  page: number
): Promise<{ files: PullRequestFile[]; hasNext: boolean }> {
  const { data, link } = await githubRequest(
    target.token,
    `/repos/${target.owner}/${target.repo}/pulls/${target.number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`
  );
  const parsed = z.array(pullRequestFileSchema).safeParse(data);
  if (!parsed.success) throw new GitHubRequestError('unavailable');
  return {
    files: parsed.data,
    hasNext: link === null ? parsed.data.length === FILES_PAGE_SIZE : /rel="next"/.test(link),
  };
}

async function buildFileIndex(
  target: PullRequestTarget,
  wantedPath?: string
): Promise<{ index: Omit<PullRequestFileIndex, 'expiresAt'>; match: PullRequestFile | null }> {
  const pathToPage = new Map<string, number>();
  const summaries: PullRequestFileSummary[] = [];
  let match: PullRequestFile | null = null;
  for (let page = 1; page <= FILES_MAX_PAGES; page += 1) {
    const pageResult = await readFilePage(target, page);
    for (const file of pageResult.files) {
      if (summaries.length >= MAX_PR_FILES) {
        return { index: { pathToPage, summaries, truncated: true }, match };
      }
      pathToPage.set(file.filename, page);
      const { patch, ...summary } = file;
      summaries.push({ ...summary, patchAvailable: patch !== undefined && patch.length > 0 });
      if (file.filename === wantedPath) match = file;
    }
    if (!pageResult.hasNext) return { index: { pathToPage, summaries, truncated: false }, match };
    if (page === FILES_MAX_PAGES) {
      return { index: { pathToPage, summaries, truncated: true }, match };
    }
  }
  return { index: { pathToPage, summaries, truncated: false }, match };
}

async function listPullRequestFiles(
  target: PullRequestTarget,
  headSha: string
): Promise<{ files: PullRequestFileSummary[]; truncated: boolean }> {
  const key = fileIndexKey(target, headSha);
  const cached = readFileIndex(key);
  if (cached !== null) return { files: cached.summaries, truncated: cached.truncated };
  const { index } = await buildFileIndex(target);
  writeFileIndex(key, index);
  return { files: index.summaries, truncated: index.truncated };
}

async function findPullRequestFile(
  target: PullRequestTarget,
  headSha: string,
  path: string
): Promise<PullRequestFile | null> {
  const key = fileIndexKey(target, headSha);
  const cached = readFileIndex(key);
  if (cached !== null) {
    const page = cached.pathToPage.get(path);
    if (page === undefined) return null;
    const pageResult = await readFilePage(target, page);
    return pageResult.files.find(file => file.filename === path) ?? null;
  }
  const { index, match } = await buildFileIndex(target, path);
  writeFileIndex(key, index);
  return match;
}

function reasonForGitHubFailure(
  failure: GitHubFailure,
  stage: 'pull_request' | 'files'
): HostedWorkspacePullRequestReason {
  switch (failure) {
    case 'rate_limited':
      return 'github_rate_limited';
    case 'access_denied':
      return 'github_access_denied';
    case 'not_found':
      return stage === 'pull_request' ? 'pull_request_not_found' : 'github_access_denied';
    case 'unavailable':
      return 'github_unavailable';
  }
}

async function fetchVerifiedPullRequest(
  target: PullRequestTarget,
  branch: string
): Promise<VerifiedPullRequestResolution> {
  let data: unknown;
  try {
    ({ data } = await githubRequest(
      target.token,
      `/repos/${target.owner}/${target.repo}/pulls/${target.number}`
    ));
  } catch (error) {
    if (!(error instanceof GitHubRequestError)) throw error;
    const reason = reasonForGitHubFailure(error.failure, 'pull_request');
    return error.failure === 'not_found'
      ? { kind: 'unverified', reason }
      : { kind: 'unavailable', reason };
  }
  const parsed = livePullRequestSchema.safeParse(data);
  if (!parsed.success) return { kind: 'unavailable', reason: 'github_unavailable' };
  const pullRequest = parsed.data;
  if (
    pullRequest.base.repo?.full_name.toLowerCase() !== target.repoFullName.toLowerCase() ||
    pullRequest.head.repo?.full_name.toLowerCase() !== target.repoFullName.toLowerCase()
  ) {
    return { kind: 'unverified', reason: 'repository_mismatch' };
  }
  if (pullRequest.head.ref !== branch) {
    return { kind: 'unverified', reason: 'head_ref_mismatch' };
  }
  return { kind: 'verified', pullRequest };
}

async function revalidateLinkedPullRequest(
  linked: LinkedPullRequest
): Promise<PullRequestRevalidation> {
  const resolution = await fetchVerifiedPullRequest(linked.target, linked.branch);
  if (resolution.kind !== 'verified') return resolution;
  return resolution.pullRequest.head.sha.toLowerCase() === linked.output.headSha.toLowerCase()
    ? { kind: 'same' }
    : { kind: 'moved', headSha: resolution.pullRequest.head.sha };
}

function isWorkspacePullRequestRow(
  row: { pr_number: number | null; pr_url: string | null } | undefined
): row is { pr_number: number; pr_url: string | null } {
  return row !== undefined && row.pr_number !== null;
}

async function findCachedWorkspacePullRequest(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary
) {
  if (workspace.repositoryProvider !== 'github' || !workspace.gitUrl || !workspace.gitBranch) {
    return null;
  }
  const gitUrl = normalizeGitUrl(workspace.gitUrl);
  const tenant =
    workspace.organizationId === null
      ? and(
          isNull(github_branch_pull_requests.owned_by_organization_id),
          eq(github_branch_pull_requests.owned_by_user_id, workspace.userId)
        )
      : and(
          eq(github_branch_pull_requests.owned_by_organization_id, workspace.organizationId),
          isNull(github_branch_pull_requests.owned_by_user_id)
        );
  const [row] = await getPgDb(ctx.env)
    .select({
      pr_number: github_branch_pull_requests.pr_number,
      pr_url: github_branch_pull_requests.pr_url,
      pr_head_sha: github_branch_pull_requests.pr_head_sha,
    })
    .from(github_branch_pull_requests)
    .where(
      and(
        eq(github_branch_pull_requests.git_url, gitUrl),
        eq(github_branch_pull_requests.git_branch, workspace.gitBranch),
        tenant,
        isNotNull(github_branch_pull_requests.pr_number),
        isNotNull(github_branch_pull_requests.pr_last_synced_at)
      )
    )
    .orderBy(
      sql`${github_branch_pull_requests.pr_state} IN ('open', 'draft') DESC`,
      desc(github_branch_pull_requests.pr_number)
    )
    .limit(1);
  return isWorkspacePullRequestRow(row) ? row : null;
}

async function resolveInstallationCredential(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary,
  repoFullName: string
): Promise<
  | { kind: 'installation'; token: string }
  | { kind: 'credential_required' }
  | { kind: 'unavailable'; reason: HostedWorkspacePullRequestReason }
> {
  const params = {
    githubRepo: repoFullName,
    userId: workspace.userId,
    ...(workspace.organizationId === null ? {} : { orgId: workspace.organizationId }),
  };
  const installation = await resolveCloudAgentGitHubAuthForRepo(ctx.env, {
    ...params,
    allowUserAuthorization: false,
  });
  if (installation.success) {
    return installation.value.source === 'installation'
      ? { kind: 'installation', token: installation.value.githubToken }
      : { kind: 'unavailable', reason: 'installation_unavailable' };
  }
  const userCapable = await resolveCloudAgentGitHubAuthForRepo(ctx.env, {
    ...params,
    allowUserAuthorization: true,
  });
  if (userCapable.success && userCapable.value.source === 'user') {
    return { kind: 'credential_required' };
  }
  return { kind: 'unavailable', reason: 'installation_unavailable' };
}

async function resolveLinkedPullRequest(
  ctx: Pick<TRPCContext, 'env'>,
  workspace: CloudAgentWorkspaceSummary
): Promise<PullRequestResolution> {
  if (workspace.repositoryProvider !== 'github') return { kind: 'not_github' };
  if (!workspace.gitUrl || !workspace.gitBranch) return { kind: 'not_linked' };
  const repository = parseGitHubRepository(workspace.gitUrl);
  if (repository === null) return { kind: 'not_github' };
  const cached = await findCachedWorkspacePullRequest(ctx, workspace);
  if (cached === null) return { kind: 'not_linked' };

  const credential = await resolveInstallationCredential(ctx, workspace, repository.repoFullName);
  if (credential.kind === 'credential_required') {
    return { kind: 'credential_required', reason: 'connected_user_required' };
  }
  if (credential.kind === 'unavailable') return credential;

  const target: PullRequestTarget = {
    ...repository,
    number: cached.pr_number,
    token: credential.token,
  };
  const verified = await fetchVerifiedPullRequest(target, workspace.gitBranch);
  if (verified.kind !== 'verified') return verified;
  const pullRequest = verified.pullRequest;
  return {
    kind: 'linked',
    linked: {
      target,
      branch: workspace.gitBranch,
      output: {
        number: pullRequest.number,
        url: pullRequest.html_url,
        state: pullRequest.state === 'closed' ? 'closed' : 'open',
        draft: pullRequest.draft === true,
        headSha: pullRequest.head.sha,
        baseRef: pullRequest.base.ref,
        repository: {
          path: '',
          repoFullName: pullRequest.base.repo?.full_name ?? repository.repoFullName,
        },
        cacheStale:
          cached.pr_head_sha !== null &&
          cached.pr_head_sha.toLowerCase() !== pullRequest.head.sha.toLowerCase(),
      },
    },
  };
}

type PullRequestFailureStatus =
  | 'not_github'
  | 'not_linked'
  | 'unverified'
  | 'credential_required'
  | 'unavailable';

type PullRequestFailureOutput = Omit<GetHostedWorkspacePullRequestOutput, 'status'> & {
  status: PullRequestFailureStatus;
};

function failureOutput(
  workspaceId: CloudAgentWorktreeId,
  resolution: Exclude<PullRequestResolution, { kind: 'linked' }>
): PullRequestFailureOutput {
  switch (resolution.kind) {
    case 'not_github':
      return {
        status: 'not_github',
        workspaceId,
        reason: 'unsupported_repository',
        pullRequest: null,
        truncated: false,
        files: [],
      };
    case 'not_linked':
      return {
        status: 'not_linked',
        workspaceId,
        reason: 'no_pull_request',
        pullRequest: null,
        truncated: false,
        files: [],
      };
    case 'unverified':
    case 'credential_required':
    case 'unavailable':
      return {
        status: resolution.kind,
        workspaceId,
        reason: resolution.reason,
        pullRequest: null,
        truncated: false,
        files: [],
      };
  }
}

function linkedOutput(
  workspaceId: CloudAgentWorktreeId,
  linked: LinkedPullRequest,
  files: { files: PullRequestFileSummary[]; truncated: boolean }
): GetHostedWorkspacePullRequestOutput {
  return {
    status: 'linked',
    workspaceId,
    reason: null,
    pullRequest: linked.output,
    truncated: files.truncated,
    files: files.files.map(file => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailable: file.patchAvailable,
    })),
  };
}

async function readLinkedPullRequestFiles(
  linked: LinkedPullRequest
): Promise<{ files: PullRequestFileSummary[]; truncated: boolean }> {
  return await listPullRequestFiles(linked.target, linked.output.headSha);
}

function fileFailureOutput(
  path: string,
  failure: PullRequestFailureOutput
): z.infer<typeof getHostedWorkspacePullRequestFileOutput> {
  return {
    status: failure.status,
    path,
    reason: failure.reason,
    omissionReason: null,
    headSha: null,
    patch: null,
  };
}

export const getHostedWorkspacePullRequest = protectedProcedure
  .input(getHostedWorkspacePullRequestInput)
  .output(getHostedWorkspacePullRequestOutput)
  .query(async ({ input, ctx }) => {
    const workspace = await getAuthorizedHostedWorkspace(ctx, input);
    const resolution = await resolveLinkedPullRequest(ctx, workspace);
    if (resolution.kind !== 'linked') {
      return failureOutput(workspace.workspaceId, resolution);
    }
    try {
      const files = await readLinkedPullRequestFiles(resolution.linked);
      const revalidated = await revalidateLinkedPullRequest(resolution.linked);
      if (revalidated.kind === 'moved') {
        return {
          status: 'stale' as const,
          workspaceId: workspace.workspaceId,
          reason: 'pull_request_changed' as const,
          pullRequest: null,
          truncated: false,
          files: [],
        };
      }
      if (revalidated.kind !== 'same') {
        return failureOutput(workspace.workspaceId, revalidated);
      }
      return linkedOutput(workspace.workspaceId, resolution.linked, files);
    } catch (error) {
      if (!(error instanceof GitHubRequestError)) throw error;
      return {
        status: 'unavailable',
        workspaceId: workspace.workspaceId,
        reason: reasonForGitHubFailure(error.failure, 'files'),
        pullRequest: null,
        truncated: false,
        files: [],
      };
    }
  });

export const getHostedWorkspacePullRequestFile = protectedProcedure
  .input(getHostedWorkspacePullRequestFileInput)
  .output(getHostedWorkspacePullRequestFileOutput)
  .query(async ({ input, ctx }) => {
    const workspace = await getAuthorizedHostedWorkspace(ctx, input);
    const resolution = await resolveLinkedPullRequest(ctx, workspace);
    if (resolution.kind !== 'linked') {
      return fileFailureOutput(input.path, failureOutput(workspace.workspaceId, resolution));
    }
    const headSha = resolution.linked.output.headSha;
    if (headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
      return {
        status: 'stale' as const,
        path: input.path,
        reason: null,
        omissionReason: null,
        headSha,
        patch: null,
      };
    }
    let file: PullRequestFile | null;
    try {
      file = await findPullRequestFile(resolution.linked.target, headSha, input.path);
    } catch (error) {
      if (!(error instanceof GitHubRequestError)) throw error;
      return {
        status: 'unavailable' as const,
        path: input.path,
        reason: reasonForGitHubFailure(error.failure, 'files'),
        omissionReason: null,
        headSha: null,
        patch: null,
      };
    }
    const revalidated = await revalidateLinkedPullRequest(resolution.linked);
    if (revalidated.kind === 'moved') {
      return {
        status: 'stale' as const,
        path: input.path,
        reason: null,
        omissionReason: null,
        headSha: revalidated.headSha,
        patch: null,
      };
    }
    if (revalidated.kind !== 'same') {
      return fileFailureOutput(input.path, failureOutput(workspace.workspaceId, revalidated));
    }
    if (file === null) {
      return {
        status: 'not_listed' as const,
        path: input.path,
        reason: null,
        omissionReason: null,
        headSha,
        patch: null,
      };
    }
    if (file.patch === undefined || file.patch.length === 0) {
      return {
        status: 'omitted' as const,
        path: input.path,
        reason: null,
        omissionReason: 'provider_omitted' as const,
        headSha,
        patch: null,
      };
    }
    return {
      status: 'available' as const,
      path: input.path,
      reason: null,
      omissionReason: null,
      headSha,
      patch: file.patch,
    };
  });
