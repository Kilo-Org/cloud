import { Buffer } from 'node:buffer';
import { type ThinkWorkspaceCompatibility, type Workspace } from '@cloudflare/computer';
import { z } from 'zod';
import type { GithubClient } from './github';
import { isGitPath, REPO_ROOT } from './paths';
import type { StartReviewInput } from './types';

export const MAX_REPO_SIZE_KIB = 32 * 1024;
const DEFAULT_CLONE_URL_TEMPLATE = 'https://github.com/{owner}/{repo}.git';
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function resolveCloneUrl(owner: string, repo: string, template?: string): string {
  const resolved = template?.trim() || DEFAULT_CLONE_URL_TEMPLATE;
  return resolved.replaceAll('{owner}', owner).replaceAll('{repo}', repo);
}

export function validateHeadSha(sha: string): void {
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new Error('headSha must be a full git commit SHA');
  }
}

export class RepoTooLargeError extends Error {
  readonly sizeKiB: number;

  constructor(sizeKiB: number) {
    super(`Repository is ${sizeKiB} KiB, over the ${MAX_REPO_SIZE_KIB} KiB cap`);
    this.name = 'RepoTooLargeError';
    this.sizeKiB = sizeKiB;
  }
}

export function validateRepositoryName(owner: string, repo: string): void {
  if (!GITHUB_NAME_PATTERN.test(owner) || !GITHUB_NAME_PATTERN.test(repo)) {
    throw new Error('owner and repo must be valid GitHub path components');
  }
}

export async function admitRepository(
  github: GithubClient,
  owner: string,
  repo: string,
  signal?: AbortSignal
): Promise<{ sizeKiB: number }> {
  validateRepositoryName(owner, repo);
  signal?.throwIfAborted();
  const raw = await github.get<unknown>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    undefined,
    signal
  );
  signal?.throwIfAborted();
  const meta = z.object({ size: z.number().int().nonnegative().safe() }).safeParse(raw);
  if (!meta.success) {
    throw new Error('GitHub repository metadata did not contain a valid size');
  }
  if (meta.data.size > MAX_REPO_SIZE_KIB) throw new RepoTooLargeError(meta.data.size);
  return { sizeKiB: meta.data.size };
}

export type ReviewSnapshot = {
  headSha: string;
  baseTipSha: string;
  mergeBaseSha: string;
};

const shaSchema = z
  .string()
  .regex(GIT_SHA_PATTERN)
  .transform(sha => sha.toLowerCase());
const snapshotPullSchema = z.object({
  head: z.object({ sha: shaSchema }),
  base: z.object({ sha: shaSchema }),
});

export async function resolveReviewSnapshot(
  github: GithubClient,
  input: StartReviewInput,
  signal?: AbortSignal
): Promise<ReviewSnapshot> {
  validateRepositoryName(input.owner, input.repo);
  for (const sha of [input.headSha, input.baseTipSha, input.mergeBaseSha]) {
    if (sha !== undefined) validateHeadSha(sha);
  }
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) {
    throw new Error('pullNumber must be a positive integer');
  }
  const repoPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const pullPath = `${repoPath}/pulls/${input.pullNumber}`;
  async function readPull() {
    signal?.throwIfAborted();
    const raw = await github.get<unknown>(pullPath, undefined, signal);
    signal?.throwIfAborted();
    const parsed = snapshotPullSchema.safeParse(raw);
    if (!parsed.success) throw new Error('GitHub pull request is missing valid head/base SHAs');
    return parsed.data;
  }

  const pull = await readPull();
  const headSha = pull.head.sha;
  const baseTipSha = pull.base.sha;
  if (input.headSha !== undefined && input.headSha.toLowerCase() !== headSha) {
    throw new Error('Supplied headSha does not match the current pull request head');
  }
  if (input.baseTipSha !== undefined && input.baseTipSha.toLowerCase() !== baseTipSha) {
    throw new Error('Supplied baseTipSha does not match the current pull request base');
  }
  const rawCompare = await github.get<unknown>(
    `${repoPath}/compare/${baseTipSha}...${headSha}?per_page=1`,
    undefined,
    signal
  );
  signal?.throwIfAborted();
  const compare = z
    .object({
      base_commit: z.object({ sha: shaSchema }),
      merge_base_commit: z.object({ sha: shaSchema }),
    })
    .safeParse(rawCompare);
  if (!compare.success || compare.data.base_commit.sha !== baseTipSha) {
    throw new Error('GitHub comparison is missing or mismatches the captured base SHA');
  }
  const mergeBaseSha = compare.data.merge_base_commit.sha;
  if (input.mergeBaseSha !== undefined && input.mergeBaseSha.toLowerCase() !== mergeBaseSha) {
    throw new Error('Supplied mergeBaseSha does not match the exact GitHub comparison');
  }
  const current = await readPull();
  if (current.head.sha !== headSha || current.base.sha !== baseTipSha) {
    throw new Error('Pull request head or base changed while capturing the review snapshot');
  }
  return { headSha, baseTipSha, mergeBaseSha };
}

export async function resolveHeadSha(
  github: GithubClient,
  input: StartReviewInput,
  signal?: AbortSignal
): Promise<string> {
  validateRepositoryName(input.owner, input.repo);
  if (input.headSha) validateHeadSha(input.headSha);
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) {
    throw new Error('pullNumber must be a positive integer');
  }
  signal?.throwIfAborted();
  const raw = await github.get<unknown>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}`,
    undefined,
    signal
  );
  signal?.throwIfAborted();
  const pull = z.object({ head: z.object({ sha: shaSchema }) }).safeParse(raw);
  if (!pull.success) throw new Error('GitHub pull request did not contain a valid head SHA');
  if (input.headSha && input.headSha.toLowerCase() !== pull.data.head.sha) {
    throw new Error('Supplied headSha does not match the current pull request head');
  }
  return pull.data.head.sha;
}

export type ReviewWorkspace = Workspace & ThinkWorkspaceCompatibility;

type WorkspaceFileInfo = Pick<
  Awaited<ReturnType<ThinkWorkspaceCompatibility['glob']>>[number],
  'path' | 'type' | 'size'
>;

export interface CloneStats {
  tipFileCount: number;
  tipTotalBytes: number;
  vfsTotalBytes: number;
  vfsFileCount: number;
  cloneMs: number;
  lastPhase?: string;
}

function fileEntries(entries: WorkspaceFileInfo[]): WorkspaceFileInfo[] {
  return entries.filter(entry => entry.type === 'file');
}

async function fileByteTotals(
  workspace: ReviewWorkspace,
  entries: WorkspaceFileInfo[]
): Promise<{ tipTotalBytes: number; vfsTotalBytes: number }> {
  const sizes = await Promise.all(
    entries.map(async entry => {
      const info = await workspace.stat(entry.path);
      return { path: entry.path, size: info?.size ?? 0 };
    })
  );
  let tipTotalBytes = 0;
  let vfsTotalBytes = 0;
  for (const { path, size } of sizes) {
    vfsTotalBytes += size;
    if (!isGitPath(path)) tipTotalBytes += size;
  }
  return { tipTotalBytes, vfsTotalBytes };
}

export async function cloneRepository(
  workspace: ReviewWorkspace,
  input: StartReviewInput,
  headSha: string,
  options?: { cloneUrlTemplate?: string; token?: string; signal?: AbortSignal }
): Promise<CloneStats> {
  validateRepositoryName(input.owner, input.repo);
  validateHeadSha(headSha);
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) {
    throw new Error('pullNumber must be a positive integer');
  }
  const token = options?.token ?? input.gitToken;
  if (!token) throw new Error('GitHub token is required for clone');
  const signal = options?.signal;
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  let lastPhase: string | undefined;
  const startedAt = Date.now();
  for (const ref of [headSha, `refs/pull/${input.pullNumber}/head`]) {
    signal?.throwIfAborted();
    await workspace.rm(REPO_ROOT, { recursive: true, force: true });
    signal?.throwIfAborted();
    await workspace.mkdir(REPO_ROOT, { recursive: true });
    signal?.throwIfAborted();
    try {
      await workspace.git.clone({
        url: resolveCloneUrl(input.owner, input.repo, options?.cloneUrlTemplate),
        dir: REPO_ROOT,
        ref,
        depth: 1,
        singleBranch: true,
        noTags: true,
        headers: { Authorization: `Basic ${credentials}` },
        onProgress: event => {
          lastPhase = event.phase;
        },
      });
      signal?.throwIfAborted();
      const checkedOutSha = await workspace.git.revParse({ dir: REPO_ROOT, ref: 'HEAD' });
      signal?.throwIfAborted();
      if (checkedOutSha.toLowerCase() !== headSha.toLowerCase()) {
        throw new Error('Repository checkout does not match the captured pull request head');
      }
      break;
    } catch {
      signal?.throwIfAborted();
      if (ref !== headSha) {
        throw new Error(
          'Unable to acquire and verify the captured head via SHA or synthetic PR ref'
        );
      }
    }
  }

  const allEntries = fileEntries(await workspace.glob('**/*'));
  signal?.throwIfAborted();
  const treeEntries = allEntries.filter(entry => !isGitPath(entry.path));
  const { tipTotalBytes, vfsTotalBytes } = await fileByteTotals(workspace, allEntries);
  signal?.throwIfAborted();
  return {
    tipFileCount: treeEntries.length,
    tipTotalBytes,
    vfsFileCount: allEntries.length,
    vfsTotalBytes,
    cloneMs: Date.now() - startedAt,
    lastPhase,
  };
}
