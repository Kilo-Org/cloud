import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  terminationReason?: TerminationReason;
};

export type ProcessOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  terminationGraceMs?: number;
};

export type GitOptions = ProcessOptions;

export type TimeoutAbortOptions = {
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  abortMessage: string;
};

const EXEC_TIMEOUT_EXIT_CODE = 124;
const EXEC_TERMINATION_GRACE_MS = 2_000;
const EXEC_TIMEOUT_MESSAGE = 'exec timeout reached';
const EXEC_ABORTED_MESSAGE = 'exec aborted';

export type TerminationReason = 'timeout' | 'abort';

function withStderrSuffix(stderr: string, suffix: string): string {
  return `${stderr}${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}${suffix}`;
}

export function runProcess(
  command: string,
  args: string[],
  opts?: ProcessOptions
): Promise<ExecResult> {
  if (opts?.signal?.aborted) {
    return Promise.resolve({
      stdout: '',
      stderr: EXEC_ABORTED_MESSAGE,
      exitCode: EXEC_TIMEOUT_EXIT_CODE,
      terminationReason: 'abort',
    });
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: opts?.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationReason: TerminationReason | null = null;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    function abortHandler(): void {
      terminate('abort');
    }

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
    };

    const removeAbortHandler = () => {
      opts?.signal?.removeEventListener('abort', abortHandler);
    };

    const destroyPipes = (): void => {
      proc.stdout.destroy();
      proc.stderr.destroy();
    };

    const resolveTermination = (destroyOpenPipes = false): void => {
      const reason = terminationReason;
      if (settled || reason === null) return;
      settled = true;
      clearTimers();
      removeAbortHandler();
      if (destroyOpenPipes) destroyPipes();
      resolve({
        stdout,
        stderr: withStderrSuffix(
          stderr,
          reason === 'timeout' ? EXEC_TIMEOUT_MESSAGE : EXEC_ABORTED_MESSAGE
        ),
        exitCode: EXEC_TIMEOUT_EXIT_CODE,
        terminationReason: reason,
      });
    };

    const killProcess = (signal: NodeJS.Signals): void => {
      if (proc.pid === undefined) return;
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch {
        proc.kill(signal);
      }
    };

    const terminate = (reason: TerminationReason): void => {
      if (settled || terminationReason !== null) return;
      terminationReason = reason;
      if (timer) clearTimeout(timer);
      killProcess('SIGTERM');
      terminationTimer = setTimeout(() => {
        killProcess('SIGKILL');
        resolveTermination(true);
      }, opts?.terminationGraceMs ?? EXEC_TERMINATION_GRACE_MS);
    };

    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => terminate('timeout'), opts.timeoutMs)
        : undefined;

    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));

    if (opts?.signal) {
      if (opts.signal.aborted) {
        terminate('abort');
      } else {
        opts.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
    proc.on('close', code => {
      if (settled) return;
      if (terminationReason !== null) {
        resolveTermination();
        return;
      }
      settled = true;
      clearTimers();
      removeAbortHandler();
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    proc.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimers();
        removeAbortHandler();
        reject(err);
      }
    });
  });
}

/** Spawn a git command with an argv array (no shell interpolation). */
export function git(args: string[], opts?: GitOptions): Promise<ExecResult> {
  return runProcess('git', args, opts);
}

export async function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  opts: TimeoutAbortOptions
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(opts.timeoutMessage)), opts.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!opts.signal) return;
    abortHandler = () => reject(new Error(opts.abortMessage));
    if (opts.signal.aborted) {
      abortHandler();
      return;
    }
    opts.signal.addEventListener('abort', abortHandler, { once: true });
  });

  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (opts.signal && abortHandler) opts.signal.removeEventListener('abort', abortHandler);
  });
}

export async function getCurrentBranch(
  workspacePath: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<string> {
  let result: ExecResult;
  try {
    result = await git(['branch', '--show-current'], {
      cwd: workspacePath,
      timeoutMs,
      signal,
    });
  } catch {
    return '';
  }
  if (result.terminationReason === 'abort') {
    throw new Error('git branch aborted');
  }
  if (result.terminationReason === 'timeout') {
    throw new Error('git branch timed out');
  }
  return result.stdout.trim();
}

/** Check if the current branch has a remote tracking branch configured in git. */
export async function hasGitUpstream(
  workspacePath: string,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const result = await git(['rev-parse', '--abbrev-ref', '@{upstream}'], {
      cwd: workspacePath,
      timeoutMs,
      signal,
    });
    return result.exitCode === 0 && result.stdout.trim() !== '';
  } catch {
    return false;
  }
}

export function logToFile(message: string): void {
  const logPath = process.env.WRAPPER_LOG_PATH || '/tmp/kilocode-wrapper.log';
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Ignore logging failures to avoid breaking the wrapper
  }
}
