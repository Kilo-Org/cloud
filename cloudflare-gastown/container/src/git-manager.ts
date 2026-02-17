import { mkdir } from 'node:fs/promises';
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
  return Bun.file(p).exists();
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
 */
export async function cloneRepo(options: CloneOptions): Promise<string> {
  validateGitUrl(options.gitUrl);
  validateBranchName(options.defaultBranch, 'defaultBranch');
  const dir = repoDir(options.rigId);

  if (await pathExists(join(dir, '.git'))) {
    await exec('git', ['fetch', '--all', '--prune'], dir);
    console.log(`Fetched latest for rig ${options.rigId}`);
    return dir;
  }

  await mkdir(dir, { recursive: true });
  await exec('git', [
    'clone',
    '--no-checkout',
    '--branch',
    options.defaultBranch,
    options.gitUrl,
    dir,
  ]);
  console.log(`Cloned ${options.gitUrl} for rig ${options.rigId}`);
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
