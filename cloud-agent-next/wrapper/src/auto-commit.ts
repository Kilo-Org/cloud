import type { IngestEvent } from '../../src/shared/protocol.js';
import type { KiloClient } from './kilo-client.js';
import { git, getCurrentBranch, logToFile } from './utils.js';

/** Timeout for local git operations (status, add, commit) */
const GIT_LOCAL_TIMEOUT_MS = 30_000;
/** Timeout for git push (network-bound) */
const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Timeout for commit message generation API call */
const COMMIT_MESSAGE_TIMEOUT_MS = 60_000;

export type AutoCommitResult = {
  success: boolean;
  skipped?: boolean;
  error?: string;
};

export type AutoCommitOptions = {
  workspacePath: string;
  upstreamBranch?: string;
  onEvent: (event: IngestEvent) => void;
  kiloClient: KiloClient;
};

function emitStarted(onEvent: AutoCommitOptions['onEvent'], message: string): void {
  onEvent({
    streamEventType: 'autocommit_started',
    data: { message },
    timestamp: new Date().toISOString(),
  });
}

function emitCompleted(
  onEvent: AutoCommitOptions['onEvent'],
  result: { success: boolean; message: string; skipped?: boolean }
): void {
  onEvent({
    streamEventType: 'autocommit_completed',
    data: result,
    timestamp: new Date().toISOString(),
  });
}

export async function runAutoCommit(opts: AutoCommitOptions): Promise<AutoCommitResult> {
  const { workspacePath, upstreamBranch, onEvent, kiloClient } = opts;

  logToFile(
    `auto-commit: starting workspacePath=${workspacePath} upstreamBranch=${upstreamBranch ?? '(none)'}`
  );

  try {
    // Check current branch
    const branch = await getCurrentBranch(workspacePath);
    logToFile(`auto-commit: branch=${branch || '(detached HEAD)'}`);
    if (!branch) {
      logToFile('auto-commit: skipping - detached HEAD state');
      emitCompleted(onEvent, {
        success: true,
        message: 'Skipped: detached HEAD state',
        skipped: true,
      });
      return { success: true, skipped: true };
    }

    // Branch protection: don't commit to main/master without an explicit upstream
    const hasUpstream = upstreamBranch !== undefined && upstreamBranch !== '';
    if (!hasUpstream && (branch === 'main' || branch === 'master')) {
      logToFile(`auto-commit: skipping - protected branch ${branch} with no upstream`);
      emitCompleted(onEvent, {
        success: true,
        message: `Skipped: cannot commit to ${branch}`,
        skipped: true,
      });
      return { success: true, skipped: true };
    }

    // Check for uncommitted changes
    const status = await git(['status', '--porcelain'], {
      cwd: workspacePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (status.exitCode === 124) {
      const msg = 'git status timed out';
      logToFile(`auto-commit: ${msg} (exit 124)`);
      emitCompleted(onEvent, { success: false, message: msg });
      return { success: false, error: msg };
    }
    logToFile(`auto-commit: git status exitCode=${status.exitCode}`);
    if (!status.stdout.trim()) {
      logToFile('auto-commit: skipping - no uncommitted changes');
      emitCompleted(onEvent, { success: true, message: 'No uncommitted changes', skipped: true });
      return { success: true, skipped: true };
    }

    emitStarted(onEvent, 'Committing changes...');

    // Generate commit message via kilo server API
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
      commitMessage = result.message;
      logToFile(`auto-commit: generated commit message: ${commitMessage}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToFile(`auto-commit: commit message generation failed: ${msg}`);
      emitCompleted(onEvent, {
        success: false,
        message: `Failed to generate commit message: ${msg}`,
      });
      return { success: false, error: msg };
    }

    // Stage all changes
    logToFile('auto-commit: staging changes');
    const addResult = await git(['add', '-A'], {
      cwd: workspacePath,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (addResult.exitCode !== 0) {
      const msg = `git add failed: ${addResult.stderr.trim()}`;
      logToFile(`auto-commit: ${msg}`);
      emitCompleted(onEvent, { success: false, message: msg });
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
        emitCompleted(onEvent, { success: false, message: msg });
        return { success: false, error: msg };
      }
    }
    logToFile(`auto-commit: commit succeeded: ${commitResult.stdout.trim()}`);

    // Push
    const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
    logToFile(`auto-commit: pushing with args: git ${pushArgs.join(' ')}`);

    const pushResult = await git(pushArgs, { cwd: workspacePath, timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (pushResult.exitCode !== 0) {
      // Push failure is non-fatal — changes are committed locally
      const msg = `git push failed: ${pushResult.stderr.trim()}`;
      logToFile(`auto-commit: ${msg}`);
      emitCompleted(onEvent, {
        success: true,
        message: `Changes committed (push failed: ${pushResult.stderr.trim()})`,
      });
      return { success: true };
    }

    logToFile('auto-commit: push succeeded');
    logToFile('auto-commit: completed successfully');
    emitCompleted(onEvent, { success: true, message: 'Changes committed and pushed' });
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logToFile(`auto-commit: error - ${errorMsg}`);
    emitCompleted(onEvent, { success: false, message: `Auto-commit failed: ${errorMsg}` });
    return { success: false, error: errorMsg };
  }
}
