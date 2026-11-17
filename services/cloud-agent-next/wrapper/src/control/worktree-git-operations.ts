import { access } from 'node:fs/promises';
import path from 'node:path';
import type {
  WorktreeBranchOperation,
  WorktreeBranchOperationRefusalReason,
  WorktreeBranchOperationResult,
} from '../../../src/shared/worktree-git-operations.js';
import { git, type ExecResult, type ProcessOptions } from '../utils.js';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DURABLE_REF_PREFIX = 'refs/kilo/last-known-remote/';
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const NETWORK_GIT_TIMEOUT_MS = 120_000;
const MISSING_REMOTE_REF =
  /(?:couldn't find remote ref|remote ref .* not found|no such remote ref|fatal: couldn't find remote ref)/i;

export class WorktreeGitError extends Error {
  constructor(
    message: string,
    readonly code: 'git_network_failed' | 'git_failed' = 'git_failed',
    readonly retryable = true
  ) {
    super(message);
    this.name = 'WorktreeGitError';
  }
}

export type WorktreeGitOptions = {
  directory: string;
  /** The prepared per-worktree environment. Never the raw wrapper environment. */
  env?: NodeJS.ProcessEnv;
  /** Managed host arguments (GitHub `proactiveAuth`/redirect policy), prepended to every command. */
  configArgs?: readonly string[];
  runGit?: (args: string[], options?: ProcessOptions) => Promise<ExecResult>;
  signal?: AbortSignal;
};

export type WorktreeGitExecutor = ReturnType<typeof createWorktreeGitExecutor>;

function assertBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch.length > 256 ||
    branch.startsWith('-') ||
    /[\0\r\n]/.test(branch)
  ) {
    throw new WorktreeGitError('Invalid branch name', 'git_failed', false);
  }
}

export function lastKnownRemoteRef(branch: string): string {
  assertBranch(branch);
  return `${DURABLE_REF_PREFIX}${branch}`;
}

export function createWorktreeGitExecutor(options: WorktreeGitOptions) {
  const runGit = options.runGit ?? git;
  const prefix = ['--no-pager', '-c', 'color.ui=false', ...(options.configArgs ?? [])];
  const baseEnv = options.env;

  async function exec(args: string[], limitMs = DEFAULT_GIT_TIMEOUT_MS): Promise<ExecResult> {
    return runGit([...prefix, ...args], {
      cwd: options.directory,
      ...(baseEnv === undefined ? {} : { env: baseEnv, inheritEnv: false }),
      timeoutMs: limitMs,
      signal: options.signal,
    });
  }

  async function text(args: string[], limitMs?: number): Promise<string> {
    const result = await exec(args, limitMs);
    if (result.exitCode !== 0 || result.terminationReason !== undefined) {
      throw new WorktreeGitError(
        `git ${args[0] ?? ''} failed: ${result.stderr.trim() || result.stdout.trim()}`,
        'git_failed',
        false
      );
    }
    return result.stdout;
  }

  async function tryResolve(ref: string): Promise<string | null> {
    const result = await exec(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (result.exitCode !== 0 || result.terminationReason !== undefined) return null;
    const value = result.stdout.trim();
    return COMMIT_PATTERN.test(value) ? value : null;
  }

  async function resolve(ref: string): Promise<string> {
    const value = await tryResolve(ref);
    if (value === null) throw new WorktreeGitError(`Unknown git revision ${ref}`);
    return value;
  }

  async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await exec(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new WorktreeGitError(
      `git merge-base failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  async function mergeBase(left: string, right: string): Promise<string | null> {
    const result = await exec(['merge-base', left, right]);
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return COMMIT_PATTERN.test(value) ? value : null;
  }

  async function currentBranch(): Promise<string | null> {
    const result = await exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value.length === 0 ? null : value;
  }

  async function head(): Promise<string> {
    return resolve('HEAD');
  }

  async function isDirty(): Promise<boolean> {
    return (await text(['status', '--porcelain'])).trim().length > 0;
  }

  async function rebaseInProgress(): Promise<boolean> {
    for (const directory of ['rebase-merge', 'rebase-apply']) {
      const gitPath = await exec(['rev-parse', '--git-path', directory]);
      if (gitPath.exitCode !== 0) continue;
      try {
        await access(path.resolve(options.directory, gitPath.stdout.trim()));
        return true;
      } catch {
        // The path does not exist.
      }
    }
    return false;
  }

  async function conflictedFiles(): Promise<string[]> {
    const result = await exec([
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\0')
      .map(value => value.trim())
      .filter(value => value.length > 0);
  }

  async function resolveLastKnownRemote(branch: string): Promise<string | null> {
    return tryResolve(lastKnownRemoteRef(branch));
  }

  async function writeLastKnownRemote(branch: string, sha: string): Promise<void> {
    if (!COMMIT_PATTERN.test(sha)) {
      throw new WorktreeGitError(
        'Refusing to record an invalid remote commit',
        'git_failed',
        false
      );
    }
    await text(['update-ref', lastKnownRemoteRef(branch), sha]);
  }

  async function deleteLastKnownRemote(branch: string): Promise<void> {
    await exec(['update-ref', '-d', lastKnownRemoteRef(branch)]);
  }

  type RemoteFetch = { kind: 'ok' } | { kind: 'missing' } | { kind: 'failed'; message: string };

  async function fetchBranch(branch: string): Promise<RemoteFetch> {
    assertBranch(branch);
    const result = await exec(['fetch', '--no-tags', 'origin', branch], NETWORK_GIT_TIMEOUT_MS);
    if (result.exitCode === 0 && result.terminationReason === undefined) return { kind: 'ok' };
    const message = `${result.stderr}\n${result.stdout}`;
    if (MISSING_REMOTE_REF.test(message)) return { kind: 'missing' };
    return { kind: 'failed', message: result.stderr.trim() || result.stdout.trim() };
  }

  async function fetchAll(): Promise<void> {
    const result = await exec(['fetch', '--no-tags', 'origin'], NETWORK_GIT_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.terminationReason !== undefined) {
      throw new WorktreeGitError(
        `git fetch origin failed: ${result.stderr.trim() || result.stdout.trim()}`,
        'git_network_failed',
        true
      );
    }
  }

  async function defaultRemoteBranch(): Promise<string | null> {
    const symbolic = await exec(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (symbolic.exitCode === 0) {
      const value = symbolic.stdout.trim();
      if (value.startsWith('refs/remotes/origin/'))
        return value.slice('refs/remotes/origin/'.length);
    }
    for (const candidate of ['main', 'master']) {
      if ((await tryResolve(`refs/remotes/origin/${candidate}`)) !== null) return candidate;
    }
    return null;
  }

  async function seedLastKnownRemoteFromOrigin(branch: string): Promise<string | null> {
    const existing = await resolveLastKnownRemote(branch);
    if (existing !== null) return existing;
    const remote = await tryResolve(`refs/remotes/origin/${branch}`);
    if (remote === null) return null;
    const local = await head();
    if (!(await isAncestor(remote, local))) return null;
    await writeLastKnownRemote(branch, remote);
    return remote;
  }

  /**
   * Record the remote commit a successful push published. Auto-commit uses this
   * so the next Sync knows which local commits were already published.
   */
  async function rememberPushedRemote(
    branch: string,
    remoteBranch = branch
  ): Promise<string | null> {
    const remote = await tryResolve(`refs/remotes/origin/${remoteBranch}`);
    const value = remote ?? (await head());
    await writeLastKnownRemote(branch, value);
    return value;
  }

  return {
    exec,
    text,
    tryResolve,
    resolve,
    isAncestor,
    mergeBase,
    currentBranch,
    head,
    isDirty,
    rebaseInProgress,
    conflictedFiles,
    resolveLastKnownRemote,
    writeLastKnownRemote,
    deleteLastKnownRemote,
    fetchBranch,
    fetchAll,
    defaultRemoteBranch,
    seedLastKnownRemoteFromOrigin,
    rememberPushedRemote,
  };
}

export type WorktreeGitExecutorInternal = ReturnType<typeof createWorktreeGitExecutor>;

/** Quote a ref for a shell command that the agent may run. Branch names can contain `$(...)`. */
function shellArg(value: string): string {
  return /^[\w./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function filesForInstruction(files: readonly string[]): string {
  if (files.length === 0) return 'the conflicted files';
  const shown = files.slice(0, 20).join(', ');
  return files.length > 20 ? `${shown}, and ${files.length - 20} more` : shown;
}

function refused(
  operation: WorktreeBranchOperation,
  branch: string | null,
  reason: WorktreeBranchOperationRefusalReason,
  message: string,
  values: {
    baseBranch?: string | null;
    baseSha?: string | null;
    previousRemoteSha?: string | null;
    remoteSha?: string | null;
    headSha: string;
  }
): WorktreeBranchOperationResult {
  return {
    status: 'refused',
    operation,
    branch,
    reason,
    message,
    baseBranch: values.baseBranch ?? null,
    baseSha: values.baseSha ?? null,
    previousRemoteSha: values.previousRemoteSha ?? null,
    remoteSha: values.remoteSha ?? null,
    headSha: values.headSha,
  };
}

async function abortRebase(
  executor: WorktreeGitExecutorInternal,
  originalHead: string
): Promise<void> {
  if (await executor.rebaseInProgress()) {
    await executor.exec(['rebase', '--abort']);
  }
  const head = await executor.tryResolve('HEAD');
  if (head === originalHead) return;
  // The abort did not restore the branch; only a clean tree may be reset, and
  // the caller learns if even that failed.
  if (await executor.isDirty()) {
    throw new WorktreeGitError(
      'A branch rewrite could not be rolled back because the worktree is dirty',
      'git_failed',
      false
    );
  }
  await executor.exec(['reset', '--hard', originalHead]);
  if ((await executor.tryResolve('HEAD')) !== originalHead) {
    throw new WorktreeGitError('A branch rewrite could not be rolled back', 'git_failed', false);
  }
}

async function rollbackAfterPushFailure(
  executor: WorktreeGitExecutorInternal,
  originalHead: string,
  rebasedHead: string
): Promise<void> {
  if (await executor.rebaseInProgress()) {
    await executor.exec(['rebase', '--abort']);
  }
  const head = await executor.tryResolve('HEAD');
  if (head !== rebasedHead) {
    throw new WorktreeGitError(
      'Refusing to roll back a branch whose HEAD moved unexpectedly',
      'git_failed',
      false
    );
  }
  if (await executor.isDirty()) {
    throw new WorktreeGitError(
      'Refusing to roll back a dirty worktree after a failed push',
      'git_failed',
      false
    );
  }
  await executor.exec(['reset', '--hard', originalHead]);
  if ((await executor.tryResolve('HEAD')) !== originalHead) {
    throw new WorktreeGitError(
      'A failed push left the worktree at a rewritten commit that could not be rolled back',
      'git_failed',
      false
    );
  }
}

async function effectiveSyncBase(
  executor: WorktreeGitExecutorInternal,
  finalHead: string,
  baseBranch: string | null,
  upstreamSha: string | undefined
): Promise<{ baseBranch: string | null; baseSha: string | null }> {
  if (baseBranch === null) return { baseBranch: null, baseSha: null };
  const baseRef = await executor.tryResolve(`refs/remotes/origin/${baseBranch}`);
  if (baseRef === null) return { baseBranch: null, baseSha: null };
  const candidate = await executor.mergeBase(finalHead, baseRef);
  if (candidate === null) return { baseBranch: null, baseSha: null };
  if (upstreamSha === undefined) return { baseBranch, baseSha: candidate };
  const boundary = await executor.tryResolve(upstreamSha);
  if (boundary === null) return { baseBranch: null, baseSha: null };
  // A boundary that is no longer in HEAD means Sync accepted an own-remote
  // rewrite, so the new base is the only truthful one.
  if (!(await executor.isAncestor(boundary, finalHead))) {
    return { baseBranch, baseSha: candidate };
  }
  // Candidate must not regress behind the recorded parent boundary.
  if (await executor.isAncestor(boundary, candidate)) {
    return { baseBranch, baseSha: candidate };
  }
  return { baseBranch: null, baseSha: null };
}

export type SyncOptions = {
  /** The branch the route expects; HEAD must be on it. */
  expectedBranch?: string;
};

export async function runWorktreeSync(
  executor: WorktreeGitExecutorInternal,
  request: { baseBranch?: string; upstreamSha?: string },
  options: SyncOptions = {}
): Promise<WorktreeBranchOperationResult> {
  const branch = await executor.currentBranch();
  if (branch === null) {
    return refused('sync', null, 'branch_mismatch', 'HEAD is detached', {
      headSha: (await executor.tryResolve('HEAD')) ?? '0'.repeat(40),
    });
  }
  const originalHead = await executor.head();
  if (options.expectedBranch !== undefined && options.expectedBranch !== branch) {
    return refused(
      'sync',
      branch,
      'branch_mismatch',
      `The worktree is on ${branch}, not ${options.expectedBranch}`,
      { headSha: originalHead }
    );
  }
  if (await executor.isDirty()) {
    return refused(
      'sync',
      branch,
      'dirty_worktree',
      'Commit or discard the worktree changes before syncing the branch',
      { headSha: originalHead }
    );
  }
  if (await executor.rebaseInProgress()) {
    return refused('sync', branch, 'rebase_in_progress', 'A rebase is already in progress', {
      headSha: originalHead,
    });
  }

  const previousDurable = await executor.resolveLastKnownRemote(branch);
  const ownFetch = await executor.fetchBranch(branch);
  if (ownFetch.kind === 'missing') {
    return refused(
      'sync',
      branch,
      'remote_branch_missing',
      `The remote branch origin/${branch} does not exist`,
      { previousRemoteSha: previousDurable, headSha: originalHead }
    );
  }
  if (ownFetch.kind === 'failed') {
    throw new WorktreeGitError(
      `git fetch origin ${branch} failed: ${ownFetch.message}`,
      'git_network_failed',
      true
    );
  }
  const remoteSha = await executor.tryResolve(`refs/remotes/origin/${branch}`);
  if (remoteSha === null) {
    return refused(
      'sync',
      branch,
      'remote_branch_missing',
      `The remote branch origin/${branch} does not exist`,
      { previousRemoteSha: previousDurable, headSha: originalHead }
    );
  }

  let previousRemoteSha = previousDurable;
  if (previousRemoteSha === null) {
    if (await executor.isAncestor(remoteSha, originalHead)) {
      previousRemoteSha = remoteSha;
      await executor.writeLastKnownRemote(branch, remoteSha);
    }
  }

  let baseBranch: string | null = request.baseBranch ?? null;
  if (baseBranch !== null) {
    const baseFetch = await executor.fetchBranch(baseBranch);
    if (baseFetch.kind === 'failed') {
      throw new WorktreeGitError(
        `git fetch origin ${baseBranch} failed: ${baseFetch.message}`,
        'git_network_failed',
        true
      );
    }
    if (baseFetch.kind === 'missing') {
      const fallback = await executor.defaultRemoteBranch();
      if (fallback === null) {
        throw new WorktreeGitError(
          `The base branch origin/${baseBranch} does not exist and there is no default branch`,
          'git_network_failed',
          true
        );
      }
      baseBranch = fallback;
    }
  }

  // The durable ref proves nothing after HEAD was rewound, so HEAD must also contain the remote tip.
  if (previousRemoteSha === remoteSha && (await executor.isAncestor(remoteSha, originalHead))) {
    const effective = await effectiveSyncBase(
      executor,
      originalHead,
      baseBranch,
      request.upstreamSha
    );
    return {
      status: 'unchanged',
      operation: 'sync',
      branch,
      ...effective,
      previousRemoteSha,
      remoteSha,
      headSha: originalHead,
    };
  }

  if (await executor.isAncestor(originalHead, remoteSha)) {
    const reset = await executor.exec(['reset', '--hard', remoteSha]);
    if (reset.exitCode !== 0 || reset.terminationReason !== undefined) {
      throw new WorktreeGitError(
        `git reset --hard failed: ${reset.stderr.trim() || reset.stdout.trim()}`,
        'git_failed',
        false
      );
    }
    const resetHead = await executor.head();
    await executor.writeLastKnownRemote(branch, remoteSha);
    const effective = await effectiveSyncBase(executor, resetHead, baseBranch, request.upstreamSha);
    return {
      status: 'changed',
      operation: 'sync',
      branch,
      ...effective,
      previousRemoteSha,
      remoteSha,
      headSha: resetHead,
    };
  }

  const rebaseBase = previousRemoteSha ?? (await executor.mergeBase(originalHead, remoteSha));
  if (rebaseBase === null) {
    return refused(
      'sync',
      branch,
      'missing_upstream_sha',
      'There is no common commit with the remote branch to rebase from',
      { previousRemoteSha, remoteSha, headSha: originalHead }
    );
  }
  if ((await executor.tryResolve(rebaseBase)) === null) {
    return refused(
      'sync',
      branch,
      'missing_upstream_sha',
      'The last known remote commit is no longer available',
      { previousRemoteSha, remoteSha, headSha: originalHead }
    );
  }

  const command = `git rebase --onto ${remoteSha} ${rebaseBase}`;
  const rebase = await executor.exec(['rebase', '--onto', remoteSha, rebaseBase]);
  if (rebase.exitCode !== 0 || rebase.terminationReason !== undefined) {
    const files = await executor.conflictedFiles();
    await abortRebase(executor, originalHead);
    const effective = await effectiveSyncBase(
      executor,
      originalHead,
      baseBranch,
      request.upstreamSha
    );
    return {
      status: 'conflict',
      operation: 'sync',
      branch,
      ...effective,
      previousRemoteSha,
      remoteSha,
      headSha: originalHead,
      files,
      command,
      instruction: [
        `Sync of ${branch} was aborted and the branch is unchanged at ${originalHead}.`,
        `Run \`${command}\`, resolve the conflicts in ${filesForInstruction(files)}, and run the tests.`,
        `Then push normally (no force push): \`git push origin ${shellArg(`HEAD:${branch}`)}\`.`,
      ].join(' '),
    };
  }

  const syncedHead = await executor.head();
  await executor.writeLastKnownRemote(branch, remoteSha);
  const effective = await effectiveSyncBase(executor, syncedHead, baseBranch, request.upstreamSha);
  return {
    status: 'changed',
    operation: 'sync',
    branch,
    ...effective,
    previousRemoteSha,
    remoteSha,
    headSha: syncedHead,
  };
}

export type RestackOptions = {
  expectedBranch?: string;
};

function leaseRejected(output: string): boolean {
  return /(?:stale info|\[rejected\]|\(fetch first\)|non-fast-forward)/i.test(output);
}

export async function runWorktreeRestack(
  executor: WorktreeGitExecutorInternal,
  request: { baseBranch?: string; upstreamSha?: string },
  options: RestackOptions = {}
): Promise<WorktreeBranchOperationResult> {
  const branch = await executor.currentBranch();
  if (branch === null) {
    return refused('restack', null, 'branch_mismatch', 'HEAD is detached', {
      headSha: (await executor.tryResolve('HEAD')) ?? '0'.repeat(40),
    });
  }
  const originalHead = await executor.head();
  if (options.expectedBranch !== undefined && options.expectedBranch !== branch) {
    return refused(
      'restack',
      branch,
      'branch_mismatch',
      `The worktree is on ${branch}, not ${options.expectedBranch}`,
      { headSha: originalHead }
    );
  }
  if (await executor.isDirty()) {
    return refused(
      'restack',
      branch,
      'dirty_worktree',
      'Commit or discard the worktree changes before restacking the branch',
      { headSha: originalHead }
    );
  }
  if (await executor.rebaseInProgress()) {
    return refused('restack', branch, 'rebase_in_progress', 'A rebase is already in progress', {
      headSha: originalHead,
    });
  }

  // Restack requires a complete fetch; any failure is a retryable error.
  await executor.fetchAll();
  const remoteSha = await executor.tryResolve(`refs/remotes/origin/${branch}`);
  if (remoteSha === null) {
    return refused(
      'restack',
      branch,
      'remote_branch_missing',
      `The remote branch origin/${branch} does not exist`,
      { headSha: originalHead }
    );
  }

  const previousDurable = await executor.resolveLastKnownRemote(branch);
  const unseen = await executor.exec(['rev-list', '--count', `HEAD..${remoteSha}`]);
  const unseenCount = unseen.exitCode === 0 ? Number(unseen.stdout.trim()) : Number.NaN;
  if (!Number.isSafeInteger(unseenCount) || unseenCount < 0) {
    throw new WorktreeGitError('Unable to compare the branch with origin');
  }
  if (unseenCount > 0) {
    // Bring in commits this worktree has not seen before ever force-pushing over
    // them. Sync is safe (no force push), and the caller must not claim the
    // branch was restacked onto the new base.
    const synced = await runWorktreeSync(
      executor,
      {
        ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch }),
        ...(request.upstreamSha === undefined ? {} : { upstreamSha: request.upstreamSha }),
      },
      options
    );
    return { ...synced, operation: 'sync' };
  }

  const baseBranch = request.baseBranch ?? (await executor.defaultRemoteBranch());
  if (baseBranch === null) {
    return refused(
      'restack',
      branch,
      'remote_branch_missing',
      'No base branch was provided and no default branch exists',
      { previousRemoteSha: previousDurable, remoteSha, headSha: originalHead }
    );
  }
  const newBaseRef = `refs/remotes/origin/${baseBranch}`;
  const newBaseSha = await executor.tryResolve(newBaseRef);
  if (newBaseSha === null) {
    return refused(
      'restack',
      branch,
      'remote_branch_missing',
      `The base branch origin/${baseBranch} does not exist`,
      { baseBranch, previousRemoteSha: previousDurable, remoteSha, headSha: originalHead }
    );
  }

  if (request.upstreamSha === undefined) {
    return refused(
      'restack',
      branch,
      'missing_upstream_sha',
      'Restack requires the parent commit to replay from',
      { baseBranch, previousRemoteSha: previousDurable, remoteSha, headSha: originalHead }
    );
  }
  const upstreamSha = await executor.tryResolve(request.upstreamSha);
  if (upstreamSha === null) {
    return refused(
      'restack',
      branch,
      'missing_upstream_sha',
      `The upstream commit ${request.upstreamSha} is not available`,
      { baseBranch, previousRemoteSha: previousDurable, remoteSha, headSha: originalHead }
    );
  }
  if (!(await executor.isAncestor(upstreamSha, originalHead))) {
    return refused(
      'restack',
      branch,
      'missing_upstream_sha',
      `The upstream commit ${upstreamSha} is not an ancestor of ${branch}`,
      { baseBranch, previousRemoteSha: previousDurable, remoteSha, headSha: originalHead }
    );
  }

  if (previousDurable === null) {
    // This worktree has seen all remote commits (`unseenCount` is 0), so the
    // current remote tip is a safe last-reconciled baseline.
    await executor.writeLastKnownRemote(branch, remoteSha);
  }

  const command = `git rebase --onto ${shellArg(`origin/${baseBranch}`)} ${upstreamSha}`;
  const rebase = await executor.exec(['rebase', '--onto', newBaseSha, upstreamSha]);
  if (rebase.exitCode !== 0 || rebase.terminationReason !== undefined) {
    const files = await executor.conflictedFiles();
    await abortRebase(executor, originalHead);
    return {
      status: 'conflict',
      operation: 'restack',
      branch,
      baseBranch,
      baseSha: newBaseSha,
      previousRemoteSha: previousDurable ?? remoteSha,
      remoteSha,
      headSha: originalHead,
      files,
      command,
      instruction: [
        `Restack of ${branch} was aborted and the branch is unchanged at ${originalHead}.`,
        `Run \`${command}\`, resolve the conflicts in ${filesForInstruction(files)}, and run the tests.`,
        `Then force-push with the lease: \`git push ${shellArg(`--force-with-lease=refs/heads/${branch}:${remoteSha}`)} origin ${shellArg(`HEAD:refs/heads/${branch}`)}\`.`,
      ].join(' '),
    };
  }

  const rebasedHead = await executor.head();
  if (rebasedHead === originalHead) {
    const currentBase = await executor.mergeBase(rebasedHead, newBaseSha);
    return {
      status: 'unchanged',
      operation: 'restack',
      branch,
      baseBranch,
      baseSha: currentBase,
      previousRemoteSha: previousDurable ?? remoteSha,
      remoteSha,
      headSha: originalHead,
    };
  }

  // The lease is the freshly fetched remote tip. It is only used after proving
  // above that origin/<branch> had no commits this worktree had not seen.
  const destination = `refs/heads/${branch}`;
  const push = await executor.exec(
    ['push', `--force-with-lease=${destination}:${remoteSha}`, 'origin', `HEAD:${destination}`],
    NETWORK_GIT_TIMEOUT_MS
  );
  if (push.exitCode !== 0 || push.terminationReason !== undefined) {
    const output = `${push.stderr}\n${push.stdout}`;
    const lease = leaseRejected(output);
    await rollbackAfterPushFailure(executor, originalHead, rebasedHead);
    if (lease) {
      return refused(
        'restack',
        branch,
        'lease_rejected',
        `The remote branch ${branch} changed while restacking; the local branch was restored`,
        {
          baseBranch,
          baseSha: newBaseSha,
          previousRemoteSha: previousDurable ?? remoteSha,
          remoteSha,
          headSha: originalHead,
        }
      );
    }
    throw new WorktreeGitError(
      `git push --force-with-lease failed: ${push.stderr.trim() || push.stdout.trim()}`,
      'git_network_failed',
      true
    );
  }

  await executor.writeLastKnownRemote(branch, rebasedHead);
  return {
    status: 'changed',
    operation: 'restack',
    branch,
    baseBranch,
    baseSha: newBaseSha,
    previousRemoteSha: previousDurable ?? remoteSha,
    remoteSha: rebasedHead,
    headSha: rebasedHead,
  };
}

export type ChangesRemoteRefresh = {
  /** The request to capture, with `baseRef` pointing at the branch actually compared. */
  request: { baseRef?: string };
  baseRefFallback?: { requested: string; used: string };
};

function remoteBranchFromRef(ref: string): string | null {
  if (ref.startsWith('refs/remotes/origin/')) {
    return ref.slice('refs/remotes/origin/'.length);
  }
  if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  return null;
}

/**
 * Refresh the base branch the Changes panel compares. A missing base branch
 * falls back to the default branch; other fetch failures are retryable errors.
 */
export async function refreshChangesRemotes(
  executor: WorktreeGitExecutorInternal,
  request: { baseRef?: string }
): Promise<ChangesRemoteRefresh> {
  if (request.baseRef === undefined) {
    return { request };
  }
  const baseBranch = remoteBranchFromRef(request.baseRef);
  if (baseBranch === null || baseBranch === 'HEAD') {
    return { request };
  }
  const base = await executor.fetchBranch(baseBranch);
  let effectiveBaseRef = request.baseRef;
  let baseRefFallback: ChangesRemoteRefresh['baseRefFallback'];
  if (base.kind === 'failed') {
    throw new WorktreeGitError(
      `git fetch origin ${baseBranch} failed: ${base.message}`,
      'git_network_failed',
      true
    );
  }
  if (base.kind === 'missing') {
    const fallback = await executor.defaultRemoteBranch();
    if (fallback === null) {
      throw new WorktreeGitError(
        `The base branch origin/${baseBranch} does not exist and there is no default branch`,
        'git_network_failed',
        true
      );
    }
    effectiveBaseRef = `refs/remotes/origin/${fallback}`;
    baseRefFallback = { requested: request.baseRef, used: effectiveBaseRef };
  }
  return {
    request: { ...request, baseRef: effectiveBaseRef },
    ...(baseRefFallback === undefined ? {} : { baseRefFallback }),
  };
}

/** Auto-commit's safe classification of a rejected push. */
export function pushFailureReason(output: string): 'remote_branch_changed' | null {
  return /(?:\[rejected\]|non-fast-forward|fetch first|updates were rejected|stale info)/i.test(
    output
  )
    ? 'remote_branch_changed'
    : null;
}
