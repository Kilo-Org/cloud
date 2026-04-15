import type { ExecResult, ExecOptions } from '@cloudflare/sandbox';
import { logger, type CloudAgentTags } from './logger.js';

/** Timeout for lightweight sandbox commands (mkdir, stat, git config, etc.) */
export const FAST_SANDBOX_COMMAND_TIMEOUT_MS = 30_000;

/** Timeout for git network operations (fetch, pull, push). */
export const GIT_COMMAND_TIMEOUT_MS = 120_000;

/** Timeout for git clone via SDK. */
export const GIT_CLONE_TIMEOUT_MS = 2 * 60 * 1000;

/** Timeout for disk-space checks. */
export const DISK_CHECK_TIMEOUT_MS = 10_000;

export type SandboxOperationTimeoutLayer = 'sdk' | 'outer' | 'exec';

export type SandboxOperationTimeoutLogContext = {
  operation: string;
  timeoutMs: number;
  timeoutLayer: SandboxOperationTimeoutLayer;
  tags?: CloudAgentTags;
};

const SANDBOX_TIMEOUT_LOG_TAG = 'sandbox-operation-timeout';
const SANDBOX_TIMEOUT_LOG_MESSAGE = 'Sandbox operation timed out';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isSandboxOperationTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const msg = error.message;
  if (msg.includes('Operation was aborted')) return false;
  return (
    msg.includes('timeout') || msg.includes('timed out') || msg.includes('did not become ready')
  );
}

export function logSandboxOperationTimeout(
  context: SandboxOperationTimeoutLogContext,
  error?: unknown
): void {
  logger
    .withTags({ logTag: SANDBOX_TIMEOUT_LOG_TAG, ...context.tags })
    .withFields({
      operation: context.operation,
      timeoutMs: context.timeoutMs,
      timeoutLayer: context.timeoutLayer,
      ...(error !== undefined && { error: getErrorMessage(error) }),
    })
    .warn(SANDBOX_TIMEOUT_LOG_MESSAGE);
}

export async function withSandboxOperationTimeoutLog<T>(
  operation: Promise<T>,
  context: SandboxOperationTimeoutLogContext
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (isSandboxOperationTimeoutError(error)) {
      logSandboxOperationTimeout(context, error);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// timedExec – single-line wrapper that adds a timeout to exec + logs on timeout
// ---------------------------------------------------------------------------

type Executable = {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
};

/**
 * Run a command with an explicit timeout and structured timeout logging.
 * Defaults to {@link FAST_SANDBOX_COMMAND_TIMEOUT_MS} when `timeoutMs` is omitted.
 */
export function timedExec(
  executor: Executable,
  command: string,
  operation: string,
  options?: {
    timeoutMs?: number;
    cwd?: string;
  }
): Promise<ExecResult> {
  const timeoutMs = options?.timeoutMs ?? FAST_SANDBOX_COMMAND_TIMEOUT_MS;
  return withSandboxOperationTimeoutLog(
    executor.exec(command, {
      timeout: timeoutMs,
      ...(options?.cwd !== undefined && { cwd: options.cwd }),
    }),
    { operation, timeoutMs, timeoutLayer: 'exec' }
  );
}
