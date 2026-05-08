import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CloneOptions, WorktreeOptions } from './types';

const WORKSPACE_ROOT = '/workspace/rigs';

// Message fragments that indicate a git authentication failure. git CLI
// doesn't surface HTTP status codes directly; we match on stderr.
const AUTH_FAILURE_PATTERNS = [
  /\b(401|403)\b/,
  /Authentication failed/i,
  /could not read Username/i,
  /terminal prompts disabled/i,
  /fatal: unable to access.*The requested URL returned error:\s*(401|403)/i,
  /Invalid username or (password|token)/i,
  /remote: (Invalid|Bad|Write access to repository not granted)/i,
];

function isAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_FAILURE_PATTERNS.some(re => re.test(msg));
}

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
 * Configure a credential-store helper on the bare repo so that worktree
 * operations (checkout, reset, lfs smudge) can resolve credentials
 * through the standard git credential chain.
 *
 * Without this, git-lfs smudge filters triggered by `git worktree add`
 * or `git reset --hard` fail with "Smudge error" because the LFS batch
 * API request has no credentials. The token is embedded in the remote
 * URL, but some git-lfs versions require the credential helper for the
 * LFS batch endpoint (which uses a different URL path).
 */
async function configureRepoCredentials(
  repoDir: string,
  gitUrl: string,
  envVars?: Record<string, string>
): Promise<void> {
  if (!envVars) return;

  const token = envVars.GIT_TOKEN ?? envVars.GITHUB_TOKEN;
  const gitlabToken = envVars.GITLAB_TOKEN;
  if (!token && !gitlabToken) return;

  try {
    const url = new URL(gitUrl);
    const credentialLine =
      gitlabToken && (url.hostname.includes('gitlab') || envVars.GITLAB_INSTANCE_URL)
        ? `https://oauth2:${gitlabToken}@${url.hostname}`
        : token
          ? `https://x-access-token:${token}@${url.hostname}`
          : null;

    if (!credentialLine) return;

    // Write to a per-repo credential file outside the repo itself
    const credFile = `/tmp/.git-credentials-repo-${repoDir.replace(/[^a-zA-Z0-9]/g, '-')}`;
    await writeFile(credFile, credentialLine + '\n', { mode: 0o600 });

    await exec('git', ['config', 'credential.helper', `store --file=${credFile}`], repoDir);
  } catch (err) {
    console.warn(`Failed to configure repo credentials for ${repoDir}:`, err);
  }
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

/**
 * Call the worker's refresh-git-token endpoint to obtain a fresh GitHub
 * App installation token. Updates process.env.GIT_TOKEN and rewrites
 * per-repo credential-store files so subsequent git operations (including
 * the agent's own `git push`) pick up the new token.
 *
 * Returns the new token on success, or null if the refresh failed (no
 * integration configured, network error, auth rejected, etc.).
 *
 * Callers: retry-on-auth-failure wrapper in git-manager, periodic refresh
 * timer in process-manager (if added).
 */
export async function refreshGitToken(rigId: string): Promise<string | null> {
  const apiUrl = process.env.GASTOWN_API_URL;
  const townId = process.env.GASTOWN_TOWN_ID;
  const token = process.env.GASTOWN_CONTAINER_TOKEN;
  if (!apiUrl || !townId || !token) {
    console.warn(
      `[refreshGitToken] missing env: apiUrl=${!!apiUrl} townId=${!!townId} containerToken=${!!token}`
    );
    return null;
  }

  try {
    const resp = await fetch(`${apiUrl}/api/towns/${townId}/rigs/${rigId}/refresh-git-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '(unreadable)');
      console.warn(
        `[refreshGitToken] worker returned ${resp.status} for rig=${rigId}: ${body.slice(0, 200)}`
      );
      return null;
    }
    const raw: unknown = await resp.json();
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('data' in raw) ||
      !raw.data ||
      typeof raw.data !== 'object' ||
      !('token' in raw.data) ||
      typeof (raw.data as { token: unknown }).token !== 'string'
    ) {
      console.warn(`[refreshGitToken] unexpected response shape for rig=${rigId}`);
      return null;
    }
    const freshToken = (raw.data as { token: string }).token;

    // Update process.env so subsequent exec() calls (which inherit
    // process.env) see the new token via authenticateGitUrl.
    process.env.GIT_TOKEN = freshToken;

    // Rewrite the per-rig /tmp/.git-credentials* files that currently
    // store a token. The credential helper reads these verbatim, so the
    // agent's own `git push` (running in a subprocess outside this module)
    // picks up the new token on the next invocation without restart.
    //
    // Scoped to the current rig only — both configureGitCredentials and
    // configureRepoCredentials slugify a path containing the rigId into
    // the credential filename, so we can select them by substring match.
    // Rewriting every file would clobber other rigs' tokens (each rig can
    // have a distinct platformIntegrationId, so tokens are not interchangeable).
    await rewriteCredentialStoreFiles(rigId, freshToken);

    console.log(`[refreshGitToken] refreshed token for rig=${rigId}`);
    return freshToken;
  } catch (err) {
    console.warn(`[refreshGitToken] failed for rig=${rigId}:`, err);
    return null;
  }
}

/**
 * Walk /tmp for credential-store files previously written by
 * configureRepoCredentials / configureGitCredentials for the given rig
 * and rewrite them to use the new token. Files for other rigs are left
 * alone so this refresh doesn't stomp their (possibly distinct) tokens.
 *
 * Files are identified by the slugified rigId appearing in the filename
 * (both writers embed a path under `/workspace/rigs/<rigId>/...` in the
 * credential file name, slugified via `replace(/[^a-zA-Z0-9]/g, '-')`).
 * Only GitHub `x-access-token` lines are rewritten; GitLab `oauth2`
 * lines are left alone (they use gitlab_token, not an installation token).
 */
async function rewriteCredentialStoreFiles(rigId: string, freshToken: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir('/tmp');
  } catch {
    return;
  }

  const rigSlug = rigId.replace(/[^a-zA-Z0-9]/g, '-');

  for (const name of entries) {
    if (!name.startsWith('.git-credentials')) continue;
    if (!name.includes(rigSlug)) continue;
    const path = `/tmp/${name}`;
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }

    // Credential line format: https://x-access-token:<token>@<host>\n
    // Only rewrite lines using x-access-token (GitHub). Leave oauth2
    // (GitLab) lines alone so we don't replace gitlab_token with a
    // GitHub token.
    const rewritten = content
      .split('\n')
      .map(line => {
        if (!line.startsWith('https://x-access-token:')) return line;
        const match = line.match(/^(https:\/\/x-access-token:)[^@]+(@.+)$/);
        if (!match) return line;
        return `${match[1]}${freshToken}${match[2]}`;
      })
      .join('\n');

    if (rewritten !== content) {
      try {
        await writeFile(path, rewritten, { mode: 0o600 });
      } catch (err) {
        console.warn(`[refreshGitToken] failed to rewrite ${path}:`, err);
      }
    }
  }
}

/**
 * Run a git operation that uses GIT_TOKEN. On auth failure (401/403),
 * refresh the token via the worker endpoint and retry once with the
 * caller-rebuilt args (so authenticated URLs pick up the new token).
 *
 * `buildArgs` is called again on retry so callers that embed the token
 * in a URL (e.g. `git clone https://<token>@...`) can regenerate it.
 *
 * For operations that talk to `origin` (fetch, pull, push without a URL
 * arg), pass `gitUrl` so that after refresh we rewrite the `origin`
 * remote URL with the new token. Git reads the embedded password from
 * the remote URL before consulting the credential helper, so without
 * this the retry would re-send the same expired token.
 */
async function execWithAuthRetry(
  cmd: string,
  buildArgs: () => string[] | Promise<string[]>,
  opts: {
    cwd?: string;
    rigId: string;
    envVars?: Record<string, string>;
    /** Git URL to rebuild `origin` with after a token refresh. */
    gitUrl?: string;
  }
): Promise<string> {
  try {
    const args = await buildArgs();
    return await exec(cmd, args, opts.cwd);
  } catch (err) {
    if (!isAuthFailure(err)) throw err;

    const rawMsg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(
      `[execWithAuthRetry] auth failure for rig=${opts.rigId}, refreshing token and retrying: ${redactGitTokens(rawMsg)}`
    );

    const fresh = await refreshGitToken(opts.rigId);
    if (!fresh) {
      throw err;
    }

    // Mutate the caller's envVars map in place so subsequent calls in
    // the same workflow (e.g. mergeBranch → push after fetch) use the
    // fresh token without another round-trip.
    if (opts.envVars) {
      opts.envVars.GIT_TOKEN = fresh;
    }

    // If the operation uses the `origin` remote, its stored URL still
    // has the old token embedded. Rewrite it before retrying so the
    // retry sends the fresh token.
    if (opts.gitUrl && opts.cwd) {
      try {
        await exec(
          'git',
          ['remote', 'set-url', 'origin', authenticateGitUrl(opts.gitUrl, opts.envVars)],
          opts.cwd
        );
      } catch (setUrlErr) {
        const m = setUrlErr instanceof Error ? setUrlErr.message.split('\n')[0] : String(setUrlErr);
        console.warn(
          `[execWithAuthRetry] failed to rewrite origin URL for rig=${opts.rigId}: ${redactGitTokens(m)}`
        );
      }
    }

    const retryArgs = await buildArgs();
    return await exec(cmd, retryArgs, opts.cwd);
  }
}

/**
 * Redact tokens from a string that may include authenticated git URLs
 * (e.g. `https://x-access-token:<token>@github.com/...` or
 * `https://oauth2:<token>@gitlab.com/...`). Used on every error string
 * and log line that could contain a command line or git stderr, so an
 * auth failure never leaks the token.
 */
function redactGitTokens(s: string): string {
  return s.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)(@)/g, '$1$2:***REDACTED***$4');
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
      // Skip LFS smudge filter during checkout/worktree operations.
      // Agents don't need binary assets (videos, images, etc.) and
      // LFS downloads can fail when the credential helper doesn't
      // cover the LFS batch endpoint, blocking worktree creation.
      GIT_LFS_SKIP_SMUDGE: '1',
    },
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const cmdLine = redactGitTokens(`${cmd} ${args.join(' ')}`);
    const detail = redactGitTokens(stderr || `exit code ${exitCode}`);
    throw new Error(`${cmdLine} failed: ${detail}`);
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

  if (await pathExists(join(dir, '.git'))) {
    // Update the remote URL in case the token changed. Re-resolve authUrl
    // inside the retry wrapper so a refreshed GIT_TOKEN is picked up.
    await execWithAuthRetry(
      'git',
      () => ['remote', 'set-url', 'origin', authenticateGitUrl(options.gitUrl, options.envVars)],
      { cwd: dir, rigId: options.rigId, envVars: options.envVars }
    ).catch(err => {
      console.warn(`Failed to update remote URL for rig ${options.rigId}:`, err);
    });
    await configureRepoCredentials(dir, options.gitUrl, options.envVars);
    await execWithAuthRetry('git', () => ['fetch', '--all', '--prune'], {
      cwd: dir,
      rigId: options.rigId,
      envVars: options.envVars,
      gitUrl: options.gitUrl,
    });
    console.log(`Fetched latest for rig ${options.rigId}`);
    return dir;
  }

  // Clean up partial clones (directory exists but no .git) from prior crashes
  if (await pathExists(dir)) {
    await rm(dir, { recursive: true, force: true });
  }

  const hasAuth = authenticateGitUrl(options.gitUrl, options.envVars) !== options.gitUrl;
  console.log(
    `Cloning repo for rig ${options.rigId}: hasAuth=${hasAuth} envKeys=[${Object.keys(options.envVars ?? {}).join(',')}]`
  );

  // Omit --branch: on empty repos (no commits) the default branch doesn't
  // exist yet, so `git clone --branch <branch>` would fail with
  // "Remote branch <branch> not found in upstream origin".
  await mkdir(dir, { recursive: true });
  await execWithAuthRetry(
    'git',
    () => ['clone', '--no-checkout', authenticateGitUrl(options.gitUrl, options.envVars), dir],
    { rigId: options.rigId, envVars: options.envVars }
  );
  await configureRepoCredentials(dir, options.gitUrl, options.envVars);

  // Detect empty repo: git rev-parse HEAD fails when there are no commits.
  const isEmpty = await exec('git', ['rev-parse', 'HEAD'], dir)
    .then(() => false)
    .catch(() => true);

  if (isEmpty) {
    console.log(`Detected empty repo for rig ${options.rigId}, creating initial commit`);
    // Create an initial empty commit so branches/worktrees can be created.
    // Use -c flags for user identity (the repo has no config yet and the
    // container may not have GIT_AUTHOR_NAME set).
    await exec(
      'git',
      [
        '-c',
        'user.name=Gastown',
        '-c',
        'user.email=gastown@kilo.ai',
        'commit',
        '--allow-empty',
        '-m',
        'Initial commit',
      ],
      dir
    );
    await execWithAuthRetry('git', () => ['push', 'origin', `HEAD:${options.defaultBranch}`], {
      cwd: dir,
      rigId: options.rigId,
      envVars: options.envVars,
      gitUrl: options.gitUrl,
    });
    // Best-effort: set remote HEAD so future operations know the default branch
    await exec('git', ['remote', 'set-head', 'origin', options.defaultBranch], dir).catch(() => {});
    // Fetch so origin/<defaultBranch> ref is available locally
    await execWithAuthRetry('git', () => ['fetch', 'origin'], {
      cwd: dir,
      rigId: options.rigId,
      envVars: options.envVars,
      gitUrl: options.gitUrl,
    });
    console.log(`Created initial commit on empty repo for rig ${options.rigId}`);
  }

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
    await execWithAuthRetry('git', () => ['pull', '--rebase', '--autostash'], {
      cwd: dir,
      rigId: options.rigId,
      envVars: options.envVars,
      gitUrl: options.gitUrl,
    }).catch(() => {
      // Pull may fail if remote branch doesn't exist yet; that's fine
    });
    console.log(`Reused existing worktree at ${dir}`);
    return dir;
  }

  // Verify the repo has at least one commit. If cloneRepoInner's initial
  // commit push failed, there's no HEAD and we can't create branches.
  const hasHead = await exec('git', ['rev-parse', '--verify', 'HEAD'], repo)
    .then(() => true)
    .catch(() => false);

  if (!hasHead) {
    throw new Error(
      `Cannot create worktree: repo has no commits. Push an initial commit first or re-connect the rig.`
    );
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
      await execWithAuthRetry('git', () => ['fetch', 'origin', defaultBranch], {
        cwd: browseDir,
        rigId,
      });
      await exec('git', ['reset', '--hard', `origin/${defaultBranch}`], browseDir);
      console.log(`Updated browse worktree for rig ${rigId} at ${browseDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.warn(`Browse worktree refresh failed for rig ${rigId} (may be stale): ${msg}`);
    }
    return browseDir;
  }

  // Check whether origin/<defaultBranch> exists. On a repo that was just
  // initialized with an empty commit in cloneRepoInner the ref should
  // exist, but if the push failed (network, permissions) it may not.
  const hasRemoteBranch = await exec(
    'git',
    ['rev-parse', '--verify', `origin/${defaultBranch}`],
    repo
  )
    .then(() => true)
    .catch(() => false);

  if (!hasRemoteBranch) {
    console.log(
      `Skipping browse worktree for rig ${rigId}: origin/${defaultBranch} not found (repo may be empty), will create on next fetch`
    );
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

  // Ensure repo exists and is up to date
  if (!(await pathExists(join(repo, '.git')))) {
    await cloneRepo({
      rigId: options.rigId,
      gitUrl: options.gitUrl,
      defaultBranch: options.targetBranch,
      envVars: options.envVars,
    });
  } else {
    // Update remote URL for fresh token. Re-resolve inside the retry
    // wrapper so a refreshed token replaces the expired one embedded
    // in the remote URL.
    await execWithAuthRetry(
      'git',
      () => ['remote', 'set-url', 'origin', authenticateGitUrl(options.gitUrl, options.envVars)],
      { cwd: repo, rigId: options.rigId, envVars: options.envVars }
    ).catch(() => {});
    await execWithAuthRetry('git', () => ['fetch', '--all', '--prune'], {
      cwd: repo,
      rigId: options.rigId,
      envVars: options.envVars,
      gitUrl: options.gitUrl,
    });
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
    await execWithAuthRetry(
      'git',
      () => ['push', 'origin', `${tmpBranch}:${options.targetBranch}`],
      { cwd: mergeDir, rigId: options.rigId, envVars: options.envVars, gitUrl: options.gitUrl }
    );

    return { status: 'merged', message: 'Merge successful', commitSha };
  } finally {
    // Always clean up the temporary worktree and temp branch
    await exec('git', ['worktree', 'remove', '--force', mergeDir], repo).catch(() => {});
    await rm(mergeDir, { recursive: true, force: true }).catch(() => {});
    await exec('git', ['branch', '-D', tmpBranch], repo).catch(() => {});
  }
}
