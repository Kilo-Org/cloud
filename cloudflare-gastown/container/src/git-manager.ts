import { execFile } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloneOptions, WorktreeOptions } from './types.js';

const WORKSPACE_ROOT = '/workspace/rigs';

function exec(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function repoDir(rigId: string): string {
  return join(WORKSPACE_ROOT, rigId, 'repo');
}

function worktreeDir(rigId: string, branch: string): string {
  // Sanitize branch name for filesystem path
  const safeBranch = branch.replace(/\//g, '__');
  return join(WORKSPACE_ROOT, rigId, 'worktrees', safeBranch);
}

/**
 * Clone a git repo for the given rig (shared across all agents in the rig).
 * If the repo is already cloned, fetches latest instead.
 */
export async function cloneRepo(options: CloneOptions): Promise<string> {
  const dir = repoDir(options.rigId);

  if (await pathExists(join(dir, '.git'))) {
    // Already cloned — fetch latest
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
    // Worktree already exists — pull latest
    await exec('git', ['checkout', options.branch], dir);
    await exec('git', ['pull', '--rebase', '--autostash'], dir).catch(() => {
      // Pull may fail if remote branch doesn't exist yet; that's fine
    });
    console.log(`Reused existing worktree at ${dir}`);
    return dir;
  }

  // Create the branch locally if it doesn't exist
  try {
    await exec('git', ['branch', '--track', options.branch, `origin/${options.branch}`], repo);
  } catch {
    // Branch might not exist on remote yet — create it from HEAD
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
