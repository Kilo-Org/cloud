import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CloneOptions, WorktreeOptions } from './types';

const WORKSPACE_ROOT = '/workspace/rigs';

// ── Per-rig mutex ────────────────────────────────────────────────────────
// Git operations (clone, fetch, worktree add/remove) on the same bare repo
// must be serialized because git acquires index.lock internally. Concurrent
// operations on different rigs are unaffected.

const rigLocks = new Map<string, Promise<void>>();

function withRigLock<T>(rigId: string, fn: () => Promise<T>): Promise<T> {
  const prev = rigLocks.get(rigId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive for the next caller; clean up when idle.
  rigLocks.set(
    rigId,
    next.then(
      () => {},
      () => {}
    )
  );
  void next.finally(() => {
    // Remove the entry once the chain is idle (no pending waiters).
    // If another caller chained onto `next` between our set and this
    // finally, the map value will have changed — only delete if it
    // still points to our void-mapped promise.
    const current = rigLocks.get(rigId);
    if (current) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      current.then(() => {
        if (rigLocks.get(rigId) === current) rigLocks.delete(rigId);
      });
    }
  });
  return next;
}

/**
 * Reject path segments that could escape the workspace via traversal.
 * Allows alphanumeric, hyphens, underscores, dots, and forward slashes
 * (for branch names like `polecat/name/bead-id`), but blocks `..` segments.
 */
function validatePathSegment(value: string, label: string): void {
  if (!value || /\.\.[/\\]|[/\\]\.\.|^\.\.$/.test(value)) {
    throw new Error(`${label} contains path traversal`);
  }
  // eslint-disable-next-line no-control-regex
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
 *
 * Security note: The authenticated URL is passed as a CLI argument to
 * `git clone`, making the token visible in the process list. This is
 * acceptable because the container is single-tenant (one town per container)
 * and only runs Gastown agent processes. For agent push/fetch operations
 * after clone, the credential-store helper configured in agent-runner.ts
 * is used instead.
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
  // eslint-disable-next-line no-control-regex, no-useless-escape
  if (/[\x00-\x1f\x7f ~^:?*\[\\]/.test(branch)) {
    throw new Error(`${label} contains invalid characters`);
  }
  if (branch.startsWith('-')) {
    throw new Error(`${label} cannot start with a hyphen`);
  }
}

/**
 * Verify a resolved path is inside the workspace root.
 * Uses realpath() to follow symlinks so a symlink pointing outside the
 * workspace is correctly rejected.
 */
async function assertInsideWorkspace(targetPath: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(targetPath);
  } catch {
    // Path doesn't exist yet (e.g. before mkdir) — fall back to lexical check
    real = resolve(targetPath);
  }
  if (!real.startsWith(WORKSPACE_ROOT + '/') && real !== WORKSPACE_ROOT) {
    throw new Error(`Path ${real} escapes workspace root`);
  }
}

async function exec(cmd: string, args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Prevent git from prompting for credentials in the container.
      // Public repos clone without auth; private repos fail fast with
      // a clear error instead of hanging on a username prompt.
      GIT_TERMINAL_PROMPT: '0',
    },
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

async function repoDir(rigId: string): Promise<string> {
  validatePathSegment(rigId, 'rigId');
  const dir = resolve(WORKSPACE_ROOT, rigId, 'repo');
  await assertInsideWorkspace(dir);
  return dir;
}

async function worktreeDir(rigId: string, branch: string): Promise<string> {
  validatePathSegment(rigId, 'rigId');
  validatePathSegment(branch, 'branch');
  const safeBranch = branch.replace(/\//g, '__');
  const dir = resolve(WORKSPACE_ROOT, rigId, 'worktrees', safeBranch);
  await assertInsideWorkspace(dir);
  return dir;
}

/**
 * Clone a git repo for the given rig (shared across all agents in the rig).
 * If the repo is already cloned, fetches latest instead.
 * When envVars contains GIT_TOKEN/GITLAB_TOKEN, constructs authenticated URLs.
 */
export function cloneRepo(
  options: CloneOptions & { envVars?: Record<string, string> }
): Promise<string> {
  return withRigLock(options.rigId, () => cloneRepoInner(options));
}

async function cloneRepoInner(
  options: CloneOptions & { envVars?: Record<string, string> }
): Promise<string> {
  validateGitUrl(options.gitUrl);
  validateBranchName(options.defaultBranch, 'defaultBranch');
  const dir = await repoDir(options.rigId);
  const authUrl = authenticateGitUrl(options.gitUrl, options.envVars);

  if (await pathExists(join(dir, '.git'))) {
    // Update the remote URL in case the token changed
    await exec('git', ['remote', 'set-url', 'origin', authUrl], dir).catch(err => {
      console.warn(`Failed to update remote URL for rig ${options.rigId}:`, err);
    });
    await exec('git', ['fetch', '--all', '--prune'], dir);
    console.log(`Fetched latest for rig ${options.rigId}`);
    return dir;
  }

  // Clean up partial clones (directory exists but no .git) from prior crashes
  if (await pathExists(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  const hasAuth = authUrl !== options.gitUrl;
  console.log(
    `Cloning repo for rig ${options.rigId}: hasAuth=${hasAuth} envKeys=[${Object.keys(options.envVars ?? {}).join(',')}]`
  );

  await mkdir(dir, { recursive: true });
  await exec('git', ['clone', '--no-checkout', '--branch', options.defaultBranch, authUrl, dir]);
  console.log(`Cloned repo for rig ${options.rigId}`);
  return dir;
}

/**
 * Create an isolated git worktree for an agent's branch.
 * If the worktree already exists, resets it to track the branch.
 */
export function createWorktree(options: WorktreeOptions): Promise<string> {
  return withRigLock(options.rigId, () => createWorktreeInner(options));
}

async function createWorktreeInner(options: WorktreeOptions): Promise<string> {
  const repo = await repoDir(options.rigId);
  const dir = await worktreeDir(options.rigId, options.branch);

  if (await pathExists(dir)) {
    await exec('git', ['checkout', options.branch], dir);
    await exec('git', ['pull', '--rebase', '--autostash'], dir).catch(() => {
      // Pull may fail if remote branch doesn't exist yet; that's fine
    });
    console.log(`Reused existing worktree at ${dir}`);
    return dir;
  }

  // When a startPoint is provided (e.g. a convoy feature branch), create
  // the new branch from that ref so the agent begins with the latest
  // merged work from upstream. Without a startPoint, try to track the
  // remote branch or fall back to the repo's current HEAD.
  const startPoint = options.startPoint;
  try {
    if (startPoint) {
      await exec('git', ['branch', options.branch, startPoint], repo);
    } else {
      await exec('git', ['branch', '--track', options.branch, `origin/${options.branch}`], repo);
    }
  } catch {
    // Fall back to origin/<defaultBranch> so we always branch from the
    // latest remote tip rather than the repo's local HEAD (which may be
    // stale in a --no-checkout bare clone).
    const fallback = options.defaultBranch ? `origin/${options.defaultBranch}` : undefined;
    if (fallback) {
      await exec('git', ['branch', options.branch, fallback], repo);
    } else {
      await exec('git', ['branch', options.branch], repo);
    }
  }

  await exec('git', ['worktree', 'add', dir, options.branch], repo);
  console.log(`Created worktree for branch ${options.branch} at ${dir}`);
  return dir;
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(rigId: string, branch: string): Promise<void> {
  return withRigLock(rigId, async () => {
    const repo = await repoDir(rigId);
    const dir = await worktreeDir(rigId, branch);

    if (!(await pathExists(dir))) return;

    await exec('git', ['worktree', 'remove', '--force', dir], repo);
    console.log(`Removed worktree at ${dir}`);
  });
}

/**
 * List all active worktrees for a rig.
 */
export async function listWorktrees(rigId: string): Promise<string[]> {
  const repo = await repoDir(rigId);
  if (!(await pathExists(repo))) return [];

  const output = await exec('git', ['worktree', 'list', '--porcelain'], repo);
  return output
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''));
}

/**
 * Create (or update) a read-only browse worktree for a rig on its default branch.
 * This gives the mayor agent a checked-out view of the codebase at
 * `/workspace/rigs/<rigId>/browse/` that it can navigate into via external_directory.
 *
 * If the browse worktree already exists, pulls latest from the remote.
 */
export function setupRigBrowseWorktree(
  options: CloneOptions & { envVars?: Record<string, string> }
): Promise<string> {
  return withRigLock(options.rigId, async () => {
    // Ensure the repo is cloned/up-to-date first
    await cloneRepoInner(options);
    return setupBrowseWorktreeInner(options.rigId, options.defaultBranch);
  });
}

async function setupBrowseWorktreeInner(rigId: string, defaultBranch: string): Promise<string> {
  validatePathSegment(rigId, 'rigId');
  const repo = await repoDir(rigId);
  const browseDir = resolve(WORKSPACE_ROOT, rigId, 'browse');
  await assertInsideWorkspace(browseDir);

  if (await pathExists(browseDir)) {
    // Already exists — fetch latest and reset the tracking branch to
    // origin/<defaultBranch>. The worktree lives on the synthetic
    // browse-<rigId> branch, not on <defaultBranch> directly.
    try {
      await exec('git', ['fetch', 'origin', defaultBranch], browseDir);
      await exec('git', ['reset', '--hard', `origin/${defaultBranch}`], browseDir);
      console.log(`Updated browse worktree for rig ${rigId} at ${browseDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.warn(`Browse worktree refresh failed for rig ${rigId} (may be stale): ${msg}`);
    }
    return browseDir;
  }

  // Create a worktree on the default branch for browsing.
  // Force-create (or reset) the tracking branch to origin/<defaultBranch>
  // so a recreated browse worktree always starts from the latest remote
  // tip rather than a stale local ref.
  const trackingBranch = `browse-${rigId.slice(0, 8)}`;
  try {
    await exec(
      'git',
      ['branch', '--force', '--track', trackingBranch, `origin/${defaultBranch}`],
      repo
    );
  } catch {
    // --force --track may fail on very old git; fall back to create-or-reset
    await exec('git', ['branch', '-f', trackingBranch, `origin/${defaultBranch}`], repo);
  }

  await exec('git', ['worktree', 'add', browseDir, trackingBranch], repo);
  console.log(`Created browse worktree for rig ${rigId} at ${browseDir}`);
  return browseDir;
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

  const repo = await repoDir(options.rigId);
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
  await assertInsideWorkspace(mergeDir);
  // Only create the parent — git worktree add creates the leaf directory itself
  await mkdir(resolve(WORKSPACE_ROOT, options.rigId, 'merge-tmp'), { recursive: true });

  const tmpBranch = `merge-tmp-${Date.now()}`;
  try {
    // Add worktree in detached HEAD state at the target branch tip.
    // Using --detach avoids "branch already checked out" errors when
    // the target branch (e.g. master) is checked out by the main repo.
    await exec('git', ['worktree', 'add', '--detach', mergeDir, options.targetBranch], repo);

    // Create a local branch for the merge so we can push the result.
    // Use a temporary name to avoid conflicts with the main worktree.
    await exec('git', ['checkout', '-b', tmpBranch], mergeDir);

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

    // Push the merge commit to the target branch on the remote
    await exec('git', ['push', 'origin', `${tmpBranch}:${options.targetBranch}`], mergeDir);

    return { status: 'merged', message: 'Merge successful', commitSha };
  } finally {
    // Always clean up the temporary worktree and temp branch
    await exec('git', ['worktree', 'remove', '--force', mergeDir], repo).catch(() => {});
    await rm(mergeDir, { recursive: true, force: true }).catch(() => {});
    await exec('git', ['branch', '-D', tmpBranch], repo).catch(() => {});
  }
}
