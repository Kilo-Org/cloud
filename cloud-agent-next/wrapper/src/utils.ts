import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Spawn a git command with an argv array (no shell interpolation). */
export function git(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: opts?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              proc.kill('SIGTERM');
              resolve({ stdout, stderr: stderr + '\nexec timeout reached', exitCode: 124 });
            }
          }, opts.timeoutMs)
        : undefined;

    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));
    proc.on('exit', code => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      }
    });
    proc.on('error', err => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export async function getCurrentBranch(workspacePath: string, timeoutMs?: number): Promise<string> {
  try {
    const result = await git(['branch', '--show-current'], { cwd: workspacePath, timeoutMs });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

/** Check if the current branch has a remote tracking branch configured in git. */
export async function hasGitUpstream(workspacePath: string, timeoutMs?: number): Promise<boolean> {
  try {
    const result = await git(['rev-parse', '--abbrev-ref', '@{upstream}'], {
      cwd: workspacePath,
      timeoutMs,
    });
    return result.exitCode === 0 && result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Install process-level crash handlers (uncaughtException, unhandledRejection).
 * On crash: best-effort log upload (5s timeout), then process.exit(1).
 *
 * @param getUploader - Returns the current log uploader (may be null).
 * @param isShuttingDown - Returns true if a graceful shutdown is already in progress.
 * @param prefix - Log prefix for crash messages (e.g. '[supervisor]').
 */
export function installCrashHandlers(
  getUploader: () => { uploadNow: () => Promise<void>; stop: () => void } | null,
  isShuttingDown: () => boolean,
  prefix = ''
): void {
  function handleCrash(label: string, error: unknown): void {
    if (isShuttingDown()) return;

    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logToFile(`${prefix}${label}: ${message}`);
    console.error(`${prefix}${label}:`, error);

    const uploader = getUploader();
    if (uploader) {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, 5_000));
      void Promise.race([uploader.uploadNow().catch(() => {}), timeout]).finally(() => {
        uploader.stop();
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  }

  process.on('uncaughtException', err => handleCrash('uncaught exception', err));
  process.on('unhandledRejection', reason => handleCrash('unhandled rejection', reason));
}

export function logToFile(message: string): void {
  const logPath = process.env.WRAPPER_LOG_PATH || '/tmp/kilocode-wrapper.log';
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Ignore logging failures to avoid breaking the wrapper
  }
}
