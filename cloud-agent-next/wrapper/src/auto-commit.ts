import type { IngestEvent } from '../../src/shared/protocol.js';
import type { KiloClient } from './kilo-client.js';
import { exec, getCurrentBranch, logToFile } from './utils.js';

/** Default timeout for auto-commit operation (5 minutes) */
const DEFAULT_AUTO_COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

export type AutoCommitResult = {
  /** Whether the operation was aborted (kill signal or fatal error during execution) */
  wasAborted: boolean;
  /** Whether the operation completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
};

export type AutoCommitOptions = {
  workspacePath: string;
  upstreamBranch?: string;
  model?: string;
  onEvent: (event: IngestEvent) => void;
  kiloClient: KiloClient;
  kiloSessionId: string;
  /** Arm the completion waiter before sending a prompt */
  expectCompletion: () => void;
  /** Wait for the completion event (call after sending prompt) */
  waitForCompletion: () => Promise<void>;
  /** Check if the execution was aborted (kill signal or fatal error) */
  wasAborted: () => boolean;
  /** Timeout for the entire operation in ms (default: 5 minutes) */
  timeoutMs?: number;
};

function buildAutoCommitPrompt(hasUpstream: boolean): string {
  const lines = [
    'Commit and push all uncommitted changes. Follow these guidelines:',
    '1. Create a clear, concise commit message summarizing the changes',
    '2. Stage all modified and new files (git add -A)',
    '3. If pre-commit hooks fail, retry with --no-verify',
    '4. Push to the current branch',
    '5. Do NOT force push',
    '6. If you detect secrets or credentials, decline to commit and explain why',
  ];
  if (!hasUpstream) {
    lines.push('7. Do NOT push to main or master branches - if on these branches, skip the push');
  }
  return lines.join('\n');
}

export async function runAutoCommit(opts: AutoCommitOptions): Promise<AutoCommitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTO_COMMIT_TIMEOUT_MS;
  const sendStatus = (msg: string) =>
    opts.onEvent({
      streamEventType: 'status',
      data: { message: msg },
      timestamp: new Date().toISOString(),
    });

  // Check if already aborted before starting
  if (opts.wasAborted()) {
    logToFile('auto-commit: skipped - execution was aborted');
    return { wasAborted: true, success: false };
  }

  try {
    // Check current branch
    const branch = await getCurrentBranch(opts.workspacePath);
    if (!branch) {
      sendStatus('Auto-commit skipped: detached HEAD state');
      return { wasAborted: false, success: true };
    }

    // Branch protection
    const hasUpstream = opts.upstreamBranch !== undefined && opts.upstreamBranch !== '';
    if (!hasUpstream && (branch === 'main' || branch === 'master')) {
      sendStatus(`Auto-commit skipped: cannot commit to ${branch}`);
      return { wasAborted: false, success: true };
    }

    // Check for changes
    const status = await exec(`cd "${opts.workspacePath}" && git status --porcelain`);
    if (!status.stdout.trim()) {
      sendStatus('No uncommitted changes');
      return { wasAborted: false, success: true };
    }

    // Check again before sending prompt
    if (opts.wasAborted()) {
      logToFile('auto-commit: aborted before sending prompt');
      return { wasAborted: true, success: false };
    }

    sendStatus('Auto-committing changes...');

    // Select prompt based on explicit upstream branch
    const prompt = buildAutoCommitPrompt(hasUpstream);

    // Arm the completion waiter BEFORE sending the prompt
    opts.expectCompletion();

    // Send prompt via server API
    logToFile(`auto-commit: sending prompt to session ${opts.kiloSessionId}`);
    await opts.kiloClient.sendPromptAsync({
      sessionId: opts.kiloSessionId,
      prompt,
      agent: 'build',
      model: opts.model ? { modelID: opts.model } : undefined,
    });

    // Wait for completion with timeout
    logToFile('auto-commit: waiting for completion');
    const completionPromise = opts.waitForCompletion();
    const timeoutPromise = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), timeoutMs)
    );

    const result = await Promise.race([
      completionPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      logToFile('auto-commit: timed out, aborting session');
      // Abort the session to stop the running prompt
      try {
        await opts.kiloClient.abortSession({ sessionId: opts.kiloSessionId });
        logToFile('auto-commit: session aborted after timeout');
      } catch (abortError) {
        logToFile(
          `auto-commit: failed to abort session: ${abortError instanceof Error ? abortError.message : String(abortError)}`
        );
      }
      opts.onEvent({
        streamEventType: 'error',
        data: { error: 'Auto-commit timed out', fatal: false },
        timestamp: new Date().toISOString(),
      });
      // Treat timeout as abort to prevent further operations on potentially inconsistent state
      return { wasAborted: true, success: false, error: 'Timed out' };
    }

    // Check if aborted during execution
    if (opts.wasAborted()) {
      logToFile('auto-commit: aborted during execution');
      return { wasAborted: true, success: false };
    }

    logToFile('auto-commit: completed');
    sendStatus('Auto-commit completed');
    return { wasAborted: false, success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logToFile(`auto-commit: error - ${errorMsg}`);
    opts.onEvent({
      streamEventType: 'error',
      data: {
        error: `Auto-commit failed: ${errorMsg}`,
        fatal: false,
      },
      timestamp: new Date().toISOString(),
    });
    return { wasAborted: false, success: false, error: errorMsg };
  }
}
