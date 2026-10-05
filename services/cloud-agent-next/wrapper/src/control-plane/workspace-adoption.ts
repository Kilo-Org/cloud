import fs from 'node:fs/promises';
import path from 'node:path';
import type { WrapperBootstrapError } from '../bootstrap-error.js';
import { gitOperationError } from '../git-errors.js';
import type { ExecResult } from '../utils.js';

/** Runs one git command in the workspace; network commands retry inside it. */
export type WorkspaceGit = (args: string[], options?: { network?: true }) => Promise<ExecResult>;

type Redact = (text: string) => string;

function failure(
  result: ExecResult,
  operation: 'clone' | 'checkout',
  redact: Redact
): WrapperBootstrapError {
  return gitOperationError(result, operation, redact);
}

/**
 * Bring a repository restored from a snapshot to the state a fresh clone has, so
 * the ordinary branch logic then behaves the same on both paths:
 *
 * 1. point `origin` at this route's credential;
 * 2. fetch, pruning refs the remote dropped, and refresh the remote default;
 * 3. detach at the remote default branch, so a new branch starts from its tip;
 * 4. drop every local branch. The captured session's branch, or this session's own
 *    from an earlier capture, would otherwise shadow a newer `origin/<branch>`.
 *
 * Any failure throws and the caller falls back to a clone.
 */
export async function refreshAdoptedRepository(input: {
  git: WorkspaceGit;
  remoteUrl: string;
  redact: Redact;
}): Promise<void> {
  const { git, remoteUrl, redact } = input;
  const steps: Array<{ args: string[]; network?: true }> = [
    { args: ['remote', 'set-url', 'origin', remoteUrl] },
    { args: ['fetch', '--prune', 'origin'], network: true },
    { args: ['remote', 'set-head', 'origin', '--auto'], network: true },
    { args: ['checkout', '--detach', 'origin/HEAD'] },
  ];
  for (const step of steps) {
    const result = await git(step.args, step.network ? { network: true } : undefined);
    if (result.exitCode !== 0) throw failure(result, 'checkout', redact);
  }
  const listed = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (listed.exitCode !== 0) throw failure(listed, 'checkout', redact);
  const branches = listed.stdout.split('\n').filter(name => name.length > 0);
  if (branches.length === 0) return;
  const deleted = await git(['branch', '-D', ...branches]);
  if (deleted.exitCode !== 0) throw failure(deleted, 'checkout', redact);
}

/**
 * Leave no credential in `.git` before a snapshot: `origin` is set to the bare URL
 * and the reflogs and `FETCH_HEAD`, which can record the URL a command ran with,
 * are cleared. Returns false when the URL could not be made bare, in which case
 * the workspace must not be captured.
 */
export async function stripGitCredentials(input: {
  git: WorkspaceGit;
  directory: string;
  bareUrl: string;
}): Promise<boolean> {
  const { git, directory, bareUrl } = input;
  const bare = await git(['remote', 'set-url', 'origin', bareUrl]);
  if (bare.exitCode !== 0) return false;
  const expired = await git(['reflog', 'expire', '--expire=now', '--all']);
  if (expired.exitCode !== 0) return false;
  await fs.rm(path.join(directory, '.git', 'FETCH_HEAD'), { force: true }).catch(() => undefined);
  return true;
}

/**
 * A restored container still holds the session homes of the allocation that took
 * the snapshot. Setup re-runs and recreates what it needs under this route's own
 * home, so every other entry is stale and only risks being read as current state
 * (the log uploader archives each one).
 */
export async function removeStaleHomes(homeRoot: string, keep: string): Promise<void> {
  const entries = await fs.readdir(homeRoot).catch(() => [] as string[]);
  const keepName = path.basename(keep);
  await Promise.all(
    entries
      .filter(name => name !== keepName)
      .map(name => fs.rm(path.join(homeRoot, name), { recursive: true, force: true }))
  );
}

/**
 * Empty the wrapper log so a snapshot does not carry this allocation's lines into a
 * restored container, where they would be uploaded with the next session's logs.
 * The log is appended to per line, so truncating in place is safe.
 */
export async function truncateWrapperLog(logPath: string | undefined): Promise<void> {
  if (logPath === undefined || logPath.length === 0) return;
  await fs.truncate(logPath, 0).catch(() => undefined);
}

/**
 * Remove a workspace so it can be cloned again. Refuses a path that is not a
 * dedicated directory, because the path comes from the route spec.
 */
export async function emptyWorkspaceDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const { root } = path.parse(resolved);
  if (resolved === root || path.dirname(resolved) === root) {
    throw new Error('Refusing to empty a top-level directory');
  }
  await fs.rm(resolved, { recursive: true, force: true });
}
