import type { IngestEvent } from '../../src/shared/protocol.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { git, getCurrentBranch, hasGitUpstream, logToFile } from './utils.js';

/** Timeout for local git operations (status, add, commit) */
const GIT_LOCAL_TIMEOUT_MS = 30_000;
/** Timeout for git push (network-bound) */
const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Timeout for commit message generation API call */
const COMMIT_MESSAGE_TIMEOUT_MS = 30_000;

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
  /** If the user explicitly provided an upstream branch via API, pass it here to allow
   *  committing to that branch even if it is main/master. Protection is only bypassed
   *  when the current branch matches this value exactly. */
  upstreamBranch?: string;
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
  const { workspacePath, onEvent, kiloClient, messageId } = opts;

  logToFile(`auto-commit: starting workspacePath=${workspacePath}`);

  try {
    // Check current branch (agent may have switched branches during execution)
    const branch = await getCurrentBranch(workspacePath, GIT_LOCAL_TIMEOUT_MS);
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
    const trackingUpstream = await hasGitUpstream(workspacePath, GIT_LOCAL_TIMEOUT_MS);
    logToFile(`auto-commit: hasGitUpstream=${trackingUpstream}`);

    // Check for uncommitted changes
    const status = await git(['status', '--porcelain'], {
      cwd: workspacePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
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
    let commitMessage: string;
    try {
      const commitMsgPromise = kiloClient.generateCommitMessage({ path: workspacePath });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Commit message generation timed out')),
          COMMIT_MESSAGE_TIMEOUT_MS
        )
      );
      const result = await Promise.race([commitMsgPromise, timeoutPromise]);
      commitMessage = result.message.trim() || 'wip';
      logToFile(`auto-commit: generated commit message: ${commitMessage}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToFile(`auto-commit: commit message generation failed, using fallback: ${msg}`);
      commitMessage = 'wip';
    }

    emitStarted(onEvent, 'Committing changes...', messageId);

    // Stage all changes
    logToFile('auto-commit: staging changes');
    const addResult = await git(['add', '-A'], {
      cwd: workspacePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (addResult.exitCode !== 0) {
      const msg = `git add failed: ${addResult.stderr.trim()}`;
      logToFile(`auto-commit: ${msg}`);
      emitCompleted(onEvent, { success: false, message: msg }, messageId);
      return { success: false, error: msg };
    }

    // Commit — retry with --no-verify if pre-commit hook fails
    logToFile('auto-commit: committing');
    let commitResult = await git(['commit', '-m', commitMessage], {
      cwd: workspacePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (commitResult.exitCode !== 0) {
      logToFile('auto-commit: commit failed, retrying with --no-verify');
      commitResult = await git(['commit', '--no-verify', '-m', commitMessage], {
        cwd: workspacePath,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (commitResult.exitCode !== 0) {
        const msg = `git commit failed: ${commitResult.stderr.trim()}`;
        logToFile(`auto-commit: ${msg}`);
        emitCompleted(onEvent, { success: false, message: msg }, messageId);
        return { success: false, error: msg };
      }
    }
    logToFile(`auto-commit: commit succeeded: ${commitResult.stdout.trim()}`);

    // Get commit hash for UI display
    let commitHash: string | undefined;
    try {
      const hashResult = await git(['rev-parse', '--short', 'HEAD'], {
        cwd: workspacePath,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (hashResult.exitCode === 0 && hashResult.stdout.trim()) {
        commitHash = hashResult.stdout.trim();
        logToFile(`auto-commit: commit hash=${commitHash}`);
      }
    } catch {
      logToFile('auto-commit: failed to get commit hash, continuing without it');
    }

    // Push
    const pushArgs = trackingUpstream ? ['push'] : ['push', '-u', 'origin', branch];
    logToFile(`auto-commit: pushing with args: git ${pushArgs.join(' ')}`);

    const pushResult = await git(pushArgs, { cwd: workspacePath, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (pushResult.exitCode !== 0) {
      // Push failure is non-fatal — changes are committed locally
      const msg = `git push failed: ${pushResult.stderr.trim()}`;
      logToFile(`auto-commit: ${msg}`);
      emitCompleted(
        onEvent,
        {
          success: true,
          message: `Changes committed (push failed: ${pushResult.stderr.trim()})`,
          commitHash,
          commitMessage,
        },
        messageId
      );
      return { success: true };
    }

    logToFile('auto-commit: push succeeded');
    logToFile('auto-commit: completed successfully');
    emitCompleted(
      onEvent,
      {
        success: true,
        message: 'Changes committed and pushed',
        commitHash,
        commitMessage,
      },
      messageId
    );
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logToFile(`auto-commit: error - ${errorMsg}`);
    emitCompleted(
      onEvent,
      { success: false, message: `Auto-commit failed: ${errorMsg}` },
      messageId
    );
    return { success: false, error: errorMsg };
  }
}
