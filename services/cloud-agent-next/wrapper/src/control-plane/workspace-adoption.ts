import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceBootstrapError } from '../bootstrap-error.js';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import { gitOperationError } from '../git-errors.js';
import { isSyntheticReviewRef } from '../git-review-ref.js';
import type { ExecResult } from '../utils.js';

/** Runs one git command in the workspace; network commands retry inside it. */
export type WorkspaceGit = (args: string[], options?: { network?: true }) => Promise<ExecResult>;

type Redact = (text: string) => string;

export async function refreshAdoptedRepository(input: {
  git: WorkspaceGit;
  remoteUrl: string;
  redact: Redact;
  branch?: string;
  branchMode?: ControlPlaneRouteSpec['branchMode'];
}): Promise<string | undefined> {
  const { git, remoteUrl, redact } = input;
  async function checked(args: string[], options?: { network?: true }): Promise<void> {
    const result = await git(args, options);
    if (result.exitCode === 0) return;
    const error = gitOperationError(result, 'checkout', redact);
    const operation = args[0] === 'remote' ? `remote ${args[1]}` : args[0];
    error.message = `${error.message} (git ${operation})`;
    throw error;
  }

  await checked(['remote', 'set-url', 'origin', remoteUrl]);
  await checked(['fetch', '--prune', 'origin'], { network: true });
  if (input.branch) {
    if (isSyntheticReviewRef(input.branch) && input.branchMode !== 'working') return undefined;
    const remoteRef = `refs/remotes/origin/${input.branch}`;
    const found = await git(['show-ref', '--verify', '--quiet', remoteRef]);
    if (found.exitCode === 0) return remoteRef;
    if (found.exitCode !== 1) throw gitOperationError(found, 'checkout', redact);
    if (input.branchMode !== 'working') {
      throw workspaceBootstrapError(
        'git_branch_missing',
        'Requested repository branch was not found',
        undefined,
        false
      );
    }
  }
  await checked(['remote', 'set-head', 'origin', '--auto'], { network: true });
  return 'refs/remotes/origin/HEAD';
}

/**
 * Leave no credential in `.git` before an environment build captures it:
 * `origin` is set to the bare URL and the reflogs and `FETCH_HEAD`, which can
 * record the URL a command ran with, are cleared. Returns false when any of that
 * fails, in which case the workspace must not be captured.
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
  try {
    await fs.rm(path.join(directory, '.git', 'FETCH_HEAD'), { force: true });
  } catch {
    return false;
  }
  return true;
}

/**
 * Empty a log so a snapshot does not carry this allocation's lines into a
 * restored container, where they would be uploaded with the next session's logs.
 * The log is appended to per line, so truncating in place is safe.
 */
export async function truncateWrapperLog(logPath: string | undefined): Promise<void> {
  if (logPath === undefined || logPath.length === 0) return;
  await fs.truncate(logPath, 0).catch(() => undefined);
}
