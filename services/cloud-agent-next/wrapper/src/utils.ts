import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

export type BoundedProcessOutput = {
  preview: string;
  totalBytes: number;
  retainedBytes: number;
  truncated: boolean;
};

type BoundedProcessResult = {
  stdout: BoundedProcessOutput;
  stderr: BoundedProcessOutput;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  terminationReason?: TerminationReason;
  boundedOutput?: BoundedProcessResult;
};

export type ProcessOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  terminationGraceMs?: number;
  maxCapturedOutputBytes?: number;
  maxObservedOutputBytes?: number;
};

type BoundedProcessOptions = ProcessOptions & {
  maxCapturedOutputBytes: number;
};

type BoundedExecResult = ExecResult & {
  boundedOutput: BoundedProcessResult;
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
const EXEC_TERMINATION_POLL_MS = 25;
const EXEC_TIMEOUT_MESSAGE = 'exec timeout reached';
const EXEC_ABORTED_MESSAGE = 'exec aborted';
const EXEC_OUTPUT_LIMIT_MESSAGE = 'exec output limit reached';

export type TerminationReason = 'timeout' | 'abort' | 'excessive-output';

function withStderrSuffix(stderr: string, suffix: string): string {
  return `${stderr}${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}${suffix}`;
}

function createBoundedOutputCollector(maxBytes: number): {
  observe: (chunk: Buffer) => void;
  value: () => BoundedProcessOutput;
} {
  let retained = Buffer.alloc(0);
  let totalBytes = 0;
  let truncated = false;

  return {
    observe: chunk => {
      totalBytes += chunk.byteLength;
      if (truncated) return;
      if (totalBytes > maxBytes) {
        retained = Buffer.alloc(0);
        truncated = true;
        return;
      }
      retained = Buffer.concat([retained, chunk]);
    },
    value: () => ({
      preview: retained.toString('utf8'),
      totalBytes,
      retainedBytes: retained.byteLength,
      truncated,
    }),
  };
}

export function runProcess(
  command: string,
  args: string[],
  opts: BoundedProcessOptions
): Promise<BoundedExecResult>;
export function runProcess(
  command: string,
  args: string[],
  opts?: ProcessOptions
): Promise<ExecResult>;
export function runProcess(
  command: string,
  args: string[],
  opts?: ProcessOptions
): Promise<ExecResult> {
  const stdoutCollector =
    opts?.maxCapturedOutputBytes === undefined
      ? undefined
      : createBoundedOutputCollector(opts.maxCapturedOutputBytes);
  const stderrCollector =
    opts?.maxCapturedOutputBytes === undefined
      ? undefined
      : createBoundedOutputCollector(opts.maxCapturedOutputBytes);
  const createResult = (
    stdout: string,
    stderr: string,
    exitCode: number,
    terminationReason?: TerminationReason,
    stderrSuffix?: string
  ): ExecResult => {
    const boundedOutput =
      stdoutCollector && stderrCollector
        ? { stdout: stdoutCollector.value(), stderr: stderrCollector.value() }
        : undefined;
    const resultStderr = boundedOutput?.stderr.preview ?? stderr;
    const result: ExecResult = {
      stdout: boundedOutput?.stdout.preview ?? stdout,
      stderr: stderrSuffix ? withStderrSuffix(resultStderr, stderrSuffix) : resultStderr,
      exitCode,
    };
    if (terminationReason) result.terminationReason = terminationReason;
    if (boundedOutput) result.boundedOutput = boundedOutput;
    return result;
  };

  if (opts?.signal?.aborted) {
    return Promise.resolve(
      createResult('', '', EXEC_TIMEOUT_EXIT_CODE, 'abort', EXEC_ABORTED_MESSAGE)
    );
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
    let terminationPollTimer: ReturnType<typeof setTimeout> | undefined;
    let observedOutputBytes = 0;

    function abortHandler(): void {
      terminate('abort');
    }

    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (terminationPollTimer) clearTimeout(terminationPollTimer);
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
      const message =
        reason === 'timeout'
          ? EXEC_TIMEOUT_MESSAGE
          : reason === 'abort'
            ? EXEC_ABORTED_MESSAGE
            : EXEC_OUTPUT_LIMIT_MESSAGE;
      resolve(createResult(stdout, stderr, EXEC_TIMEOUT_EXIT_CODE, reason, message));
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

    const processGroupExists = (): boolean => {
      if (proc.pid === undefined) return false;
      try {
        process.kill(-proc.pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const waitForTerminatedGroup = (): void => {
      if (settled || terminationReason === null) return;
      if (!processGroupExists()) {
        resolveTermination();
        return;
      }
      terminationPollTimer = setTimeout(waitForTerminatedGroup, EXEC_TERMINATION_POLL_MS);
    };

    const terminate = (reason: TerminationReason): void => {
      if (settled || terminationReason !== null) return;
      terminationReason = reason;
      if (timer) clearTimeout(timer);
      killProcess('SIGTERM');
      const terminationGraceMs =
        reason === 'excessive-output' ? 0 : (opts?.terminationGraceMs ?? EXEC_TERMINATION_GRACE_MS);
      terminationTimer = setTimeout(() => {
        killProcess('SIGKILL');
        resolveTermination(true);
      }, terminationGraceMs);
    };

    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => terminate('timeout'), opts.timeoutMs)
        : undefined;

    const observeOutput = (chunk: Buffer): void => {
      observedOutputBytes += chunk.byteLength;
      if (
        opts?.maxObservedOutputBytes !== undefined &&
        observedOutputBytes > opts.maxObservedOutputBytes
      ) {
        terminate('excessive-output');
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutCollector?.observe(chunk);
      if (!stdoutCollector) stdout += chunk.toString('utf8');
      observeOutput(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrCollector?.observe(chunk);
      if (!stderrCollector) stderr += chunk.toString('utf8');
      observeOutput(chunk);
    });

    if (opts?.signal) {
      if (opts.signal.aborted) {
        terminate('abort');
      } else {
        opts.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
    proc.on('close', (code, signal) => {
      if (settled) return;
      if (terminationReason !== null) {
        waitForTerminatedGroup();
        return;
      }
      settled = true;
      clearTimers();
      removeAbortHandler();
      resolve(createResult(stdout, stderr, code ?? (signal === null ? 0 : 1)));
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
