import { randomUUID } from 'node:crypto';
import type { IngestEvent } from '../../src/shared/protocol.js';
import { FULL_COMMIT_HASH, immutableGit, readCommitObject } from './commit-objects.js';
import type { WrapperCommitCoAuthor } from '../../src/shared/wrapper-bootstrap.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { git, getCurrentBranch, hasGitUpstream, logToFile as writeLog } from './utils.js';
import { createSecretRedactor } from './redact-output.js';

/** Timeout for local git operations (status, add, commit) */
const GIT_LOCAL_TIMEOUT_MS = 30_000;
/** Timeout for git push (network-bound) */
const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Timeout for commit message generation API call */
const COMMIT_MESSAGE_TIMEOUT_MS = 30_000;
const worktreeAutoCommits = new Map<string, Promise<void>>();
const COMMIT_EVIDENCE_TIMEOUT_MS = 5_000;

type CommitEvidence = {
  commitHash: string;
  commitMessage?: string;
  committedAt?: string;
  commitMessageTruncated?: true;
};
type PushStatus = 'failed' | 'not_attempted' | 'unknown';

function appendCommitCoAuthor(
  commitMessage: string,
  commitCoAuthor: WrapperCommitCoAuthor | undefined
): string {
  if (!commitCoAuthor) return commitMessage;
  if (
    /[\r\n<>]/.test(commitCoAuthor.name) ||
    /[\r\n<>]/.test(commitCoAuthor.email) ||
    commitCoAuthor.email.trim() !== commitCoAuthor.email
  ) {
    writeLog('auto-commit: ignoring invalid commit co-author identity');
    return commitMessage;
  }
  const trailer = `Co-authored-by: ${commitCoAuthor.name} <${commitCoAuthor.email}>`;
  if (commitMessage.includes(trailer)) return commitMessage;
  return `${commitMessage.trimEnd()}\n\n${trailer}`;
}

export type AutoCommitResult = {
  success: boolean;
  skipped?: boolean;
  error?: string;
};

export type AutoCommitOptions = {
  workspacePath: string;
  onEvent: (event: IngestEvent) => void;
  kiloClient: WrapperKiloClient;
  /** The assistant message ID this autocommit is associated with (for per-message UI rendering) */
  messageId?: string;
  userMessageId?: string;
  /** If the user explicitly provided an upstream branch via API, pass it here to allow
   *  committing to that branch even if it is main/master. Protection is only bypassed
   *  when the current branch matches this value exactly. */
  upstreamBranch?: string;
  commitCoAuthor?: WrapperCommitCoAuthor;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

function emitStarted(
  onEvent: AutoCommitOptions['onEvent'],
  message: string,
  messageId?: string
): void {
  onEvent({
    streamEventType: 'autocommit_started',
    data: { message, messageId },
    timestamp: new Date().toISOString(),
  });
}

function emitCompleted(
  onEvent: AutoCommitOptions['onEvent'],
  result: {
    success: boolean;
    message: string;
    skipped?: boolean;
    commitHash?: string;
    commitMessage?: string;
    committedAt?: string;
    userMessageId?: string;
    pushStatus?: PushStatus;
    commitMessageTruncated?: true;
  },
  messageId?: string
): void {
  onEvent({
    streamEventType: 'autocommit_completed',
    data: { ...result, messageId },
    timestamp: new Date().toISOString(),
  });
}

export async function runAutoCommit(opts: AutoCommitOptions): Promise<AutoCommitResult> {
  const { workspacePath, onEvent, kiloClient, messageId, userMessageId, signal, env } = opts;
  let locallyCommitted = false;
  let evidence: CommitEvidence | undefined;
  let pushStatus: PushStatus = 'not_attempted';
  const redact = createSecretRedactor(process.env, env ?? {});
  const logToFile = (message: string): void => writeLog(redact(message));
  const released = Promise.withResolvers<void>();
  const previous = worktreeAutoCommits.get(workspacePath) ?? Promise.resolve();
  const current = previous
    .then(() => released.promise)
    .finally(() => {
      if (worktreeAutoCommits.get(workspacePath) === current)
        worktreeAutoCommits.delete(workspacePath);
    });
  worktreeAutoCommits.set(workspacePath, current);

  logToFile(`auto-commit: starting workspacePath=${workspacePath}`);

  async function commit(args: string[]) {
    const action = `kilo-autocommit-${randomUUID()}`;
    try {
      const result = await git(args, {
        cwd: workspacePath,
        env: { ...(env ?? process.env), GIT_REFLOG_ACTION: action },
        inheritEnv: false,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
        signal,
      });
      locallyCommitted ||= result.exitCode === 0;
      return result;
    } finally {
      await captureEvidence(action);
    }
  }

  async function captureEvidence(action: string): Promise<void> {
    const deadline = Date.now() + COMMIT_EVIDENCE_TIMEOUT_MS;
    try {
      const result = await immutableGit(
        workspacePath,
        [
          'reflog',
          'show',
          '--format=%H',
          `--grep-reflog=^${action}: `,
          '--max-count=2',
          'HEAD',
          '--',
        ],
        { timeoutMs: COMMIT_EVIDENCE_TIMEOUT_MS, maxOutputBytes: 256 }
      );
      const hashes = result.stdoutBytes?.toString('utf8').trim().split('\n');
      if (
        result.exitCode !== 0 ||
        result.terminationReason ||
        result.stdoutTruncated ||
        hashes?.length !== 1 ||
        !FULL_COMMIT_HASH.test(hashes[0])
      )
        return;
      evidence = { commitHash: hashes[0] };
      locallyCommitted = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const metadata = await readCommitObject(workspacePath, evidence.commitHash, {
        timeoutMs: remaining,
      });
      evidence = {
        ...evidence,
        commitMessage: metadata.commitMessage,
        committedAt: metadata.committedAt,
        ...(metadata.commitMessageTruncated ? { commitMessageTruncated: true } : {}),
      };
    } catch {
      logToFile('auto-commit: commit metadata unavailable');
    }
  }

  function completeLocalCommit(message: string): AutoCommitResult {
    emitCompleted(
      onEvent,
      { success: true, message, ...evidence, userMessageId, pushStatus },
      messageId
    );
    return { success: true };
  }

  try {
    signal?.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([previous, cancelled.promise]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.throwIfAborted();
    // Check current branch (agent may have switched branches during execution)
    const branch = await getCurrentBranch(workspacePath, GIT_LOCAL_TIMEOUT_MS, signal, env);
    logToFile(`auto-commit: branch=${branch || '(detached HEAD)'}`);
    if (!branch) {
      logToFile('auto-commit: skipping - detached HEAD state');
      emitCompleted(
        onEvent,
        {
          success: true,
          message: 'Skipped: detached HEAD state',
          skipped: true,
        },
        messageId
      );
      return { success: true, skipped: true };
    }

    // Branch protection: block auto-commit to main/master unless the user
    // explicitly targeted this exact branch via the upstreamBranch API param.
    if (branch === 'main' || branch === 'master') {
      if (opts.upstreamBranch !== branch) {
        logToFile(`auto-commit: skipping - protected branch ${branch}`);
        emitCompleted(
          onEvent,
          {
            success: true,
            message: `Skipped: cannot commit to ${branch}`,
            skipped: true,
          },
          messageId
        );
        return { success: true, skipped: true };
      }
      logToFile(
        `auto-commit: allowing commit to ${branch} (explicit upstreamBranch=${opts.upstreamBranch})`
      );
    }

    // Check actual git upstream (not stale config) to decide push strategy
    const trackingUpstream = await hasGitUpstream(workspacePath, GIT_LOCAL_TIMEOUT_MS, signal, env);
    logToFile(`auto-commit: hasGitUpstream=${trackingUpstream}`);

    // Check for uncommitted changes
    const status = await git(['status', '--porcelain'], {
      cwd: workspacePath,
      ...(env ? { env, inheritEnv: false } : {}),
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      signal,
    });
    if (status.terminationReason === 'abort') {
      const msg = 'git status aborted';
      logToFile(`auto-commit: ${msg} (exit 124)`);
      emitCompleted(onEvent, { success: false, message: msg }, messageId);
      return { success: false, error: msg };
    }
    if (status.exitCode === 124) {
      const msg = 'git status timed out';
      logToFile(`auto-commit: ${msg} (exit 124)`);
      emitCompleted(onEvent, { success: false, message: msg }, messageId);
      return { success: false, error: msg };
    }
    logToFile(`auto-commit: git status exitCode=${status.exitCode}`);
    if (!status.stdout.trim()) {
      logToFile('auto-commit: skipping - no uncommitted changes');
      emitCompleted(
        onEvent,
        { success: true, message: 'No uncommitted changes', skipped: true },
        messageId
      );
      return { success: true, skipped: true };
    }

    emitStarted(onEvent, 'Generating commit message...', messageId);

    // Generate commit message via kilo server API, falling back to a generic message on failure
    logToFile('auto-commit: generating commit message');
    const generationController = new AbortController();
    const generationTimeout = setTimeout(
      () => generationController.abort(new Error('Commit message generation timed out')),
      COMMIT_MESSAGE_TIMEOUT_MS
    );
    let commitMessage: string;
    try {
      const result = await kiloClient.generateCommitMessage({
        path: workspacePath,
        signal: signal
          ? AbortSignal.any([signal, generationController.signal])
          : generationController.signal,
      });
      commitMessage = result.message.trim() || 'wip';
      logToFile(`auto-commit: generated commit message: ${commitMessage}`);
    } catch (err) {
      signal?.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      logToFile(`auto-commit: commit message generation failed, using fallback: ${msg}`);
      commitMessage = 'wip';
    } finally {
      clearTimeout(generationTimeout);
    }
    signal?.throwIfAborted();
    commitMessage = appendCommitCoAuthor(commitMessage, opts.commitCoAuthor);

    emitStarted(onEvent, 'Committing changes...', messageId);

    // Stage all changes
    logToFile('auto-commit: staging changes');
    const addResult = await git(['add', '-A'], {
      cwd: workspacePath,
      ...(env ? { env, inheritEnv: false } : {}),
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      signal,
    });
    if (addResult.exitCode !== 0) {
      const msg = `git add failed: ${redact(addResult.stderr.trim())}`;
      logToFile(`auto-commit: ${msg}`);
      emitCompleted(onEvent, { success: false, message: msg }, messageId);
      return { success: false, error: msg };
    }

    // Commit — retry with --no-verify if pre-commit hook fails
    logToFile('auto-commit: committing');
    let commitResult = await commit(['commit', '-m', commitMessage]);
    if (!locallyCommitted) {
      logToFile('auto-commit: commit failed, retrying with --no-verify');
      commitResult = await commit(['commit', '--no-verify', '-m', commitMessage]);
      if (!locallyCommitted) {
        const msg = `git commit failed: ${redact(commitResult.stderr.trim())}`;
        logToFile(`auto-commit: ${msg}`);
        emitCompleted(onEvent, { success: false, message: msg }, messageId);
        return { success: false, error: msg };
      }
    }
    logToFile(`auto-commit: commit succeeded: ${commitResult.stdout.trim()}`);

    if (signal?.aborted || commitResult.terminationReason) {
      return completeLocalCommit('Changes committed (push not attempted)');
    }

    // Push
    const pushArgs = trackingUpstream ? ['push'] : ['push', '-u', 'origin', branch];
    logToFile(`auto-commit: pushing with args: git ${pushArgs.join(' ')}`);

    pushStatus = 'unknown';
    const pushResult = await git(pushArgs, {
      cwd: workspacePath,
      ...(env ? { env, inheritEnv: false } : {}),
      timeoutMs: GIT_PUSH_TIMEOUT_MS,
      signal,
    });
    if (pushResult.exitCode !== 0) {
      // Push failure is non-fatal — changes are committed locally
      const sanitizedPushError = redact(pushResult.stderr.trim());
      const msg = `git push failed: ${sanitizedPushError}`;
      logToFile(`auto-commit: ${msg}`);
      pushStatus =
        pushResult.terminationReason || pushResult.exitCode === 124 ? 'unknown' : 'failed';
      return completeLocalCommit(`Changes committed (push failed: ${sanitizedPushError})`);
    }

    logToFile('auto-commit: push command completed');
    logToFile('auto-commit: completed successfully');
    return completeLocalCommit('Changes committed; push command completed');
  } catch (error) {
    const errorMsg = redact(error instanceof Error ? error.message : String(error));
    logToFile(`auto-commit: error - ${errorMsg}`);
    if (locallyCommitted) return completeLocalCommit(`Changes committed (${errorMsg})`);
    emitCompleted(
      onEvent,
      { success: false, message: `Auto-commit failed: ${errorMsg}` },
      messageId
    );
    return { success: false, error: errorMsg };
  } finally {
    released.resolve();
  }
}
