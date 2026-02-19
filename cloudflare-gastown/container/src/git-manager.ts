import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CloneOptions, WorktreeOptions } from './types';

const WORKSPACE_ROOT = '/workspace/rigs';

/**
 * Reject path segments that could escape the workspace via traversal.
 * Allows alphanumeric, hyphens, underscores, dots, and forward slashes
 * (for branch names like `polecat/name/bead-id`), but blocks `..` segments.
 */
function validatePathSegment(value: string, label: string): void {
  if (!value || /\.\.[/\\]|[/\\]\.\.|^\.\.$/.test(value)) {
    throw new Error(`${label} contains path traversal`);
  }
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(`${label} contains control characters`);
  }
}

/**
 * Validate a git URL — only allow https:// and git@ protocols.
 * Blocks local paths and exotic transports.
 */
function validateGitUrl(url: string): void {
  if (!url) throw new Error('gitUrl is required');
  if (!/^(https?:\/\/|git@)/.test(url)) {
    throw new Error(`gitUrl must use https:// or git@ protocol, got: ${url.slice(0, 50)}`);
  }
}

/**
 * Inject authentication token into a git URL.
 * Supports GitHub (x-access-token) and GitLab (oauth2) token formats.
 * If no token is available, returns the original URL unchanged.
 */
function authenticateGitUrl(gitUrl: string, envVars?: Record<string, string>): string {
  if (!envVars) return gitUrl;

  const token = envVars.GIT_TOKEN ?? envVars.GITHUB_TOKEN;
  const gitlabToken = envVars.GITLAB_TOKEN;

  if (!token && !gitlabToken) return gitUrl;

  try {
    const url = new URL(gitUrl);

    if (gitlabToken && (url.hostname.includes('gitlab') || envVars.GITLAB_INSTANCE_URL)) {
      url.username = 'oauth2';
      url.password = gitlabToken;
      return url.toString();
    }

    if (token) {
      url.username = 'x-access-token';
      url.password = token;
      return url.toString();
    }
  } catch {
    // git@ URLs or other formats — return as-is
  }

  return gitUrl;
}

/**
 * Validate a branch name — block control characters and shell metacharacters.
 */
function validateBranchName(branch: string, label: string): void {
  if (!branch) throw new Error(`${label} is required`);
  if (/[\x00-\x1f\x7f ~^:?*\[\\]/.test(branch)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (branch.startsWith('-')) {
    throw new Error(`${label} cannot start with a hyphen`);
  }
}

/**
 * Verify a resolved path is inside the workspace root.
 * Protects against symlink-based escapes.
 */
function assertInsideWorkspace(resolvedPath: string): void {
  if (!resolvedPath.startsWith(WORKSPACE_ROOT + '/') && resolvedPath !== WORKSPACE_ROOT) {
    throw new Error(`Path ${resolvedPath} escapes workspace root`);
  }
}

async function exec(cmd: string, args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${stderr || `exit code ${exitCode}`}`);
  }

  return stdout.trim();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function repoDir(rigId: string): string {
  validatePathSegment(rigId, 'rigId');
  const dir = resolve(WORKSPACE_ROOT, rigId, 'repo');
  assertInsideWorkspace(dir);
  return dir;
}

function worktreeDir(rigId: string, branch: string): string {
  validatePathSegment(rigId, 'rigId');
  validatePathSegment(branch, 'branch');
  const safeBranch = branch.replace(/\//g, '__');
  const dir = resolve(WORKSPACE_ROOT, rigId, 'worktrees', safeBranch);
  assertInsideWorkspace(dir);
  return dir;
}

/**
 * Clone a git repo for the given rig (shared across all agents in the rig).
 * If the repo is already cloned, fetches latest instead.
 * When envVars contains GIT_TOKEN/GITLAB_TOKEN, constructs authenticated URLs.
 */
export async function cloneRepo(
  options: CloneOptions & { envVars?: Record<string, string> }
): Promise<string> {
  validateGitUrl(options.gitUrl);
  validateBranchName(options.defaultBranch, 'defaultBranch');
  const dir = repoDir(options.rigId);
  const authUrl = authenticateGitUrl(options.gitUrl, options.envVars);

  if (await pathExists(join(dir, '.git'))) {
    // Update the remote URL in case the token changed
    await exec('git', ['remote', 'set-url', 'origin', authUrl], dir).catch(() => {});
    await exec('git', ['fetch', '--all', '--prune'], dir);
    console.log(`Fetched latest for rig ${options.rigId}`);
    return dir;
  }

  // Clean up partial clones (directory exists but no .git) from prior crashes
  if (await pathExists(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  await mkdir(dir, { recursive: true });
  await exec('git', ['clone', '--no-checkout', '--branch', options.defaultBranch, authUrl, dir]);
  console.log(`Cloned repo for rig ${options.rigId}`);
  return dir;
}

/**
 * Create an isolated git worktree for an agent's branch.
 * If the worktree already exists, resets it to track the branch.
 */
export async function createWorktree(options: WorktreeOptions): Promise<string> {
  const repo = repoDir(options.rigId);
  const dir = worktreeDir(options.rigId, options.branch);

  if (await pathExists(dir)) {
    await exec('git', ['checkout', options.branch], dir);
    await exec('git', ['pull', '--rebase', '--autostash'], dir).catch(() => {
      // Pull may fail if remote branch doesn't exist yet; that's fine
    });
    console.log(`Reused existing worktree at ${dir}`);
    return dir;
  }

  try {
    await exec('git', ['branch', '--track', options.branch, `origin/${options.branch}`], repo);
  } catch {
    await exec('git', ['branch', options.branch], repo);
  }

  await exec('git', ['worktree', 'add', dir, options.branch], repo);
  console.log(`Created worktree for branch ${options.branch} at ${dir}`);
  return dir;
}

/**
 * Remove a git worktree.
 */
export async function removeWorktree(rigId: string, branch: string): Promise<void> {
  const repo = repoDir(rigId);
  const dir = worktreeDir(rigId, branch);

  if (!(await pathExists(dir))) return;

  await exec('git', ['worktree', 'remove', '--force', dir], repo);
  console.log(`Removed worktree at ${dir}`);
}

/**
 * List all active worktrees for a rig.
 */
export async function listWorktrees(rigId: string): Promise<string[]> {
  const repo = repoDir(rigId);
  if (!(await pathExists(repo))) return [];

  const output = await exec('git', ['worktree', 'list', '--porcelain'], repo);
  return output
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''));
}

export type MergeOutcome = {
  status: 'merged' | 'conflict';
  message: string;
  commitSha?: string;
};

/**
 * Deterministic merge of a feature branch into the target branch.
 * Uses a temporary worktree so the bare repo and agent worktrees are unaffected.
 *
 * 1. Ensure the repo is cloned/fetched
 * 2. Create a temporary worktree on the target branch
 * 3. git merge --no-ff <branch>
 * 4. If success: push, clean up, return 'merged'
 * 5. If conflict: abort, clean up, return 'conflict'
 */
export async function mergeBranch(options: {
  rigId: string;
  branch: string;
  targetBranch: string;
  gitUrl: string;
  envVars?: Record<string, string>;
}): Promise<MergeOutcome> {
  validatePathSegment(options.rigId, 'rigId');
  validateBranchName(options.branch, 'branch');
  validateBranchName(options.targetBranch, 'targetBranch');
  validateGitUrl(options.gitUrl);

  const repo = repoDir(options.rigId);
  const authUrl = authenticateGitUrl(options.gitUrl, options.envVars);

  // Ensure repo exists and is up to date
  if (!(await pathExists(join(repo, '.git')))) {
    await cloneRepo({
      rigId: options.rigId,
      gitUrl: options.gitUrl,
      defaultBranch: options.targetBranch,
      envVars: options.envVars,
    });
  } else {
    // Update remote URL for fresh token
    await exec('git', ['remote', 'set-url', 'origin', authUrl], repo).catch(() => {});
    await exec('git', ['fetch', '--all', '--prune'], repo);
  }

  // Create a temporary worktree for the merge on the target branch
  const mergeDir = resolve(WORKSPACE_ROOT, options.rigId, 'merge-tmp', `merge-${Date.now()}`);
  assertInsideWorkspace(mergeDir);
  // Only create the parent — git worktree add creates the leaf directory itself
  await mkdir(resolve(WORKSPACE_ROOT, options.rigId, 'merge-tmp'), { recursive: true });

  try {
    // Add worktree tracking the target branch
    await exec('git', ['worktree', 'add', mergeDir, options.targetBranch], repo);

    // Pull latest on the target branch
    await exec('git', ['pull', '--ff-only'], mergeDir).catch(() => {
      // Pull may fail if target has no upstream; that's fine for local-only branches
    });

    // Attempt the merge
    try {
      await exec(
        'git',
        [
          'merge',
          '--no-ff',
          '-m',
          `Merge ${options.branch} into ${options.targetBranch}`,
          `origin/${options.branch}`,
        ],
        mergeDir
      );
    } catch (mergeErr) {
      // Merge failed — likely a conflict
      const message = mergeErr instanceof Error ? mergeErr.message : 'Unknown merge error';

      // Abort the merge so the worktree is clean for removal
      await exec('git', ['merge', '--abort'], mergeDir).catch(() => {});
      return { status: 'conflict', message };
    }

    // Get the commit SHA of the merge commit
    const commitSha = await exec('git', ['rev-parse', 'HEAD'], mergeDir);

    // Push the merged target branch
    await exec('git', ['push', 'origin', options.targetBranch], mergeDir);

    return { status: 'merged', message: 'Merge successful', commitSha };
  } finally {
    // Always clean up the temporary worktree
    await exec('git', ['worktree', 'remove', '--force', mergeDir], repo).catch(err => {
      console.warn(`Failed to remove merge worktree at ${mergeDir}:`, err);
    });
    await rm(mergeDir, { recursive: true, force: true }).catch(() => {});
  }
}
